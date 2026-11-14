"""原生元素句柄：固定快照凭证，不跨应用或界面变化重新解释选择器。"""
from __future__ import annotations

class Element:
    def __init__(self, app, selector=None, *, handle=None):
        from . import ComputerUseError
        self.app = app
        self.selector = dict(selector or {})
        self.handle = dict(handle) if handle else None
        if self.handle:
            if self.handle.get("app") != app.name or self.handle.get("host") != app.host or self.handle.get("scope") != app.scope or self.handle.get("lease") != app.lease or self.handle.get("boundWindow") != app.window:
                raise ComputerUseError("元素句柄不属于这个应用或机器", 6, "element", host=app.host)
        elif not self.selector or set(self.selector)-{"idx", "id", "label", "role"}:
            raise ComputerUseError("原生 selector 支持 idx/id/label/role；CSS/frame/within/testid 不支持", 5, "element", host=app.host)

    async def resolve(self):
        from . import ComputerUseError
        if self.handle is not None:
            if self.handle.get("scope") != self.app.scope or self.handle.get("lease") != self.app.lease or self.handle.get("boundWindow") != self.app.window:
                raise ComputerUseError("元素句柄的任务、窗口或持有凭证已变化", 4, "element", host=self.app.host)
            return dict(self.handle)
        snap = await self.app.snap(max=600)
        if snap.truncated or snap.timed_out:
            raise ComputerUseError("元素遍历不完整，不能证明唯一匹配", 4, "element", host=self.app.host)
        hits = snap.find(**{k:v for k,v in self.selector.items() if k != "idx"})
        if "idx" in self.selector:
            hits = [e for e in hits if e["idx"] == self.selector["idx"]]
        if len(hits) != 1:
            raise ComputerUseError(f"选择器匹配到 {len(hits)} 个元素，要求唯一", 3 if not hits else 4, "element", host=self.app.host)
        self.handle = {"app": self.app.name, "host": self.app.host, "snapshot": snap.snapshot,
                       "idx": hits[0]["idx"], "element": dict(hits[0]), "selector": self.selector,
                       "window": snap.window, "process": snap.app, "scope": self.app.scope,
                       "lease": self.app.lease, "boundWindow": dict(self.app.window) if self.app.window else None}
        return dict(self.handle)

    async def _call(self, name, *args, **options):
        from . import ComputerUseError
        h = await self.resolve()
        if not h.get("snapshot"):
            raise ComputerUseError("元素句柄没有快照凭证", 4, "element", host=self.app.host)
        if name in ("click", "set_value", "scroll", "act"):
            e = h["element"]
            if not e.get("enabled", True) or e.get("visible") is False or e.get("offscreen") or e.get("occluded") is True:
                raise ComputerUseError("元素当前快照不可操作", 4, name, host=self.app.host)
        return await getattr(self.app, name)(h["idx"], *args, snapshot=h["snapshot"], **options)

    async def read(self, *, selected=False):
        return await self._call("read", selected=selected)

    async def click(self, **options):
        return await self._call("click", **options)

    async def set_value(self, value):
        return await self._call("set_value", value)

    async def scroll(self, direction="down", *, pages=1):
        return await self._call("scroll", direction, pages=pages)

    async def act(self, action):
        return await self._call("act", action)

    async def measure(self):
        h = await self.resolve()
        await self.read()
        e = h["element"]
        return {"bounds": {k:e.get(k) for k in ("x", "y", "w", "h")}, "coordinates": "screen",
                "source": "snapshot", "snapshot": h["snapshot"], "visible": e.get("visible"),
                "offscreen": e.get("offscreen"), "occluded": e.get("occluded"), "enabled": e.get("enabled"),
                "editable": e.get("settable", False), "scrollable": e.get("scrollable"),
                "occlusion_reason": "原生 AX 不提供遮挡检测"}
