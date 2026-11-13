"""Hints for the interface guesses that fail cells most (evolve I-044) and the read line count (I-065).

Each case runs the original failing shape as a real cell (`<cell-N>` source in linecache), so the
hint is built from the same traceback position the kernel sees.
"""
import asyncio
import linecache
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import ast  # noqa: E402

import cell_errors  # noqa: E402
import dsh_kernel  # noqa: E402
import skills  # noqa: E402

_cells = iter(range(10_000, 20_000))


def run_cell(source: str, **names) -> BaseException:
    """Run `source` as a kernel cell would (top-level await allowed) and return what it raised."""
    filename = f"<cell-{next(_cells)}>"
    linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
    code = compile(source, filename, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    namespace = {"__name__": "__main__", **names}

    async def go():
        result = eval(code, namespace)
        if asyncio.iscoroutine(result):
            await result

    try:
        asyncio.run(go())
    except Exception as exc:  # noqa: BLE001
        return exc
    raise AssertionError("the cell did not fail")


def hint(source: str, **names) -> str | None:
    return cell_errors.exception_hint(run_cell(source, **names))


def sync_skill():
    """A skill module whose functions are synchronous, like skills.sync_up."""
    module = types.ModuleType("demo_sync")

    def status(repo="."):
        return {"ok": True, "repos": []}

    module.status = status
    namespace = skills._SkillsNamespace()
    namespace._put("demo_sync", module)
    return namespace


async def fetch():
    return {"text": "x"}


class Snap:
    def find(self, role=None, name=None):
        return None


class AwaitingSyncResults(unittest.TestCase):
    def test_await_on_a_synchronous_skill_call_says_to_drop_await(self):
        text = hint("r = await skills.demo_sync.status()\n", skills=sync_skill())
        self.assertIn("`skills.demo_sync.status` is a plain (synchronous) function", text)
        self.assertIn("already returned a dict, so remove the `await`", text)

    def test_await_on_a_nested_tool_result(self):
        nested = dsh_kernel._wrap_nested({"a": {"b": 1}})
        self.assertIn("`r['a']` is already a dict", hint("x = await r['a']\n", r=nested))

    def test_attribute_taken_before_awaiting_is_a_precedence_slip(self):
        text = hint("x = await fetch().__class__\n", fetch=fetch)
        self.assertIn("(await fetch()).__class__", text)


class UnawaitedCoroutines(unittest.TestCase):
    def test_indexing_a_coroutine_says_where_the_await_goes(self):
        self.assertIn("write `(await fetch())['text']`", hint("x = fetch()['text']\n", fetch=fetch))

    def test_attribute_on_a_coroutine(self):
        self.assertIn("write `(await fetch()).get`", hint("x = fetch().get('text')\n", fetch=fetch))


class TextOrListUsedAsDict(unittest.TestCase):
    def test_get_on_text(self):
        text = hint("r = {'stdout': '{\"a\": 1}'}\nr['stdout'].get('a')\n")
        self.assertIn("`r['stdout']` is text (a str of 8 characters", text)
        self.assertIn("json.loads", text)

    def test_get_on_a_list_of_dicts_names_the_item_keys(self):
        text = hint("rows = [{'id': 1, 'name': 'a'}]\nrows.get('id')\n")
        self.assertIn("`rows` is a list of 1 item; its items are dicts with keys 'id', 'name'", text)

    def test_string_and_list_indexed_by_a_key(self):
        self.assertIn("`s` is text (a str)", hint("s = 'abc'\ns['key']\n"))
        self.assertIn("`rows` is a list of 2 items", hint("rows = [{'id': 1}, {'id': 2}]\nrows['id']\n"))


class UnknownParameters(unittest.TestCase):
    def test_method_lists_its_real_parameters(self):
        text = hint("snap = Snap()\nsnap.find(idx=1)\n", Snap=Snap)
        self.assertIn("takes find(role=None, name=None)", text)

    def test_skill_function_called_with_too_many_arguments(self):
        text = hint("skills.demo_sync.status('.', True)\n", skills=sync_skill())
        self.assertIn("`skills.demo_sync.status` takes status(repo='.')", text)

    def test_a_property_is_not_run_again_to_build_the_hint(self):
        calls = []

        class Page:
            @property
            def click(self):
                calls.append(1)
                return lambda selector: None

        exc = run_cell("page = Page()\npage.click(selector='a', force=True)\n", Page=Page)
        self.assertEqual(len(calls), 1)
        self.assertIsNone(cell_errors.exception_hint(exc))
        self.assertEqual(len(calls), 1)

    def test_a_receiver_that_is_itself_a_call_is_not_evaluated(self):
        self.assertIsNone(hint("Snap().find(idx=1)\n", Snap=Snap))


class GuessedKeys(unittest.TestCase):
    def test_plain_dict_lists_keys_and_the_likely_one(self):
        text = hint("res = {'exitCode': 0, 'stdout': ''}\nres['exit_code']\n")
        self.assertIn("its keys are 'exitCode', 'stdout'. Did you mean 'exitCode'?", text)
        self.assertIn("Did you mean 'jobId'?", hint("job = {'jobId': 'j1', 'kind': 'bash'}\njob['id']\n"))

    def test_tool_result_key_error_names_the_likely_key(self):
        result = dsh_kernel._wrap_nested({"exitCode": 0, "stdout": {"text": ""}})
        with self.assertRaises(KeyError) as caught:
            result["exit_code"]
        self.assertIn("did you mean 'exitCode'?", str(caught.exception))

    def test_user_mapping_types_are_left_alone(self):
        class Rows(dict):
            pass

        self.assertIsNone(hint("r = Rows(a=1)\nr['b']\n", Rows=Rows))


class ImportFromSkills(unittest.TestCase):
    def test_from_skills_import_says_to_use_the_namespace(self):
        exc = run_cell("from skills import sync_up\n")
        self.assertIsInstance(exc, ImportError)
        self.assertIn("use `skills.sync_up` directly", cell_errors.exception_hint(exc))


class UnrelatedErrors(unittest.TestCase):
    def test_get_no_hint(self):
        self.assertIsNone(hint("1 / 0\n"))
        self.assertIsNone(hint("int('x')\n"))
        self.assertIsNone(hint("d = {}\nd[1]\n"))


class ReadOffsetLineCount(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_uses_the_hosts_count_not_one_more(self):
        # 2026-11-04 evolve I-065: the host said (44 lines), the hint said 45.
        path = self.dir / "notes.md"
        path.write_text("x\n" * 44)
        text = cell_errors.tool_hint(f'offset 45 is out of range for "{path}" (44 lines)')
        self.assertIn("The file has 44 lines; pass an offset from 1 to 44.", text)

    def test_counts_like_the_host_when_the_message_has_no_count(self):
        (self.dir / "a").write_text("x\ny\n")
        (self.dir / "b").write_text("x\ny")
        (self.dir / "c").write_text("")
        self.assertIn("has 2 lines", cell_errors.tool_hint(f'offset 9 is out of range for "{self.dir}/a"'))
        self.assertIn("has 2 lines", cell_errors.tool_hint(f'offset 9 is out of range for "{self.dir}/b"'))
        self.assertIn("The file is empty", cell_errors.tool_hint(f'offset 2 is out of range for "{self.dir}/c" (0 lines)'))


class SlicingADict(unittest.TestCase):
    def test_slicing_a_skills_describe_result_points_at_the_instructions(self):
        # Field shape 2026-11-07..12: `d = await skills.describe("sync_up")` then `print(d[:4000])`.
        described = {"items": [{"id": "sync_up", "status": "candidate", "instructions": "# sync-up"}]}
        text = hint("d = described\nprint(d[:4000])\n", described=described)
        self.assertIn("`d` is a dict, not text or a list, so it cannot be sliced; its keys are 'items'", text)
        self.assertIn("`d['items'][0]['instructions'][:N]`", text)

    def test_slicing_another_dict_names_its_first_key(self):
        self.assertIn("`r['stdout']`", hint("r = {'stdout': {}, 'exitCode': 0}\nr[:10]\n"))


class JsonThatIsNotJson(unittest.TestCase):
    def test_tail_of_truncated_output(self):
        # Field shape 2026-11-10: bash kept only the tail of a large JSON reply; stdout.truncated was True.
        text = hint("import json\njson.loads(tail)\n", tail='n":null,"Layout":null}]}')
        self.assertIn("not JSON from its first character: it starts 'n\":null", text)
        self.assertIn("stdout.truncated is True", text)

    def test_empty_text(self):
        self.assertIn("is empty", hint("import json\njson.loads('')\n"))

    def test_cut_off_text(self):
        self.assertIn("cut off", hint("import json\njson.loads('{\"a\": \"abc')\n"))

    def test_json_lines(self):
        self.assertIn("more than one JSON value", hint("import json\njson.loads('{}\\n{}')\n"))


class NextWithoutDefault(unittest.TestCase):
    def test_top_level_next_names_the_cell_line(self):
        exc = run_cell("import asyncio\nawait asyncio.sleep(0)\nrow = next(x for x in [] if x)\n")
        self.assertIsInstance(exc, RuntimeError)
        text = cell_errors.exception_hint(exc)
        self.assertRegex(text, r"<cell-\d+> line 3: `row = next\(x for x in \[\] if x\)`")
        self.assertIn("next(iterator, None)", text)


class RestoredFunctionSource(unittest.TestCase):
    def test_could_not_get_source_explains_the_restore(self):
        text = cell_errors.exception_hint(OSError("could not get source code"))
        self.assertIn("restored from the snapshot", text)
        self.assertIn("repl.describe", text)


class GoneJob(unittest.TestCase):
    def test_unknown_job_says_why_it_is_gone(self):
        # The host's message verbatim (dsh-jobs-local JOB_NOT_FOUND).
        text = cell_errors.tool_hint("unknown job bash-78f3a785375d438d")
        self.assertIn("DSH restart", text)
        self.assertIn("before deciding to run it again", text)


if __name__ == "__main__":
    unittest.main()
