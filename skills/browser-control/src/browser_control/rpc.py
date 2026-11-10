"""SSH只传结构化请求至目标机本地服务，不开放浏览器调试端口。"""
import json
import sys
from .client import Client
from .errors import BrowserControlError
from .server import MAX_REQUEST


def receive(stream=None):
    """处理一条显式任务请求；拒绝再次远程路由与不完整载荷。"""
    stream = stream or sys.stdin.buffer
    raw = stream.readline(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST or not raw.endswith(b"\n"):
        raise BrowserControlError("远程RPC载荷过大或未完整换行", 2, outcome="not_sent")
    try:
        request = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise BrowserControlError("远程RPC不是有效JSON", 2, outcome="not_sent") from exc
    if not isinstance(request, dict):
        raise BrowserControlError("远程RPC需要对象", 2, outcome="not_sent")
    allowed = {"action", "params", "target", "session", "browser", "host", "rpcTimeout", "remoteStages"}
    if set(request) - allowed or request.get("host") != "local" or not request.get("session"):
        raise BrowserControlError("远程RPC需要明确本机目标和任务；不能再次远程路由", 2, outcome="not_sent")
    action = request.get("action")
    if "remoteStages" in request and action != "page_upload":
        raise BrowserControlError("暂存归属只用于明确上传动作", 2, outcome="not_sent")
    try:
        result = Client().call(action, request.get("params"), target=request.get("target"),
            session=request["session"], browser=request.get("browser", "Chrome"), host="local",
            timeout=request.get("rpcTimeout", 60), remote_stages=request.get("remoteStages"))
        return {"ok": True, "result": result}
    except BrowserControlError as exc:
        exc.command = exc.command or action
        exc.host = "local"
        return exc.as_dict()


def main():
    try:
        result = receive()
    except BrowserControlError as exc:
        result = exc.as_dict()
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0 if result.get("ok") else result.get("code", 1)
