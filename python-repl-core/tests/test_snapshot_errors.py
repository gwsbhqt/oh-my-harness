"""Compatibility is local to a declared exception reconstructed by the actual snapshot reader."""
import copyreg
import inspect
import io
import pickle
import unittest

try:
    import dill
except ImportError:
    dill = None

from python_repl_core.snapshot_errors import snapshot_error_reader


class RecordError(Exception):
    __snapshot_exception_fields__ = {"code": int, "details": dict}

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.details = {}

    def __reduce__(self):
        return copyreg.__newobj__, (type(self), *self.args), self.__dict__


class SingleArgumentError(RecordError):
    def __init__(self, message):
        super().__init__(7, message)


class UndeclaredError(Exception):
    def __init__(self, code, message):
        super().__init__(message)


class Record:
    def __init__(self, factory, args, state=None):
        self.parts = (factory, args, state)

    def __reduce__(self):
        return self.parts


def user_constructor():
    return RecordError("missing code")


_signature = inspect.signature(RecordError)
_subclass_signature = inspect.signature(SingleArgumentError)


@unittest.skipIf(dill is None, "dill is an optional kernel dependency")
class SnapshotErrors(unittest.TestCase):
    def load(self, value, protocol=pickle.HIGHEST_PROTOCOL):
        reader = snapshot_error_reader(dill.Unpickler, dill)
        return reader(io.BytesIO(pickle.dumps(value, protocol=protocol))).load()

    def test_legacy_state_uses_the_real_class_and_preserves_shared_values(self):
        state = {"code": 8, "details": {"rows": [1]}, "__notes__": ["an extra note"]}
        old = Record(RecordError, ("failure",), state)
        state["cycle"] = [old]
        restored_type, error, alias, details = self.load((RecordError, old, old, state["details"]))
        self.assertIs(restored_type, RecordError)
        self.assertIs(type(error), restored_type)
        self.assertIs(error, alias)
        self.assertIs(error.cycle[0], error)
        self.assertIs(error.details, details)
        self.assertEqual((error.code, error.args, str(error), error.__notes__), (8, ("failure",), "failure", ["an extra note"]))
        with self.assertRaises(RecordError):
            raise error
        self.assertEqual(inspect.signature(RecordError), _signature)
        with self.assertRaises(TypeError):
            RecordError("missing code")
        with self.assertRaises(TypeError):
            dill.loads(pickle.dumps(old))

    def test_normal_user_calls_and_undeclared_types_keep_their_own_constructors(self):
        with self.assertRaises(TypeError):
            self.load((RecordError, Record(user_constructor, ())))
        with self.assertRaises(TypeError):
            self.load(Record(UndeclaredError, ("missing code",), {"code": 8}))
        sub = self.load((RecordError, Record(SingleArgumentError, ("valid",))))[1]
        self.assertIs(type(sub), SingleArgumentError)
        self.assertEqual(inspect.signature(SingleArgumentError), _subclass_signature)
        self.assertEqual((sub.code, sub.args), (7, ("valid",)))

    def test_incomplete_and_mistyped_old_or_new_state_rejects_the_record(self):
        current = RecordError(1, "failure")
        current.args = ("custom", 2)
        bad = RecordError(1, "failure")
        del bad.details
        for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
            with self.subTest(protocol=protocol):
                self.assertEqual(self.load(current, protocol).args, current.args)
                for value in (bad, Record(RecordError, ("failure",)), Record(RecordError, ("failure",), {"code": "wrong", "details": {}})):
                    with self.assertRaises(pickle.UnpicklingError):
                        self.load(value, protocol)

    def test_an_unknown_reader_rejects_legacy_reconstruction(self):
        reader = snapshot_error_reader(pickle.Unpickler, pickle)
        old = Record(RecordError, ("failure",), {"code": 1, "details": {}})
        with self.assertRaisesRegex(pickle.UnpicklingError, "unsupported"):
            reader(io.BytesIO(pickle.dumps(old))).load()
