"""Restore explicitly declared exception state in Prime's guarded snapshot reader."""
from __future__ import annotations

import copyreg
from functools import wraps
from inspect import signature
import pickle
import sys
from threading import Lock, local
from weakref import WeakSet


_reading = local()
_prepared = WeakSet()
_prepare_lock = Lock()


def _from_pickle(reader, caller):
    # CPython's C unpickler has no REDUCE/NEWOBJ callbacks. A Python reducer that
    # calls the same constructor has its own frame and must get the ordinary API.
    return caller.f_code is reader._dill_load_code and caller.f_locals.get("self") is reader


def _prepare(cls, fields):
    with _prepare_lock:
        if cls in _prepared:
            return
        allocate, initialize = cls.__new__, cls.__init__

        @wraps(allocate)
        def new(actual_cls, *args, **kwargs):
            error = allocate(actual_cls, *args, **kwargs)
            reader = getattr(_reading, "reader", None)
            if reader is not None and actual_cls is cls:
                caller = sys._getframe(1)
                if caller.f_code is copyreg.__newobj__.__code__:  # NEWOBJ's equivalent in protocols 0 and 1
                    caller = caller.f_back
                if _from_pickle(reader, caller):
                    reader._pending_errors.append((error, fields))
            return error

        @wraps(initialize)
        def init(error, *args, **kwargs):
            reader = getattr(_reading, "reader", None)
            if (reader is not None and type(error) is cls and len(args) == 1 and type(args[0]) is str
                    and not kwargs and _from_pickle(reader, sys._getframe(1))):
                # Legacy BaseException records supply only the message. BUILD supplies the fields next.
                BaseException.__init__(error, args[0])
            else:
                initialize(error, *args, **kwargs)

        # Older inspect versions prefer a newly defined __new__ to this class's original __init__.
        if "__new__" not in vars(cls) and "__init__" in vars(cls):
            new.__signature__ = signature(initialize)
        cls.__new__ = staticmethod(new)
        cls.__init__ = init
        _prepared.add(cls)


def snapshot_error_reader(guarded, dill):
    """Keep the real classes and all of the host reader's lookups, including its file guard."""
    class Reader(guarded):
        _dill_load_code = getattr(dill.Unpickler.load, "__code__", None)

        def find_class(self, module, name):
            cls = super().find_class(module, name)
            if type(cls) is type and issubclass(cls, Exception):
                fields = vars(cls).get("__snapshot_exception_fields__")
                if fields:
                    if (sys.implementation.name != "cpython" or self._dill_load_code is None
                            or not issubclass(dill.Unpickler, pickle.Unpickler)):
                        raise pickle.UnpicklingError("unsupported dill exception reconstruction path")
                    _prepare(cls, fields)
            return cls

        def load(self):
            previous = getattr(_reading, "reader", None)
            _reading.reader = self
            self._pending_errors = []
            try:
                value = super().load()
                for error, fields in self._pending_errors:
                    state = vars(error)
                    for name, accepted in fields.items():
                        if name not in state or not isinstance(state[name], accepted):
                            raise pickle.UnpicklingError(f"invalid saved field {name!r} for {type(error).__name__}")
                return value
            finally:
                _reading.reader = previous
                del self._pending_errors

    return Reader
