"""browser-use 的命令与 Python 共用错误。"""
class BrowserUseError(RuntimeError):
    def __init__(self, message, code=1, *, outcome=None, data=None, command=None, host=None):
        super().__init__(message)
        self.code = code
        self.outcome = outcome
        self.data = data or {}
        self.command = command
        self.host = host

    def as_dict(self):
        result = {"ok": False, "error": str(self), "code": self.code}
        if self.command is not None:
            result["command"] = self.command
        if self.host is not None:
            result["host"] = self.host
        if self.outcome is not None:
            result["outcome"] = self.outcome
        if self.data:
            result["data"] = self.data
        return result
