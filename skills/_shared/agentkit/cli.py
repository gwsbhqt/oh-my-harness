"""标准库 CLI 适配器：按 callable 签名接收参数，调用原函数并输出真实 JSON 结果。

main(module, *, prog, actions=None, argv=None) 返回退出码。actions 是完整连字符动作名
到 callable 的映射；省略时只发现模块自身的公共函数，并把模块 callable 放在 run 下。
参数使用 --完整连字符名字；复合值使用 JSON，也可 --input '{"python_name": value}'。
重复、未知、缺失和类型错误在调用之前拒绝。不会替 callable 增加确认或成功标记。
"""
from __future__ import annotations

import argparse
import asyncio
import dataclasses
import inspect
import json
import math
import sys
import types
import typing
from collections.abc import Mapping
from contextlib import redirect_stdout
from enum import Enum
from pathlib import Path


def _loads(text):
    def invalid(value):
        raise ValueError(f"JSON 不接受 {value}")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"JSON 字段重复：{key}")
            result[key] = value
        return result
    return json.loads(text, parse_constant=invalid, object_pairs_hook=pairs)


def _annotation(parameter, hints):
    value = hints.get(parameter.name, parameter.annotation)
    if value is inspect.Parameter.empty:
        default = parameter.default
        return type(default) if default is not inspect.Parameter.empty and default is not None else typing.Any
    return value


def _convert(value, annotation, name):
    """验证 JSON 的真实类型；不把字符串 false 或小数悄悄改成其他值。"""
    origin, args = typing.get_origin(annotation), typing.get_args(annotation)
    if annotation in (typing.Any, inspect.Parameter.empty):
        return value
    if origin in (typing.Union, types.UnionType):
        for member in args:
            try:
                return _convert(value, member, name)
            except (TypeError, ValueError):
                pass
        raise ValueError(f"{name} 不符合 {annotation}")
    if origin is typing.Literal:
        if any(type(value) is type(item) and value == item for item in args):
            return value
        raise ValueError(f"{name} 必须是 {args} 之一")
    if origin in (list, tuple, dict) or annotation in (list, tuple, dict):
        kind = origin or annotation
        if kind in (list, tuple):
            if not isinstance(value, (list, tuple)):
                raise ValueError(f"{name} 必须是 JSON 数组")
            if kind is tuple and args and args[-1] is not Ellipsis:
                if len(value) != len(args):
                    raise ValueError(f"{name} 必须包含 {len(args)} 项")
                items = [_convert(v, t, f"{name}[{i}]") for i, (v, t) in enumerate(zip(value, args))]
            else:
                subtype = args[0] if args else typing.Any
                items = [_convert(v, subtype, f"{name}[{i}]") for i, v in enumerate(value)]
            return tuple(items) if kind is tuple else items
        if not isinstance(value, dict):
            raise ValueError(f"{name} 必须是 JSON 对象")
        keytype, subtype = args or (typing.Any, typing.Any)
        return {_convert(k, keytype, name): _convert(v, subtype, name) for k, v in value.items()}
    if annotation is type(None):
        if value is None:
            return None
    elif annotation is Path:
        if isinstance(value, (str, Path)):
            return Path(value)
    elif annotation is float:
        if type(value) in (int, float) and math.isfinite(value):
            return float(value)
    elif annotation in (str, bool, int):
        if type(value) is annotation:
            return value
    else:
        raise TypeError(f"{name} 的类型 {annotation} 无法由 CLI 表达")
    raise ValueError(f"{name} 必须符合 {annotation}")


def _plain_text(annotation):
    if annotation in (str, Path, type(None)):
        return True
    return typing.get_origin(annotation) is typing.Literal and all(type(item) is str for item in typing.get_args(annotation))


def _from_option(text, annotation, name):
    origin, args = typing.get_origin(annotation), typing.get_args(annotation)
    # 字符串、路径和纯字符串 Literal 原样传递，避免把文件名 true、123、null 当成 JSON。
    if annotation is not type(None) and _plain_text(annotation):
        return _convert(text, annotation, name)
    if origin in (typing.Union, types.UnionType) and all(_plain_text(t) for t in args):
        return _convert(text, annotation, name)
    try:
        value = _loads(text)
    except ValueError:
        if annotation is typing.Any or (origin in (typing.Union, types.UnionType) and str in args):
            value = text
        else:
            raise ValueError(f"{name} 需要有效的 JSON 值") from None
    return _convert(value, annotation, name)


def _jsonable(value):
    if value is None or type(value) in (str, bool, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("结果包含非有限数字")
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Enum):
        return _jsonable(value.value)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return _jsonable(dataclasses.asdict(value))
    if isinstance(value, Mapping):
        if not all(isinstance(k, str) for k in value):
            raise TypeError("JSON 结果对象的键必须是字符串")
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if hasattr(value, "manifest") and isinstance(value.manifest, Mapping):
        return _jsonable(value.manifest)
    raise TypeError(f"无法输出 {type(value).__name__} 的 JSON 结果")


def discover(module):
    """只返回模块自己定义的公共函数，排除导入函数与类。"""
    names = getattr(module, "__all__", vars(module))
    actions = {}
    for name in names:
        target = getattr(module, name)
        if not name.startswith("_") and inspect.isfunction(target) and target.__module__ == module.__name__:
            actions[name.replace("_", "-")] = target
    if callable(module):
        actions.setdefault("run", module)
    return actions


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


class _Once(argparse.Action):
    def __call__(self, parser, namespace, values, option_string=None):
        if hasattr(namespace, self.dest):
            parser.error(f"参数重复：{option_string}")
        setattr(namespace, self.dest, values)


def build_parser(module=None, *, prog, actions=None):
    """返回 argparse 解析器；不调用业务函数。"""
    actions = discover(module) if actions is None else actions
    parser = _Parser(prog=prog, description=inspect.getdoc(module) if module else None,
        epilog="成功时 stdout 为 JSON；JSON/签名错误退出 2，函数执行失败退出 1，错误为 stderr JSON。",
        allow_abbrev=False)
    sub = parser.add_subparsers(dest="_action", required=True)
    for name, target in actions.items():
        if not name or name.startswith("_") or "_" in name or not all(c.islower() or c.isdigit() or c == "-" for c in name):
            raise ValueError(f"动作必须使用完整连字符名字：{name}")
        signature = inspect.signature(target)
        hints = typing.get_type_hints(target if inspect.isfunction(target) else target.__call__)
        doc = inspect.getdoc(target) or name
        child = sub.add_parser(name, help=doc.splitlines()[0], description=doc,
                               allow_abbrev=False,
                               epilog="--input 使用 Python 下划线字段名；同一参数不能同时由 JSON 与选项提供。")
        child.add_argument("--input", dest="_input", default=argparse.SUPPRESS,
                           action=_Once, metavar="JSON", help="包含函数参数的 JSON 对象")
        annotations = {}
        for parameter in signature.parameters.values():
            if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
                raise TypeError(f"{name} 不支持可变参数 {parameter.name}")
            if parameter.name in ("input", "help") or parameter.name.startswith("_"):
                raise ValueError(f"保留参数名：{parameter.name}")
            annotation = _annotation(parameter, hints)
            annotations[parameter.name] = annotation
            default = parameter.default
            detail = "必填" if default is inspect.Parameter.empty else f"默认 {default!r}"
            options = dict(dest=parameter.name, default=argparse.SUPPRESS,
                           help=f"{annotation}；{detail}", action=_Once)
            if annotation is bool:
                options.update(nargs="?", const="true", metavar="true|false")
            else:
                options["metavar"] = "VALUE"
            child.add_argument("--" + parameter.name.replace("_", "-"), **options)
        child.set_defaults(_target=target, _signature=signature, _annotations=annotations, _parser=child)
    return parser


async def _invoke(target, args, kwargs):
    result = target(*args, **kwargs)
    return await result if inspect.isawaitable(result) else result


def main(module=None, *, prog, actions=None, argv=None):
    """调用一次动作，返回 0/1/2/130；业务异常不转换成成功结果。"""
    try:
        parser = build_parser(module, prog=prog, actions=actions)
        namespace = parser.parse_args(argv)
        raw = vars(namespace)
        values = _loads(raw['_input']) if '_input' in raw else {}
        if not isinstance(values, dict):
            raise ValueError("--input 必须是 JSON 对象")
        unknown = values.keys() - namespace._signature.parameters.keys()
        if unknown:
            raise ValueError(f"未知参数：{', '.join(sorted(unknown))}")
        for name, annotation in namespace._annotations.items():
            if name in raw:
                if name in values:
                    raise ValueError(f"参数重复：{name}")
                values[name] = _from_option(raw[name], annotation, name)
            elif name in values:
                values[name] = _convert(values[name], annotation, name)
        positional, keywords = [], {}
        for name, parameter in namespace._signature.parameters.items():
            if name not in values:
                if parameter.default is inspect.Parameter.empty:
                    raise ValueError(f"缺少必填参数：--{name.replace('_', '-')}")
                if parameter.kind is not parameter.POSITIONAL_ONLY:
                    continue
            value = values.get(name, parameter.default)
            if parameter.kind is parameter.POSITIONAL_ONLY:
                positional.append(value)
            else:
                keywords[name] = value
        namespace._signature.bind(*positional, **keywords)
    except SystemExit as exc:
        return int(exc.code)
    except (TypeError, ValueError) as exc:
        sys.stderr.write(json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False) + "\n")
        return 2
    try:
        with redirect_stdout(sys.stderr):
            result = asyncio.run(_invoke(namespace._target, positional, keywords))
        output = json.dumps(_jsonable(result), ensure_ascii=False, allow_nan=False)
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        sys.stderr.write(json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False) + "\n")
        return 1
    sys.stdout.write(output + "\n")
    return 0
