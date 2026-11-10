"""一次远程 RPC 与显式文件传输；不重试，不使用本机动作兜底。"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
import shlex

from agentkit.remote import ssh

from .browsers import NAMES as BROWSER_NAMES
from .errors import BrowserControlError

_REQUIRED_FEATURES = {"local-routing", "remote-rpc"}
_SHOTS = {"page_snap": "shot", "page_shot": "path", "element_screenshot": "path"}
_UPLOADS = frozenset({"page_upload", "page_upload_via_chooser"})
_ARTIFACTS = {"debug_source"}
# 这些服务的产物统一放在结果的 artifact.path 或 artifacts[].path；只取回这两个位置，不猜其他字段里的路径。
_ARTIFACT_PREFIXES = ("output_", "network_request", "inspect_")
# state_save 的文件含登录 Cookie 原值，只留在目标机；需要时由用户显式拷贝，不经 SSH 自动取回。
# run_remote 没有 deadline。隔离其进程组，停止本机等待不冒称取消远端动作。
_WORKER = r"""
import base64,json,sys
sys.path.insert(0, sys.argv[1])
from agentkit.remote import ssh
request=json.load(sys.stdin)
done=ssh.run_remote(request['host'], request['script'], capture=True)
print(json.dumps({'returncode':done.returncode,'stdout':base64.b64encode(done.stdout).decode(),
                  'stderr':base64.b64encode(done.stderr).decode()}))
"""


# 子进程按这个目录导入同一份共用 SSH 层。
_SHARED = str(Path(ssh.__file__).resolve().parents[2])


def _remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise BrowserControlError("远程调用等待超时；执行结果未知，未重发", 4, outcome="unknown")
    return remaining


def _process(argv, payload, deadline):
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True)
    except OSError as exc:
        raise BrowserControlError(f"无法启动远程传输：{exc}", 5) from exc
    try:
        out, err = proc.communicate(payload, timeout=_remaining(deadline))
    except (subprocess.TimeoutExpired, BrowserControlError) as exc:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()
        raise BrowserControlError("远程传输超时；停止本机等待不等于远端已取消，执行结果未知，未重发", 4,
                      outcome="unknown") from exc
    return subprocess.CompletedProcess(argv, proc.returncode, out, err)


def _run_remote(host, script, deadline):
    done = _process([sys.executable, "-c", _WORKER, _SHARED],
                    json.dumps({"host": host, "script": script}).encode(), deadline)
    if done.returncode:
        raise BrowserControlError(f"共享远程传输失败：{done.stderr.decode(errors='replace')}", 4, outcome="unknown")
    try:
        value = json.loads(done.stdout)
        return subprocess.CompletedProcess([], value["returncode"],
                                           base64.b64decode(value["stdout"], validate=True),
                                           base64.b64decode(value["stderr"], validate=True))
    except (ValueError, KeyError, TypeError) as exc:
        raise BrowserControlError("共享远程传输返回不完整；执行结果未知，未重发", 4, outcome="unknown") from exc


def _checked(done, *, unknown=False):
    if done.returncode:
        raise BrowserControlError(f"远程传输退出 {done.returncode}：{done.stderr.decode(errors='replace')}",
                      4 if done.returncode == 255 or unknown else 5,
                      outcome="unknown" if done.returncode == 255 or unknown else None)
    return done.stdout


def _json(done, *, unknown=False):
    raw = _checked(done, unknown=unknown)
    try:
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("响应必须是对象")
        return value
    except (ValueError, UnicodeError) as exc:
        raise BrowserControlError("远端返回不完整或无效 JSON；未重发", 4 if unknown else 5,
                      outcome="unknown" if unknown else None) from exc


def _tool_script(args, request=None, launcher=None):
    selected = shlex.quote(launcher) if launcher is not None else '"$HOME/.local/bin/browser-control"'
    script = ssh.PRELUDE + "umask 077\n__browser_control=" + selected + "\n"
    script += '[ -x "$__browser_control" ] || { printf \'%s\\n\' \'{"ok":false,"code":5,"error":"remote browser-control missing"}\'; exit 5; }\n'
    script += '"$__browser_control" ' + shlex.join(args)
    if request is not None:
        body = json.dumps(request, ensure_ascii=False, allow_nan=False)
        marker = "BROWSER_CONTROL_JSON_" + uuid.uuid4().hex
        script += " <<'" + marker + "'\n" + body + "\n" + marker
    return script + "\n"


def _remote_path(value):
    if not isinstance(value, str) or not value.startswith("/") or any(c in value for c in ("\x00", "\n", "\r")):
        raise BrowserControlError("远程产物路径必须是无控制字符的绝对路径", 5)
    return value


_META = r"""
import hashlib,json,os,stat,sys
p=sys.argv[1]
f=os.open(p,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0))
with os.fdopen(f,'rb') as stream:
 s=os.fstat(stream.fileno())
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid(): raise ValueError('artifact must be owned regular file')
 if s.st_size>256*1024*1024: raise ValueError('automatic artifact transfer exceeds 256 MiB')
 h=hashlib.sha256()
 for b in iter(lambda:stream.read(1024*1024),b''): h.update(b)
 print(json.dumps({'bytes':s.st_size,'sha256':h.hexdigest()}))
"""


_STAGE_META = r"""
import json,os,stat,sys
p=sys.argv[1]
s=os.lstat(p)
if not stat.S_ISDIR(s.st_mode) or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o700: raise ValueError('stage is not private')
print(json.dumps({'directory':p,'device':s.st_dev,'inode':s.st_ino,'files':[]}))
"""

_CLEANUP = r"""
import json,os,re,stat,sys
stage=json.loads(sys.argv[1]);p=stage['directory']
f=os.open(p,os.O_RDONLY|os.O_DIRECTORY|getattr(os,'O_NOFOLLOW',0))
try:
 s=os.fstat(f)
 if s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o700 or [s.st_dev,s.st_ino]!=[stage['device'],stage['inode']]: raise ValueError('stage ownership or identity changed')
 entries=os.listdir(f)
 if set(entries)-set(stage['files']): raise ValueError('unowned stage entry')
 for name in entries:
  if not re.fullmatch(r'(?:[0-9a-f]{32}-.+|\.transfer-[0-9a-f]{32})',name): raise ValueError('unowned stage entry')
  s=os.stat(name,dir_fd=f,follow_symlinks=False)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid(): raise ValueError('unowned stage file')
 for name in entries: os.unlink(name,dir_fd=f)
 s=os.lstat(p)
 if [s.st_dev,s.st_ino]!=[stage['device'],stage['inode']]: raise ValueError('stage identity changed')
 os.rmdir(p)
finally: os.close(f)
"""


def _metadata(host, remote, deadline):
    return _json(_run_remote(host, ssh.PRELUDE + "python3 -c " + shlex.quote(_META) + " " + shlex.quote(_remote_path(remote)) + "\n", deadline))


def _scp(host, source, destination, deadline, *, upload=False):
    # 默认 SFTP 协议直接处理路径；不启用会二次解释 shell 的旧 SCP 模式。
    remote = _remote_path(destination if upload else source)
    args = ["scp", *ssh.SSH_OPTS, "--"]
    args += [source, host + ":" + remote] if upload else [host + ":" + remote, destination]
    _checked(_process(args, None, deadline))


def _hash(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return {"bytes": Path(path).stat().st_size, "sha256": h.hexdigest()}


class RemoteTransport:
    def __init__(self, launcher=None):
        launcher = launcher if launcher is not None else os.environ.get("BROWSER_CONTROL_REMOTE_LAUNCHER")
        self.launcher = _remote_path(launcher) if launcher is not None else None

    def probe(self, host, timeout=60):
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
            raise BrowserControlError("timeout 需要有限正数", 2)
        if not isinstance(host, str) or host == "local" or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@-]*", host):
            raise BrowserControlError("probe 必须明确远程 SSH host", 2)
        return self._handshake(host, time.monotonic() + timeout)

    def _handshake(self, host, deadline):
        done = _run_remote(host, _tool_script(["--local", "capabilities", "--json"], launcher=self.launcher), deadline)
        if done.returncode not in (0, 255):
            try:
                reply = json.loads(done.stdout)
            except (ValueError, UnicodeError):
                reply = {}
            if reply.get("ok") is False:
                raise BrowserControlError(reply.get("error", "远端能力握手失败"), reply.get("code", 5), host=host, outcome="not_sent")
        value = _json(done)
        features = value.get("features", [])
        if value.get("tool") != "browser-control" or type(value.get("protocol")) is not int or value["protocol"] != 1 or not isinstance(features, list) or not all(isinstance(f, str) for f in features) or not _REQUIRED_FEATURES.issubset(features):
            raise BrowserControlError("远端 browser-control 缺少协议 1 的 local-routing/remote-rpc 能力；未发动作，未改成本机执行", 5)
        return value

    def _fetch(self, host, remote, deadline, out=None):
        remote = _remote_path(remote)
        expected = _metadata(host, remote, deadline)
        directory = Path(tempfile.mkdtemp(prefix="browser-control-remote-", dir=str(Path(out).expanduser().absolute().parent) if out is not None else None))
        directory.chmod(0o700)
        suffix = Path(remote).suffix
        if not re.fullmatch(r"\.[A-Za-z0-9]{1,16}", suffix):
            suffix = ".bin"
        temp = directory / (".transfer-" + uuid.uuid4().hex)
        dest = Path(out).expanduser().absolute() if out is not None else directory / (uuid.uuid4().hex + suffix)
        if out is not None:
            info = dest.parent.lstat()
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise BrowserControlError("本机截图 out 的父目录必须是本用户拥有的真实私有目录，权限 700", 5)
        fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        try:
            _scp(host, remote, str(temp), deadline)
            temp.chmod(0o600)
            actual = _hash(temp)
            if actual != expected or _metadata(host, remote, deadline) != expected:
                raise BrowserControlError("远程产物校验不一致；没有发布本机文件", 5)
            # 同盘 link 原子发布，在目标存在时失败，不跟随符号链接，不覆盖。
            try:
                os.link(temp, dest)
            except FileExistsError as exc:
                raise BrowserControlError("本机 out 已存在；未覆盖", 6) from exc
            except OSError as exc:
                raise BrowserControlError(f"本机 out 无法原子发布：{exc}；未覆盖", 5) from exc
            return str(dest), actual
        finally:
            temp.unlink(missing_ok=True)
            if out is not None or not dest.exists():
                directory.rmdir()

    def _adapt(self, value, request, deadline):
        if not isinstance(value, dict):
            return value
        value = copy.deepcopy(value)
        host = request["host"]
        context = {key: request[key] for key in ("host", "session", "browser")}
        if request.get("target") is not None:
            context["target"] = request["target"]
        value["hostContext"] = context
        action = request["action"]
        nodes = [(value, _SHOTS.get(action))]
        if action in _ARTIFACTS or action.startswith(_ARTIFACT_PREFIXES):
            nodes = [(value.get("artifact"), "path")]
            if isinstance(value.get("artifacts"), list):
                nodes += [(item, "path") for item in value["artifacts"]]
        for node, field in nodes:
            if isinstance(node, dict) and field and isinstance(node.get(field), str) and node[field]:
                remote = node[field]
                local, meta = self._fetch(host, remote, deadline, out=request["params"].get("out") if action in _SHOTS else None)
                node[field] = local
                node.update(remotePath=remote, hostContext=context, **meta)
        return value

    def _stage(self, host, request, deadline, stages):
        action, params = request["action"], request["params"]
        if action in _UPLOADS:
            sources = params.get("files")
            if not isinstance(sources, list) or not sources:
                raise BrowserControlError("upload files 需要非空本机文件列表", 2)
        elif action == "network_override":
            sources = [params.get("file")]
        else:
            return
        paths = []
        for source in sources:
            if not isinstance(source, str) or not source or "\x00" in source:
                raise BrowserControlError("stage 需要明确本机文件路径", 2)
            path = Path(source).expanduser().absolute()
            if not path.is_file():
                raise BrowserControlError("明确的本机上传文件不存在或不是普通文件", 3)
            paths.append(path)
        # mktemp 是唯一建立目录的地方；cleanup 不接受业务结果给出的路径。
        script = ssh.PRELUDE + 'umask 077\n__browser_control_stage=$(mktemp -d /tmp/browser-control-stage-XXXXXXXXXXXX) || exit $?\n'
        script += "python3 -c " + shlex.quote(_STAGE_META) + ' "$__browser_control_stage"\n'
        owned = _json(_run_remote(host, script, deadline))
        directory = owned.get("directory", "")
        if not re.fullmatch(r"/tmp/browser-control-stage-[A-Za-z0-9]{12}", directory):
            raise BrowserControlError("远端 stage 回执无效；未发送动作", 5)
        if type(owned.get("device")) is not int or type(owned.get("inode")) is not int or owned.get("files") != []:
            raise BrowserControlError("远端 stage 身份回执无效；未发送动作", 5)
        stages.append(owned)
        remote_files = []
        for path in paths:
            name = uuid.uuid4().hex + "-" + path.name
            if any(c in name for c in ("\n", "\r")):
                raise BrowserControlError("上传文件名不能含换行", 2)
            remote = directory + "/" + name
            temp = directory + "/.transfer-" + uuid.uuid4().hex
            owned["files"].extend([name, Path(temp).name])
            expected = _hash(path)
            _scp(host, str(path), temp, deadline, upload=True)
            script = ssh.PRELUDE + "chmod 600 " + shlex.quote(temp) + " && ln " + shlex.quote(temp) + " " + shlex.quote(remote) + " && rm " + shlex.quote(temp) + "\n"
            _checked(_run_remote(host, script, deadline))
            if _metadata(host, remote, deadline) != expected or _hash(path) != expected:
                raise BrowserControlError("上传文件校验失败；未发送动作", 5)
            remote_files.append(remote)
        if action in _UPLOADS:
            params["files"] = remote_files
        else:
            params["file"] = remote_files[0]

    def _cleanup(self, host, stages, deadline):
        for stage in stages:
            # 只删除本次生成的名字，目录或条目被外部替换就拒绝。
            script = ssh.PRELUDE + "python3 -c " + shlex.quote(_CLEANUP) + " " + shlex.quote(json.dumps(stage)) + "\n"
            _checked(_run_remote(host, script, deadline))

    def call(self, request, timeout=60):
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
            raise BrowserControlError("timeout 需要有限正数", 2)
        if not isinstance(request, dict):
            raise BrowserControlError("远程 request 必须为对象", 2)
        request = copy.deepcopy(request)
        host = request.get("host")
        if not isinstance(host, str) or host == "local" or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@-]*", host):
            raise BrowserControlError("远程 request 必须明确 SSH host，不能回退本机", 2)
        if not isinstance(request.get("session"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", request["session"]):
            raise BrowserControlError("远程 request 必须含明确 session", 2)
        if request.get("browser") not in BROWSER_NAMES or not isinstance(request.get("action"), str) or not request["action"] or not isinstance(request.get("params"), dict):
            raise BrowserControlError("远程 request 缺少 browser/action/params", 2)
        try:
            json.dumps(request, allow_nan=False)
        except (ValueError, TypeError) as exc:
            raise BrowserControlError("远程参数不能转换成 JSON", 2) from exc
        if request["action"] in _SHOTS and request["params"].get("overwrite"):
            raise BrowserControlError("远程截图暂不支持覆盖本机已有文件；请使用新 out 路径", 5)
        if request["action"] in _SHOTS and request["params"].get("out") is not None:
            out = request["params"]["out"]
            if not isinstance(out, str) or not out or "\x00" in out:
                raise BrowserControlError("out 必须为明确本机路径", 2)
            dest = Path(out).expanduser().absolute()
            try:
                info = dest.parent.lstat()
                if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                    raise BrowserControlError("本机 out 父目录必须是当前用户的私有目录，权限 700", 5)
                if os.path.lexists(dest):
                    raise BrowserControlError("本机 out 已存在；未发动作，未覆盖", 6)
            except OSError as exc:
                raise BrowserControlError(f"本机 out 父目录不可用：{exc}", 5) from exc
        deadline, stages, failure, upload_sent = time.monotonic() + timeout, [], None, False
        try:
            self._handshake(host, deadline)
            self._stage(host, request, deadline, stages)
            payload = copy.deepcopy(request)
            payload.update(host="local", rpcTimeout=_remaining(deadline))
            if request["action"] in _SHOTS:
                payload["params"].pop("out", None)
                payload["params"].pop("overwrite", None)
            if request["action"] in _UPLOADS and stages:
                payload["remoteStages"] = copy.deepcopy(stages)
            script = _tool_script(["rpc", "--json"], payload, launcher=self.launcher)
            upload_sent = request["action"] in _UPLOADS
            done = _run_remote(host, script, deadline)
            if done.returncode == 255:
                _checked(done, unknown=True)
            # 业务错误 JSON 即使非零退出仍须保留原始 code/outcome/data。
            try:
                reply = json.loads(done.stdout)
            except (ValueError, UnicodeError) as exc:
                raise BrowserControlError("远程动作后响应不完整；执行结果未知，未重发", 4, outcome="unknown") from exc
            if not isinstance(reply, dict) or type(reply.get("ok")) is not bool:
                raise BrowserControlError("远程动作响应无效；执行结果未知，未重发", 4, outcome="unknown")
            if not reply["ok"]:
                if type(reply.get("code", 1)) is not int or reply.get("code", 1) not in range(1, 7) or not isinstance(reply.get("data", {}), dict) or not isinstance(reply.get("error", ""), str):
                    raise BrowserControlError("远程错误响应无效；执行结果未知，未重发", 4, outcome="unknown")
                try:
                    data = self._adapt(reply.get("data", {}), request, deadline)
                except BrowserControlError as transfer:
                    data = copy.deepcopy(reply.get("data", {}))
                    data["artifactTransferError"] = str(transfer)
                raise BrowserControlError(reply.get("error", "远端动作失败"), reply.get("code", 1),
                              outcome=reply.get("outcome"), data=data, command=request["action"], host=host)
            if done.returncode or "result" not in reply:
                raise BrowserControlError("远程动作缺少成功终态；执行结果未知，未重发", 4, outcome="unknown")
            result = self._adapt(reply["result"], request, deadline)
            if upload_sent and isinstance(result, dict):
                result.update(stageUntilRelease=True, ownedStages=copy.deepcopy(stages))
            return result
        except BrowserControlError as exc:
            failure = exc
            exc.host, exc.command = host, request["action"]
            raise
        except (OSError, ValueError, UnicodeError) as exc:
            failure = BrowserControlError(f"远程调用或文件传输失败：{exc}；不要重发动作", 5, host=host, command=request["action"])
            raise failure from exc
        finally:
            if stages and upload_sent and failure is not None:
                failure.data.update(stageUntilRelease=True, ownedStages=copy.deepcopy(stages))
            if stages and not upload_sent:
                try:
                    self._cleanup(host, stages, deadline)
                except BrowserControlError as exc:
                    details = {"ownedStages": stages, "cleanupError": str(exc)}
                    if failure is not None:
                        failure.data.update(details)
                    else:
                        raise BrowserControlError("动作已返回，但远端上传暂存清理失败；不要重发动作", 5,
                                      data=details, host=host, command=request["action"]) from exc
