"""用独立 callable 验证命令边界，不依赖任何技能业务。"""
import importlib.util
import io
import json
import sys
import types
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from typing import Literal

spec = importlib.util.spec_from_file_location("shared_cli", Path(__file__).parents[1] / "agentkit/cli.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


def sample(name: str, *, count: int = 1, enabled: bool = False,
           rows: list[tuple[str, int]] | None = None, mode: Literal["a", "b"] = "a"):
    return {"name": name, "count": count, "enabled": enabled, "rows": rows, "mode": mode}


class AdapterTests(unittest.TestCase):
    def call(self, argv, target=sample):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli.main(prog="test-tool", actions={"sample": target}, argv=argv)
        return code, out.getvalue(), err.getvalue()

    def test_help_includes_parameters_and_json_contract(self):
        code, out, err = self.call(["sample", "--help"])
        self.assertEqual(code, 0)
        for flag in ("--input", "--name", "--count", "--enabled", "--rows", "--mode"):
            self.assertIn(flag, out)
        self.assertEqual(err, "")

    def test_plain_strings_and_explicit_false(self):
        code, out, err = self.call(["sample", "--name", "null", "--count", "3", "--enabled", "false"])
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(json.loads(out), {"name": "null", "count": 3, "enabled": False, "rows": None, "mode": "a"})

    def test_string_literal_option_takes_plain_text(self):
        code, out, err = self.call(["sample", "--name", "x", "--mode", "b"])
        self.assertEqual((code, err, json.loads(out)["mode"]), (0, "", "b"))
        def optional(mode: Literal["1", "2"] | None = None):
            return mode
        code, out, err = self.call(["sample", "--mode", "2"], optional)
        self.assertEqual((code, err, json.loads(out)), (0, "", "2"))

    def test_input_merges_distinct_options_and_nested_types(self):
        code, out, err = self.call(["sample", "--input", '{"name":"中文","rows":[["x",2]]}', "--enabled"])
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(json.loads(out)["rows"], [["x", 2]])
        self.assertTrue(json.loads(out)["enabled"])

    def test_rejects_bad_arguments_before_call(self):
        bad = [[], ["sample"], ["sample", "--name", "x", "--count", "1.5"],
               ["sample", "--input", '[]'], ["sample", "--input", '{"name":"x","unknown":1}'],
               ["sample", "--input", '{"name":"x","count":true}'],
               ["sample", "--input", '{"name":"x","rows":[["x","2"]]}'],
               ["sample", "--input", '{"name":"x","name":"y"}'],
               ["sample", "--name", "x", "--name", "y"],
               ["sample", "--name", "x", "--input", '{"name":"y"}'],
               ["sample", "--name", "x", "--mode", "c"],
               ["sample", "--name", "x", "--count", "NaN"],
               ["sample", "--na", "x"]]
        for argv in bad:
            with self.subTest(argv=argv):
                code, out, err = self.call(argv)
                self.assertEqual(code, 2)
                self.assertEqual(out, "")
                self.assertTrue(json.loads(err)["message"])

    def test_async_callable_manifest_and_path_serialization(self):
        class Result:
            manifest = {"path": Path("test.txt"), "values": (1, 2)}
        class Callable:
            async def __call__(self, count: int = 2):
                return Result()
        code, out, err = self.call(["sample"], Callable())
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(json.loads(out), {"path": "test.txt", "values": [1, 2]})

    def test_exception_and_unserializable_result_fail_without_stdout(self):
        def raises():
            raise RuntimeError("真实异常")
        for target in (raises, lambda: object(), lambda: float("nan")):
            code, out, err = self.call(["sample"], target)
            self.assertEqual(code, 1)
            self.assertEqual(out, "")
            self.assertTrue(json.loads(err)["error"])

    def test_callable_diagnostics_do_not_corrupt_json(self):
        def target():
            print("处理中")
            return {"value": 1}
        code, out, err = self.call(["sample"], target)
        self.assertEqual((code, json.loads(out)), (0, {"value": 1}))
        self.assertIn("处理中", err)

    def test_positional_only_and_keyword_only(self):
        def target(name: str, count: int = 2, /, *, suffix: str = "!"):
            return name * count + suffix
        code, out, err = self.call(["sample", "--name", "x", "--suffix", "?"], target)
        self.assertEqual((code, err, json.loads(out)), (0, "", "xx?"))

    def test_module_discovery_excludes_imports_and_classes(self):
        module = types.ModuleType("fixture")
        exec("def public(): return 1\nclass Class: pass\n", module.__dict__)
        module.imported = sample
        self.assertEqual(list(cli.discover(module)), ["public"])

    def test_module_callable_is_discovered(self):
        class CallableModule(types.ModuleType):
            def __call__(self, name: str):
                return name
        module = CallableModule("fixture")
        self.assertIs(cli.discover(module)["run"], module)


if __name__ == "__main__":
    unittest.main()
