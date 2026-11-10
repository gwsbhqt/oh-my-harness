"""Bounded click-only values; no dynamic attribute access or user formatting."""
from __future__ import annotations

import json
import io
import weakref
from collections import OrderedDict
import math
import time
import types

MAX_BYTES = 40 * 1024


MAX_SOURCE_ENTRIES = 256
MAX_SOURCE_CHARS = 262144
MAX_SINGLE_SOURCE_CHARS = 65536
MAX_SOURCE_CODES = 512
MAX_SOURCE_CONSTS = 4096
_source_records = OrderedDict()
_source_chars = 0


def _forget_source(identity, reference=None):
    global _source_chars
    entry = _source_records.get(identity)
    if entry is not None and (reference is None or entry[0] is reference):
        del _source_records[identity]
        _source_chars -= len(entry[1])


def _remember_code(code, source):
    global _source_chars
    identity = id(code)
    _forget_source(identity)
    reference = weakref.ref(code, lambda dead, key=identity: _forget_source(key, dead))
    _source_records[identity] = (reference, source)
    _source_chars += len(source)
    while len(_source_records) > MAX_SOURCE_ENTRIES or _source_chars > MAX_SOURCE_CHARS:
        _forget_source(next(iter(_source_records)))


def remember_source(codes, source):
    """Associate only exact compiled code identities, without hashing code/constants."""
    if type(source) is not str or len(source) > MAX_SINGLE_SOURCE_CHARS:
        return
    if type(codes) is not list and type(codes) is not tuple:
        return
    stack = [iter(codes)]
    seen = set()
    slots = 0
    while stack and len(seen) < MAX_SOURCE_CODES and slots < MAX_SOURCE_CONSTS:
        try:
            code = next(stack[-1])
        except StopIteration:
            stack.pop()
            continue
        slots += 1
        if type(code) is not types.CodeType or id(code) in seen:
            continue
        seen.add(id(code))
        _remember_code(code, source)
        stack.append(iter(code.co_consts))


def _remembered_source(code):
    entry = _source_records.get(id(code))
    if entry is not None:
        if entry[0]() is code:
            return entry[1]
        _forget_source(id(code), entry[0])
    return None


def _type_name(value):
    return type.__dict__["__name__"].__get__(type(value))[:128]


def _raw_dict(value, budget):
    cls = type(value)
    mro = type.__dict__["__mro__"].__get__(cls)
    for base in mro:
        if not budget.check():
            return None
        fields = type.__dict__["__dict__"].__get__(base)
        descriptor = fields.get("__dict__")
        if type(descriptor) is types.GetSetDescriptorType:
            try:
                result = descriptor.__get__(value, cls)
            except (TypeError, AttributeError):
                return None
            return result if type(result) is dict else None
        if descriptor is not None:
            return None
    return None


class _Budget:
    def __init__(self):
        self.deadline = time.monotonic() + 0.05
        self.steps = 0
        self.chars = 6000
        self.truncated = False
        self.seen = set()

    def check(self):
        self.steps += 1
        if self.steps > 200 or time.monotonic() >= self.deadline:
            self.truncated = True
            return False
        return True

    def text(self, text, limit=1024):
        size = min(len(text), limit, self.chars)
        self.chars -= size
        if size < len(text):
            self.truncated = True
            return text[:size] + "…[truncated]"
        return text

    def value(self, value, depth=0):
        if not self.check():
            return "[budget limit]"
        cls = type(value)
        if value is None or cls is bool:
            return value
        if cls is str:
            return self.text(value)
        if cls is int:
            bits = int.bit_length(value)
            if bits > 512:
                self.truncated = True
                return {"$type": "int", "bits": bits, "note": "整数过大，仅显示位数"}
            return {"$type": "int", "decimal": str(value)} if bits > 53 else value
        if cls is float:
            return value if math.isfinite(value) else {"$type": "float", "value": "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")}
        if cls is bytes or cls is bytearray:
            self.truncated |= len(value) > 64
            return {"$type": _type_name(value), "size": len(value), "hex": value[:64].hex()}
        if depth >= 4:
            self.truncated = True
            return "[depth limit]"
        identity = id(value)
        if identity in self.seen:
            self.truncated = True
            return "[circular reference]"
        self.seen.add(identity)
        try:
            if cls is list or cls is tuple or cls is set or cls is frozenset:
                items = []
                iterator = iter(value)
                for _ in range(min(len(value), 100)):
                    if not self.check():
                        break
                    items.append(self.value(next(iterator), depth + 1))
                if len(items) < len(value):
                    self.truncated = True
                    items.append("[remaining items omitted]")
                return items
            if cls is dict:
                # Buffer only visited entries. Exact untruncated string keys can
                # remain JSON keys; pairs preserve every other key without collisions.
                entries = []
                native_keys = True
                iterator = iter(dict.items(value))
                for _ in range(min(len(value), 60)):
                    if not self.check():
                        break
                    key, item = next(iterator)
                    native_keys &= type(key) is str and len(key) <= min(1024, self.chars)
                    entries.append([self.value(key, depth + 1), self.value(item, depth + 1)])
                self.truncated |= len(entries) < len(value)
                if native_keys:
                    return {key: item for key, item in entries}
                return {"$type": "dict", "size": len(value), "entries": entries}
            if cls is types.ModuleType:
                fields = types.ModuleType.__dict__["__dict__"].__get__(value)
                names = []
                for key in fields:
                    if not self.check():
                        break
                    if type(key) is str:
                        names.append(self.text(key, 128))
                self.truncated |= len(names) < len(fields)
                return {"$type": "module", "names": names, "size": len(fields)}
            if any(base is type for base in type.__dict__["__mro__"].__get__(cls)):
                fields = type.__dict__["__dict__"].__get__(value)
                names = []
                for key in fields:
                    if not self.check():
                        break
                    if type(key) is str:
                        names.append(self.text(key, 128))
                return {"$type": "class", "name": self.text(type.__dict__["__name__"].__get__(value), 128), "attributes": names, "note": "未找到可安全读取的类源码；仅列出静态属性"}
            if cls is types.BuiltinFunctionType:
                fields = {}
                for key in ("__name__", "__text_signature__", "__doc__", "__module__"):
                    if not self.check():
                        break
                    descriptor = types.BuiltinFunctionType.__dict__.get(key)
                    if type(descriptor) is types.GetSetDescriptorType or type(descriptor) is types.MemberDescriptorType:
                        item = descriptor.__get__(value)
                        if type(item) is str:
                            fields[key] = self.text(item)
                return {"$type": "builtin", "metadata": fields, "note": "内置函数没有 Python 源码"}
            fields = _raw_dict(value, self)
            return {"$type": _type_name(value), "fields": self.value(fields, depth + 1) if fields is not None else None,
                    "note": "仅显示原始存储字段，不读取动态属性"}
        finally:
            self.seen.remove(identity)


def _source(value, budget):
    if type(value) is types.MethodType:
        value = types.MethodType.__dict__["__func__"].__get__(value)
    if type(value) is not types.FunctionType:
        return None
    code = types.FunctionType.__dict__["__code__"].__get__(value)
    filename = code.co_filename
    first = code.co_firstlineno
    result = {"line": first, "language": "python"}
    if len(filename) <= 1024:
        result["filename"] = budget.text(filename, 1024)
    end = first
    line_iterator = code.co_lines()
    while budget.check():
        try:
            _, _, line = next(line_iterator)
        except StopIteration:
            break
        if type(line) is int and line > end:
            end = line
    source = _remembered_source(code)
    if source is None:
        # Cell filenames can repeat after restart. Never ask the host to turn
        # an unregistered cell name into a different code object's source.
        module = types.FunctionType.__dict__["__module__"].__get__(value)
        if type(module) is str and module and module != "__main__" and not filename.startswith("<"):
            result["sourceEndLine"] = end
        return {**result, "kind": "metadata", "value": {"name": budget.text(code.co_name), "arguments": [budget.text(arg, 128) for arg in code.co_varnames[:min(code.co_argcount + code.co_kwonlyargcount, 40)]]}, "reason": "缓存中没有此代码对象的原始源码；快照恢复或源码记录被清理后可能无法预览原文"}
    result["sourceEndLine"] = end
    pieces = []
    # Registration caps the entire string at 64 Ki characters. Read only the
    # requested lines in memory, without splitting it into an unbounded list.
    lines = io.StringIO(source, newline="")
    current_line = 1
    while current_line < first:
        if time.monotonic() >= budget.deadline:
            budget.truncated = True
            break
        if not lines.readline(MAX_SINGLE_SOURCE_CHARS + 1):
            break
        current_line += 1
    if current_line == first:
        for _ in range(min(end - first + 1, 80)):
            if not budget.check():
                break
            text = lines.readline(MAX_SINGLE_SOURCE_CHARS + 1)
            if not text:
                break
            pieces.append(budget.text(text, 2048))
            if budget.chars <= 0:
                break
    budget.truncated |= end > first + 79 or budget.chars <= 0
    source = "".join(pieces)
    if not source:
        return {**result, "kind": "metadata", "reason": "源码记录中没有可用的对应行"}
    return {**result, "kind": "source", "source": source}


def _limit_tree(value, budget, depth=0, count=None):
    # Count the emitted tree too: dictionary tags and entry pairs also cost nodes.
    if count is None:
        count = [0]
    count[0] += 1
    if count[0] >= 190 or depth >= 5:
        if type(value) is list or type(value) is dict:
            budget.truncated = True
            return "[preview limit]"
        return value
    if type(value) is list:
        result = []
        for item in value:
            if count[0] >= 189:
                budget.truncated = True
                break
            result.append(_limit_tree(item, budget, depth + 1, count))
        return result
    if type(value) is dict:
        result = {}
        for key, item in value.items():
            if count[0] >= 189:
                budget.truncated = True
                break
            result[key] = _limit_tree(item, budget, depth + 1, count)
        return result
    return value


def preview(ns, name, requested_epoch, epoch):
    if type(name) is not str or not name or len(name) > 256 or not name.isidentifier():
        return {"status": "error", "reason": "只能预览顶层变量名，不能执行表达式"}
    if type(requested_epoch) is not int or requested_epoch != epoch:
        return {"status": "stale", "reason": "内核已更换，请刷新变量列表"}
    # A malicious non-string global key can collide with a string hash. Iterate
    # keys with a budget instead of dictionary lookup, which could call its __eq__.
    budget = _Budget()
    found = False
    value = None
    for key, item in dict.items(ns):
        if time.monotonic() >= budget.deadline:
            return {"status": "timeout", "reason": "查找变量超过时间限制"}
        if type(key) is str and key == name:
            value, found = item, True
            break
    if not found:
        return {"status": "missing", "reason": "变量已不存在"}
    result = _source(value, budget)
    if result is None:
        cls = type(value)
        scalar = cls is str or cls is int or cls is float or cls is bool or value is None
        container = any(cls is candidate for candidate in (list, tuple, dict, set, frozenset, bytes, bytearray))
        result = {"kind": "json" if scalar or container else "metadata", "value": budget.value(value)}
    result.update(status="ok", type=_type_name(value))
    result = _limit_tree(result, budget)
    result["truncated"] = budget.truncated
    if len(json.dumps(result, ensure_ascii=True, allow_nan=False).encode("utf-8")) > MAX_BYTES:
        return {"status": "ok", "kind": "metadata", "type": _type_name(value), "truncated": True, "reason": "预览超过大小限制"}
    return result
