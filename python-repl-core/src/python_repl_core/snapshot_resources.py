"""Preserve worksheet dimensions and restore guarded snapshot resources."""
from __future__ import annotations

import copyreg
import io
import mmap
import pickle
import sys
from itertools import chain
from threading import RLock
from types import MethodType, ModuleType
from zipfile import ZipFile


_DIMENSIONS_MODULE = "openpyxl.worksheet.dimensions"
_DIMENSION_FORMAT = "openpyxl.dimensions.v1"
_LAYOUT = (("row_dimensions", "_add_row"), ("column_dimensions", "_add_column"))


def _loaded_class(module_name, class_name):
    module = sys.modules.get(module_name)
    if type(module) is ModuleType:
        cls = vars(module).get(class_name)
        if type(cls) is type and cls.__module__ == module_name and cls.__name__ == class_name:
            return cls
    return None


def dimension_type():
    return _loaded_class(_DIMENSIONS_MODULE, "DimensionHolder")


def _bound_layout(method):
    if type(method) is MethodType:
        worksheet = _loaded_class("openpyxl.worksheet.worksheet", "Worksheet")
        if type(method.__self__) is worksheet:
            for _, name in _LAYOUT:
                if method.__func__ is getattr(worksheet, name):
                    return method.__self__, name
    return None


def _reduce_dimension(holder):
    attrs = vars(holder).copy()
    factory = holder.default_factory
    if factory is None and _bound_layout(attrs.get("worksheet")) is not None:
        factory = attrs["worksheet"]
        attrs["worksheet"] = factory.__self__
    # NEWOBJ memoizes the holder before its worksheet and dimensions refer back to it.
    return copyreg.__newobj__, (type(holder),), (attrs, {"default_factory": factory}), None, iter(dict.items(holder))


def save_with_dimensions(pickler, value, cls):
    if cls is None:
        pickler.save(value)
        return
    previous = vars(pickler).get("dispatch_table")
    table = getattr(pickler, "dispatch_table", copyreg.dispatch_table)
    def first_dimension(holder):
        # A normal UNICODE + POP is a per-record format hint that old readers consume without changing the stack.
        pickler.write(pickle.UNICODE + _DIMENSION_FORMAT.encode("ascii") + b"\n" + pickle.POP)
        pickler.dispatch_table[cls] = _reduce_dimension
        return _reduce_dimension(holder)

    pickler.dispatch_table = {**table, cls: first_dimension}
    try:
        pickler.save(value)
    finally:
        if previous is None:
            del pickler.dispatch_table
        else:
            pickler.dispatch_table = previous


def _empty_dimension_constructors(stream):
    # NEWOBJ in place of this exact obsolete REDUCE retains all frame lengths, memo slots and host guards.
    import pickletools

    unknown, holder, empty, mark, modern = object(), object(), object(), object(), object()
    previous = top = unknown
    memo = {}
    patches = []
    for opcode, arg, pos in pickletools.genops(stream):
        key = opcode.name
        if key in ("MEMOIZE", "BINPUT", "LONG_BINPUT", "PUT"):
            memo[len(memo) if key == "MEMOIZE" else arg] = top
            continue
        if key in ("FRAME", "PROTO"):
            continue
        if key == "POP" and top is modern:
            return patches, not patches
        if key == "UNICODE" and arg == _DIMENSION_FORMAT:
            value = modern
        elif key in ("SHORT_BINUNICODE", "BINUNICODE", "UNICODE"):
            value = arg if arg in (_DIMENSIONS_MODULE, "DimensionHolder") else unknown
        elif key in ("BINGET", "LONG_BINGET", "GET"):
            value = memo.get(arg, unknown)
        elif ((key == "GLOBAL" and arg == _DIMENSIONS_MODULE + " DimensionHolder") or
              (key == "STACK_GLOBAL" and previous == _DIMENSIONS_MODULE and top == "DimensionHolder")):
            value = holder
        elif key == "MARK":
            value = mark
        elif key == "TUPLE" and top is mark:
            top = empty
            continue
        elif key == "EMPTY_TUPLE":
            value = empty
        else:
            if key == "REDUCE" and previous is holder and top is empty:
                patches.append(pos)
            value = unknown
        previous, top = top, value
    return patches, False


class _DimensionInput:
    def __init__(self, stream, patches):
        self.stream = stream
        self.patches = list(reversed(patches))

    def _replace(self, data):
        end = self.stream.tell()
        if self.patches and self.patches[-1] < end:
            updated = bytearray(data)
            start = end - len(data)
            while self.patches and self.patches[-1] < end:
                offset = self.patches.pop()
                if offset >= start:
                    updated[offset - start] = pickle.NEWOBJ[0]
            return bytes(updated)
        return data

    def read(self, size=-1):
        return self._replace(self.stream.read(size))

    def readline(self, size=-1):
        return self._replace(self.stream.readline(size))

    def readinto(self, target):
        data = self.read(len(target))
        target[:len(data)] = data
        return len(data)


def _dimension_input(stream):
    if type(stream) not in (io.BytesIO, io.BufferedReader) or not stream.seekable():
        return stream, False
    start = stream.tell()

    def inspect(data):
        search = start
        # A large top-level byte/text literal contains data, never pickle instructions or module names.
        if (len(data) - start >= 65536 and data[start:start + 1] == pickle.PROTO
                and data[start + 2:start + 3] in (pickle.BINBYTES, pickle.BINUNICODE)):
            size = int.from_bytes(data[start + 3:start + 7], "little")
            if size >= 65536:
                search = start + 7 + size
        if (data.find(b"openpyxl.worksheet.dimensions", search) < 0 or data.find(b"DimensionHolder", search) < 0
                or (data.find(b")R", search) < 0 and data.find(b"(tR", search) < 0)
                or (_DIMENSIONS_MODULE in sys.modules and dimension_type() is None)):
            return stream, False
        try:
            patches, modern = _empty_dimension_constructors(stream)
        finally:
            stream.seek(start)
        return (_DimensionInput(stream, patches) if patches else stream), modern

    try:
        if type(stream) is io.BytesIO:
            return inspect(stream.getvalue())
        if type(stream.raw) is io.BytesIO:
            return inspect(stream.raw.getvalue())
        with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
            return inspect(data)
    except Exception:
        # Probing never runs reducers. Unrecognized input or streams without a descriptor need the original reader.
        return stream, False


def _restore_dimension_owners(memo, holder_type, root, expected):
    pending = {}
    worksheets = []
    worksheet = _loaded_class("openpyxl.worksheet.worksheet", "Worksheet")
    for value in chain((root,), memo.values()):
        if type(value) is worksheet:
            worksheets.append(value)
        elif type(value) is holder_type and value.default_factory is None:
            attrs = vars(value)
            owner = _bound_layout(attrs.get("worksheet"))
            if owner is not None or "worksheet" not in attrs:
                pending[id(value)] = (value, owner)
    if not pending and not expected:
        return
    for sheet in worksheets:
        for attr, method in _LAYOUT:
            candidate = vars(sheet).get(attr)
            key = id(candidate)
            if key not in pending and type(candidate) is holder_type and "worksheet" not in vars(candidate):
                pending[key] = candidate, None
            if key in pending:
                value, owner = pending[key]
                if owner is not None and (owner[0] is not sheet or owner[1] != method):
                    raise pickle.UnpicklingError("legacy dimension holder has conflicting owning worksheets or axes")
                pending[key] = value, (sheet, method)
    # Optimized pickles can omit unused memo entries. An unseen zero-argument holder has no proven owner.
    if expected > sum("worksheet" not in vars(value) for value, _ in pending.values()):
        raise pickle.UnpicklingError("legacy dimension holder has no saved owning worksheet")
    for value, owner in pending.values():
        if owner is None:
            raise pickle.UnpicklingError("legacy dimension holder has no saved owning worksheet")
        sheet, method = owner
        holder_type.__init__(value, sheet, default_factory=getattr(sheet, method))


def snapshot_resource_reader(guarded, dill_impl, closed_file_type):
    create_rlock = dill_impl._create_rlock

    def restore_rlock(count, owner, *args):
        # dill records an unlocked RLock as (0, 0). _acquire_restore((0, 0)) takes its underlying lock.
        if not args and type(count) is int and count == 0 and type(owner) is int and owner == 0:
            return RLock()
        return create_rlock(count, owner, *args)

    class Reader(guarded):
        def __init__(self, stream, *args, **kwargs):
            source, self._modern_dimensions = _dimension_input(stream)
            self._empty_dimensions = len(source.patches) if type(source) is _DimensionInput else 0
            super().__init__(source, *args, **kwargs)

        def find_class(self, module, name):
            target = super().find_class(module, name)
            if target is create_rlock:
                return restore_rlock
            if (not self._modern_dimensions and module == _DIMENSIONS_MODULE and name == "DimensionHolder"
                    and target is dimension_type()):
                self._holder_type = target
            if target is ZipFile:
                self._saw_zip_file = True
            return target

        def load(self):
            self._saw_zip_file = False
            self._holder_type = None
            expected, self._empty_dimensions = self._empty_dimensions, 0
            try:
                value = super().load()
            finally:
                self._modern_dimensions = False  # The next load may use an earlier format.
            if self._holder_type is not None:
                _restore_dimension_owners(self.memo.copy(), self._holder_type, value, expected)
            if self._saw_zip_file:
                # Inspect only actual ZipFile instances constructed by this record, including nested ones.
                for item in self.memo.copy().values():
                    if type(item) is not ZipFile:
                        continue
                    state = vars(item)
                    mode, fp = state.get("mode"), state.get("fp")
                    if type(fp) is closed_file_type and type(mode) is str and mode == "r":
                        message = "ZIP archive depends on a closed file. Reopen the source path"
                        if type(fp.name) in (str, bytes):
                            message += f" {fp.name!r}"
                        raise pickle.UnpicklingError(message + ".")
            return value

    return Reader
