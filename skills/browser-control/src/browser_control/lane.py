"""页面泳道：解析泳道参数，统计 browser-control 设的头和浏览器实际发出去的头是否一致。

加头本身走 network.py 的页面级附加头，这里不碰浏览器。
"""
from __future__ import annotations

import json
import threading

from .errors import BrowserControlError

SAMPLE_URL_LIMIT = 120
_FIELDS = frozenset({"env", "headers", "header", "value"})


def lane_params(value):
    """新开页和 lane set 的写法：普通文本是 x-tt-env；JSON 对象写法 {"headers": {...}}、{"env": ...} 或直接是请求头表。"""
    if isinstance(value, dict):
        return dict(value) if value.keys() & _FIELDS else {"headers": dict(value)}
    if not isinstance(value, str):
        raise BrowserControlError("lane 需要 env 文本或请求头对象", 2)
    if value.lstrip().startswith("{"):
        try:
            parsed = json.loads(value)
        except ValueError:
            raise BrowserControlError("lane 看起来是 JSON 但解析失败；整组请求头写成 '{\"x-tt-env\": \"ppe_xxx\"}'", 2) from None
        if not isinstance(parsed, dict):
            raise BrowserControlError("lane 的 JSON 必须是对象", 2)
        return lane_params(parsed)
    return {"env": value}


def requested(params):
    """泳道参数 → {小写头名: 值}；env 只设 x-tt-env。头名是否合法由附加头规则另查。"""
    if not isinstance(params, dict):
        raise BrowserControlError("泳道参数必须是对象", 2)
    unknown = set(params) - _FIELDS
    if unknown:
        raise BrowserControlError("泳道参数只认 env、headers、header/value；多了：" + "、".join(sorted(map(str, unknown))), 2)
    forms = [name for name in ("env", "headers", "header") if params.get(name) is not None]
    if len(forms) != 1 or (params.get("value") is not None and forms != ["header"]):
        raise BrowserControlError("泳道需要 env、headers 或 header/value 三选一", 2)
    if forms == ["env"]:
        if isinstance(params["env"], str) and params["env"].lstrip().startswith("{"):
            raise BrowserControlError("env 的值是一段 JSON；整组请求头要用 headers 传（命令行 --lane '{\"x-tt-env\": \"...\"}' 或 --headers）", 2)
        values = {"x-tt-env": params["env"]}
    elif forms == ["header"]:
        values = {params["header"]: params.get("value")}
    else:
        values = params["headers"]
    if not isinstance(values, dict) or not values:
        raise BrowserControlError("泳道 headers 需要非空对象", 2)
    result = {}
    for name, value in values.items():
        if not isinstance(name, str) or not name:
            raise BrowserControlError("泳道请求头名称必须是非空字符串", 2)
        if not isinstance(value, str) or not value or any(c in value for c in "\r\n\0"):
            raise BrowserControlError(f"泳道请求头 {name} 的值必须是非空单行文本", 2)
        if name.lower() in result:
            raise BrowserControlError(f"泳道请求头 {name} 重复（名称不分大小写）", 2)
        result[name.lower()] = value
    return result


def _sample(url):
    return url if len(url) <= SAMPLE_URL_LIMIT else url[:SAMPLE_URL_LIMIT] + "…"


class LaneCheck:
    """核对设了泳道之后真正上线的请求；同一种不一致只在首次和数量变化时提醒。"""

    def __init__(self):
        self._lock = threading.Lock()
        self.reset({})

    def reset(self, expected):
        with self._lock:
            self.expected = dict(expected)
            self.requests = 0
            self.matched = 0
            self.mismatched = 0
            self._kinds = {}
            self._reported = {}

    def observe(self, url, intended, wire):
        """intended 是浏览器准备发送的头，wire 是实际上线的头。

        准备发送时就没带 browser-control 设的值的请求不算：跨域预检、worker 自己发的请求、页面脚本自己写了同名头，
        都不归 browser-control 管；命中缓存和 data:/blob: 没有上线，浏览器不报 wire，根本走不到这里。
        """
        sent = {name.lower(): value for name, value in intended.items()}
        actual = {name.lower(): value for name, value in wire.items()}
        with self._lock:
            carried = [name for name, value in self.expected.items() if sent.get(name) == value]
            if not carried:
                return
            self.requests += 1
            wrong = [(name, actual.get(name)) for name in carried if actual.get(name) != self.expected[name]]
            if not wrong:
                self.matched += 1
                return
            self.mismatched += 1
            for name, value in wrong:
                kind = self._kinds.get((name, value))
                if kind is None:
                    kind = {"header": name, "expected": self.expected[name], "actual": value,
                            "requests": 0, "sampleUrl": _sample(url)}
                    self._kinds[(name, value)] = kind
                kind["requests"] += 1

    def stats(self):
        with self._lock:
            return {"requests": self.requests, "matched": self.matched, "mismatched": self.mismatched,
                    "mismatches": [dict(kind) for kind in self._kinds.values()],
                    "scope": "只核对准备发送时带着 browser-control 设的值、并且真正发到网络上的请求；"
                             "跨域预检、worker 自己发的请求、命中缓存和 data:/blob: 不计入"}

    def take_warning(self):
        """有新的或数量变了的不一致时返回警告并记为已提醒，否则返回 None。"""
        with self._lock:
            changed = [key for key, kind in self._kinds.items() if self._reported.get(key) != kind["requests"]]
            if not changed:
                return None
            for key in changed:
                self._reported[key] = self._kinds[key]["requests"]
            rows = [dict(self._kinds[key]) for key in changed]
            expected = dict(self.expected)
        return {"text": warning_text(rows, expected), "mismatches": rows}


def warning_text(rows, expected):
    details = "；".join(
        f"{row['header']} 设的是 {row['expected']}，"
        f"实际{'没有带上' if row['actual'] is None else '是 ' + row['actual']}"
        f"（{row['requests']} 个请求，例如 {row['sampleUrl']}）"
        for row in rows)
    wanted = "，".join(f"{name}={value}" for name, value in sorted(expected.items()))
    return (f"泳道请求头没有按 browser-control 设的值发出去：{details}。"
            f"有别的东西在浏览器发出前改了这个头，多半是浏览器插件。请二选一："
            f"在浏览器里关掉修改这个请求头的插件；或者把那个插件里的泳道也设成 browser-control 设的值（{wanted}）。")
