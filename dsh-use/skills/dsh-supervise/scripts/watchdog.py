#!/usr/bin/env python3
"""dsh-supervise 兜底检查：长工卡死、主机/会话断连、检查器自身出错时通知主控。

长工停下（做完、到段上限、卡住、提问、失败）由派单时登记的做完通知负责，
长工主动汇报由它自己发通知；这里补这两条都覆盖不到的四件事：

- 卡死：会话在跑、有排队、目标开着且会自动续跑（active 且 armed）或名下有后台任务，
  但记录序号很久没变。
- 断连：SSH 或远端 DSH 连不上，或者某个长工的状态查不了。同一次中断只在开始、
  超过 --outage-minutes 仍未恢复、恢复这三个时刻各发一次 notice；其余每轮只写
  stderr 日志，不重复叫醒主控。
- 恢复：发一次 notice，请主控补查中断期间没看到的结果，再接着看进度。
- 检查器自己出错：脚本异常、dsh-use 输出坏掉，发一次 notice；一直不好再提醒一次。

stdout 只放需要主控看到的事件（monitor 会把它送进会话），stderr 放每轮诊断和重复
失败（monitor 只归档，不送进会话），所以不需要主控再手写过滤器。断连期间不判断
卡死；恢复后把中断时长补回计时，短期网络故障不会被当成任务失败或丢失。
不调用模型，只调 dsh-use。
"""
import argparse, json, subprocess, sys, time

NOT_RUNNING = 69  # dsh-use：通信口不可用（DSH 没在运行或正在重启）
SSH_FAILED = 255  # ssh 连不上对面


class CheckError(Exception):
    """检查器自己没法继续判断：输出坏了或命令返回了说不清的状态。"""


def ctl(*args, host=None):
    route = ["-H", host] if host else ["--local"]
    p = subprocess.run(["dsh-use", *route, *args, "--json"], capture_output=True, text=True)
    raw = (p.stdout or "").strip()
    body, parsed = {}, False
    try:
        value = json.loads(raw or "null")
        if isinstance(value, dict):
            body, parsed = value, True
    except json.JSONDecodeError:
        pass
    return p.returncode, body, parsed


def emit(kind, **fields):
    """写 stdout：monitor 会把它送进主控会话，只放需要人看的事件。"""
    print(json.dumps({"time": time.strftime("%F %T"), "kind": kind, **fields}, ensure_ascii=False), flush=True)


def log(kind, **fields):
    """写 stderr：monitor 只归档，不送进会话。放每轮诊断和重复失败。"""
    print(json.dumps({"time": time.strftime("%F %T"), "kind": kind, **fields}, ensure_ascii=False),
          file=sys.stderr, flush=True)


def error_of(body):
    return body.get("error") or {}


def one_line(text, limit=160):
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[:limit] + "…"


def notify(lead, text, summary):
    """给主控发一条 notice。成功返回 True；已记录但未确认也当成功，避免重复发。"""
    rc, body, _ = ctl("notice", lead, text, "--summary", summary)
    if rc == 0:
        return True
    err = error_of(body)
    if err.get("code") == "notice-wakeup-unconfirmed":
        log(kind="notice-unconfirmed", error=one_line(err.get("message")))
        return True
    log(kind="notice-failed", exit=rc, error=one_line(err.get("message") or "notice 没发出去"))
    return False


def a_host(host):
    return f"{host} 上的" if host else ""


def minutes(seconds):
    return int(seconds // 60)


def fault_detail(code, body):
    if code == SSH_FAILED:
        return "SSH 连不上"
    if code == NOT_RUNNING:
        return "DSH 没在运行"
    return one_line(error_of(body).get("message") or f"退出 {code}")


def checker_failure(rc, body):
    """参数错误或远端控制层自己坏了：这是检查器的问题，不是长工的问题。"""
    code = str(error_of(body).get("code") or "")
    return rc == 2 or code in ("2", "transport-failed")


def busy_reasons(status, goal, jobs):
    reasons = []
    if status.get("running"):
        reasons.append("在跑")
    if status.get("queued"):
        reasons.append(f"排队 {status['queued']} 条")
    # 只有 armed 的目标会自己开下一轮；active + disarmed 是停住的，归做完/暂停通知管。
    if goal.get("phase") == "active" and goal.get("activation") == "armed":
        reasons.append(f"目标开着（第 {goal.get('roundsStarted')}/{goal.get('maxGoalRounds')} 轮）")
    if jobs:
        reasons.append("后台任务 " + "、".join(j.get("label") or j.get("id") for j in jobs))
    return reasons


def worker_state(state, sid, now):
    return state.setdefault(sid, {"seq": None, "since": now, "alerted": False, "title": sid,
                                  "fault": None, "fault_code": None, "fault_since": None,
                                  "fault_notified": False, "fault_reminded": False})


def host_state(state):
    return state.setdefault("__host__", {"active": False})


def host_down(h, code, now, host, workers, lead, outage_seconds, detail):
    """记下一次主机级中断；开始、到期未恢复各通知一次，其余只记日志。"""
    if not h.get("active"):
        h.clear()
        h.update(active=True, code=code, since=now, notified=False, reminded=False)
    elif h.get("code") != code:
        h["code"] = code
        h["notified"] = False  # 原因类别变了，再明确说一次
    if not h.get("notified"):
        text = (f"dsh-supervise 兜底检查：{a_host(host)}{'这台 DSH' if not host else '这台机器'}连不上"
                f"（{detail}），已暂停检查 {'、'.join(workers)}。长工本身状态未知，不等于失败或丢失；"
                f"恢复后会再通知，期间不再重复提醒。")
        h["notified"] = notify(lead, text, f"{host or '本机 DSH'} 连不上，长工状态未知") if host else True
        emit(kind="host-down", host=host or "local", code=code, workers=list(workers), detail=detail)
        return
    elapsed = now - h["since"]
    if not h.get("reminded") and elapsed >= outage_seconds:
        h["reminded"] = True
        text = (f"dsh-supervise 兜底检查：{a_host(host)}长工已经 {minutes(elapsed)} 分钟连不上（{detail}），"
                f"仍未恢复。长工状态还是未知，不是失败；恢复后会再通知。")
        if host:
            notify(lead, text, f"长工所在机器已断 {minutes(elapsed)} 分钟")
        emit(kind="host-down-still", host=host or "local", minutes=minutes(elapsed))
        return
    log(kind="host-down-repeat", host=host or "local", code=code, seconds=int(elapsed))


def host_recovered(h, state, now, host, workers, lead):
    """连接恢复：补回中断时长，通知一次让主控补查漏掉的结果。"""
    gap = now - h["since"]
    for sid in workers:
        s = state.get(sid)
        if s:
            s["since"] += gap
    h.clear()
    h["active"] = False
    emit(kind="host-recovered", host=host or "local", seconds=int(gap))
    if host:
        notify(lead, (f"dsh-supervise 兜底检查：{a_host(host)}连接已恢复（中断 {minutes(gap)} 分钟）。"
                      f"中断期间看不到长工 {'、'.join(workers)} 的记录，请先补查它们这段时间的结果，再继续看进度。"),
               f"{host} 已恢复，补查长工结果")


def worker_fault(s, sid, category, code, message, now, lead, outage_seconds):
    """一个长工的检查坏了；同一类别只通知一次，其余记日志。"""
    if s.get("fault") != category:
        s.update(fault=category, fault_code=code, fault_since=now,
                 fault_notified=False, fault_reminded=False)
    elif s.get("fault_code") != code:
        s["fault_code"] = code
        s["fault_notified"] = False  # 错误类别变了，再明确说一次
    title = s.get("title") or sid
    if category == "missing":
        text = (f"dsh-supervise 兜底检查：长工「{title}」（{sid}）查不到了（{message}）；"
                f"已停止盯它。请确认它是不是被删了或换了编号。")
        summary = "长工会话查不到"
    else:
        text = (f"dsh-supervise 兜底检查：检查长工「{title}」（{sid}）时出错（{message}），"
                f"暂时判断不了它是否卡死。长工本身不一定有问题；恢复后会再通知，期间不再重复提醒。")
        summary = "长工状态检查出错"
    if not s.get("fault_notified"):
        s["fault_notified"] = notify(lead, text, summary)
        emit(kind="worker-fault", worker=sid, category=category, code=code)
        return
    elapsed = now - s["fault_since"]
    if not s.get("fault_reminded") and elapsed >= outage_seconds:
        s["fault_reminded"] = True
        notify(lead, (f"dsh-supervise 兜底检查：长工「{title}」（{sid}）已经 {minutes(elapsed)} 分钟查不了"
                      f"（{message}），仍未恢复。长工状态未知，不是失败。"),
               f"长工 {sid} 已 {minutes(elapsed)} 分钟查不了")
        emit(kind="worker-fault-still", worker=sid, minutes=minutes(elapsed))
        return
    log(kind="worker-fault-repeat", worker=sid, category=category, code=code, seconds=int(elapsed))


def worker_recovered(s, sid, now, lead):
    """状态检查恢复：补回中断时长，通知一次；没通知过的故障不发恢复提示。"""
    if not s.get("fault"):
        return
    gap = now - (s["fault_since"] or now)
    s["since"] += gap
    was_notified = s.get("fault_notified")
    emit(kind="worker-recovered", worker=sid, seconds=int(gap))
    if was_notified:
        notify(lead, (f"dsh-supervise 兜底检查：长工「{s.get('title') or sid}」（{sid}）的状态检查已恢复"
                      f"（中断 {minutes(gap)} 分钟）。请补查它这段时间的结果。"),
               f"长工 {sid} 的检查已恢复")
    s.update(fault=None, fault_code=None, fault_since=None,
             fault_notified=False, fault_reminded=False)


def checker_fault(state, exc, now, lead, outage_seconds):
    """兜底检查自己出错：一次 notice，超时未恢复再提醒一次。"""
    c = state.setdefault("__checker__", {})
    sig = f"{type(exc).__name__}: {one_line(exc, 200)}"
    if c.get("sig") != sig:
        c.clear()
        c.update(sig=sig, since=now, notified=False, reminded=False)
    if not c.get("notified"):
        c["notified"] = notify(lead, (f"dsh-supervise 兜底检查自己出错了：{sig}。"
                                      f"已经停下判断，修好前不会重复提醒。"), "兜底检查自己出错")
        emit(kind="checker-error", error=sig)
        return
    elapsed = now - c["since"]
    if not c.get("reminded") and elapsed >= outage_seconds:
        c["reminded"] = True
        notify(lead, (f"dsh-supervise 兜底检查已经 {minutes(elapsed)} 分钟一直出错：{sig}。"
                      f"长工这段时间的状态没人看。"), f"兜底检查已 {minutes(elapsed)} 分钟没恢复")
        emit(kind="checker-error-still", minutes=minutes(elapsed))
        return
    log(kind="checker-error-repeat", error=sig, seconds=int(elapsed))


def checker_recovered(state, now, lead):
    c = state.pop("__checker__", None)
    if not c:
        return
    emit(kind="checker-recovered", seconds=int(now - c["since"]))
    if c.get("notified"):
        notify(lead, "dsh-supervise 兜底检查已恢复正常，继续盯长工进度。", "兜底检查已恢复")


def check(lead, workers, state, stall_seconds, outage_seconds, now, host=None):
    h = host_state(state)
    if h.get("active"):
        rc, body, _ = ctl("health", host=host)
        if rc == 0:
            host_recovered(h, state, now, host, workers, lead)
        else:
            code = rc if rc in (SSH_FAILED, NOT_RUNNING) else f"health-{rc}"
            host_down(h, code, now, host, workers, lead, outage_seconds, fault_detail(rc, body))
            return "host-down"

    rc, qc, parsed = ctl("quit-check", host=host)
    if rc in (SSH_FAILED, NOT_RUNNING):
        host_down(h, rc, now, host, workers, lead, outage_seconds, fault_detail(rc, qc))
        return "host-down"
    if rc != 0 or not parsed:
        raise CheckError(f"quit-check 返回 {rc}，输出无法解析")
    jobs = (qc.get("data") or {}).get("jobs") or []

    for sid in list(workers):
        s = worker_state(state, sid, now)
        rc, st, parsed = ctl("status", sid, host=host)
        if rc in (SSH_FAILED, NOT_RUNNING):
            host_down(h, rc, now, host, workers, lead, outage_seconds, fault_detail(rc, st))
            return "host-down"
        if rc not in (0, 10):
            if checker_failure(rc, st):
                raise CheckError(f"status {sid} 返回 {rc}：{fault_detail(rc, st)}")
            category = "missing" if error_of(st).get("code") == "not-found" else "check-failed"
            worker_fault(s, sid, category, str(rc), fault_detail(rc, st), now, lead, outage_seconds)
            if category == "missing" and s.get("fault_notified"):
                workers.remove(sid)
                state.pop(sid, None)
            continue
        if not parsed:
            raise CheckError(f"status {sid} 返回的 JSON 无法解析")
        status = st.get("data") or {}
        if status.get("title"):
            s["title"] = status["title"]

        rc, g, gparsed = ctl("goal", sid, host=host)
        if rc in (SSH_FAILED, NOT_RUNNING):
            host_down(h, rc, now, host, workers, lead, outage_seconds, fault_detail(rc, g))
            return "host-down"
        if rc not in (0, 10) and error_of(g).get("code") != "not-found":
            if checker_failure(rc, g):
                raise CheckError(f"goal {sid} 返回 {rc}：{fault_detail(rc, g)}")
            worker_fault(s, sid, "check-failed", f"goal-{rc}", fault_detail(rc, g),
                         now, lead, outage_seconds)
            continue
        if rc in (0, 10) and not gparsed:
            raise CheckError(f"goal {sid} 返回的 JSON 无法解析")
        goal = (g.get("data") or {}) if rc in (0, 10) else {}
        worker_recovered(s, sid, now, lead)

        mine = [j for j in jobs if j.get("owner") == sid]
        reasons = busy_reasons(status, goal, mine)
        if not reasons:
            s.update(since=now, alerted=False)  # 停着就归做完通知管
            continue
        if status.get("lastSeq") != s["seq"]:
            s.update(seq=status.get("lastSeq"), since=now, alerted=False)
        quiet = now - s["since"]
        if quiet >= stall_seconds and not s["alerted"]:
            s["alerted"] = True
            minutes_q = minutes(quiet)
            title = status.get("title") or sid
            emit(kind="stall", worker=sid, minutes=minutes_q, reasons=reasons)
            notify(lead, (f"dsh-supervise 兜底检查：{a_host(host)}长工「{title}」（{sid}）已 {minutes_q} 分钟"
                          f"没有新记录，但它{'、'.join(reasons)}。请看它最后一轮在做什么，判断是否卡死。"),
                   f"长工 {minutes_q} 分钟没有进展")
    return "ok"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--lead", required=True, help="主控会话（要被叫醒的会话）")
    ap.add_argument("--worker", action="append", required=True, help="长工会话，可以写多次")
    ap.add_argument("--host", help="长工在另一台机器上时写它的名字（同 dsh-use -H）；主控总在本机")
    ap.add_argument("--stall-minutes", type=float, default=30, help="多久没有新记录算卡死，默认 30")
    ap.add_argument("--outage-minutes", type=float, default=15,
                    help="连不上或检查一直失败多久后再提醒一次，默认 15")
    ap.add_argument("--interval", type=float, default=120, help="几秒查一次，默认 120")
    ap.add_argument("--once", action="store_true", help="只查一次并打印状态，用于试跑")
    a = ap.parse_args()
    workers, state = list(a.worker), {}
    log(kind="start", lead=a.lead, workers=workers, host=a.host or "local",
        stall_minutes=a.stall_minutes, outage_minutes=a.outage_minutes, interval=a.interval)
    outage_seconds = a.outage_minutes * 60
    while workers:
        now = time.time()
        try:
            result = check(a.lead, workers, state, a.stall_minutes * 60, outage_seconds, now, a.host)
            checker_recovered(state, now, a.lead)
        except CheckError as e:  # 检查器自己判断不了，不算长工失败
            result = "checker-error"
            checker_fault(state, e, now, a.lead, outage_seconds)
        except Exception as e:  # 单次检查出错不停掉兜底
            result = "checker-error"
            checker_fault(state, e, now, a.lead, outage_seconds)
        if a.once:
            print(json.dumps({"time": time.strftime("%F %T"), "kind": "once",
                              "result": result, "state": state}, ensure_ascii=False), flush=True)
            return 0
        time.sleep(a.interval)
    print(json.dumps({"time": time.strftime("%F %T"), "kind": "exit", "reason": "没有要盯的长工了"},
                     ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())