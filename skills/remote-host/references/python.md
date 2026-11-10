# remote-host Python 接口

带 Python 内核必须直接用 `skills.remote_host`，不另起模块别名。以下签名取自源码，缺省值的符号以源码定义为准。Python 日常流程见 [Python 主说明](../PYSKILL.md)，操作授权、结果核对和收尾以 [共用规则](common.md) 为准。

- `await skills.remote_host.cli(*args, input=None, timeout=DEFAULT_TIMEOUT, quiet=False)`
- `skills.remote_host.reverse_proxy(*, host, local_proxy, timeout=30)`：返回异步上下文；可 `await open()` / `await close()`，详见 [跨网络代理](hosts-and-proxy.md#跨网络借用本机-http-代理)。
- `await skills.remote_host.run(script, *, host=None, interp=None, cwd=None, proxy=False, table=False, timeout=DEFAULT_TIMEOUT, quiet=False)`
- `await skills.remote_host.send(script, *, host=None, session=None, detach=False, wait=300, lines=0, timeout=DEFAULT_TIMEOUT, quiet=False)`
- `await skills.remote_host.peek(*, host=None, session=None, lines=30, timeout=60, quiet=False)`
- `await skills.remote_host.reset(*, host=None, session=None, timeout=60, quiet=False)`
- `await skills.remote_host.status(*, host=None, timeout=90, quiet=False)`
- `await skills.remote_host.doctor(*, host=None, timeout=120, quiet=False)`
- `await skills.remote_host.hosts(*, timeout=30, quiet=False)`
- `await skills.remote_host.wait(*, host=None, port=None, proc=None, file=None, check=None, gone=False, timeout=120, every=2, quiet=False)`
- `await skills.remote_host.app(action, name, *, host=None, timeout=30, port=None, since=60, lines=20, quiet=False)`
- `await skills.remote_host.screenshot(*, host=None, screen=None, png=False, output=None, max_edge=None, timeout=180, quiet=False)`
- `await skills.remote_host.job(action='list', name=None, script=None, *, host=None, follow=False, progress=None, every=30, lines=40, wait=None, timeout=DEFAULT_TIMEOUT, quiet=False)`
- `await skills.remote_host.copy(src, dst, *, replace=False, verify=True, quick=False, compress=True, every=30, timeout=DEFAULT_TIMEOUT, quiet=False)`
- `await skills.remote_host.verify(src, dst, *, quick=False, timeout=DEFAULT_TIMEOUT, quiet=False)`
- `await skills.remote_host.manifest(loc, *, quick=False, full=False, timeout=DEFAULT_TIMEOUT, quiet=False)`
- `await skills.remote_host.use(name=None, *, interp=None, cwd=None, proxy=False, no_proxy=False, clear=False, timeout=30, quiet=False)`
- `await skills.remote_host.discover(*, seconds=3, timeout=60, quiet=False)`

## 结果对象与超时

除 `reverse_proxy()` 返回资源句柄外，业务函数异步返回 Result，默认会回显输出，quiet=True 关闭回显。属性：ok、code、out、err、text、lines、last_line、seconds、timed_out、remote_unknown、outcome。out/err 是字符串；lines 仅包含 stdout 的非空行；outcome 为 unknown 或 exited。code=0 才 ok，远端动作成功还要核对业务结果。remote_unknown 在超时、124/125/255、信号退出或无退出码时为真。

run 支持 interp/cwd/proxy/table；proxy 可以是原有 bool 或已打开的反向代理句柄，句柄限定单一 host，不支持 table。send/peek/reset 支持显式 session。timeout 是本地等待上限，wait()/app() 还给远端命令设置上限并留本地收尾余量。停止本地等待不能证明远端终止；长任务使用 job 跟踪。

## 无专用函数的管理入口

新机器 onboard 没有专用函数，完成首次连接中的身份和权限核对后才调用：

```python
# remote-host：公开 Python 入口原样传子命令参数，不经调用方 shell。
result = await skills.remote_host.cli("onboard", "new-host", quiet=True)
result.ok, result.code, result.out, result.err
```

put/get/attach 等也仅由 cli(*args, input=None, timeout=600.0, quiet=False) 提供；attach 仍需真实交互终端。正常执行、复制、任务管理优先用具名 Python 函数。命令参数见 [CLI 参考](cli.md)。
