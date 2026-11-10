"""The seam between our code and the vendored Prime kernel.

Everything here is about assumptions we make about `rlm.repl` that are NOT
ours to change. The vendored file is byte-for-byte upstream, so if a future
version bump moves any of these, this file is where it surfaces — instead of
in a TypeScript integration test whose failure would say nothing about why.

Two kinds of test live here:

1. Provenance — the vendored tree still matches what PROVENANCE.md records.
2. Contract — the exact symbols and behaviours `python/bootstrap.py` binds to.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "vendor" / "prime"
PYTHON_SRC = ROOT / "python"

# Importing the vendored package would make CPython write bytecode NEXT TO the
# source — a `__pycache__/` directory inside the tree this very file asserts is
# untouched upstream. The kernel sets PYTHONDONTWRITEBYTECODE for the same
# reason; tests import it in-process, so they must say so themselves.
sys.dont_write_bytecode = True

# Same layering the kernel uses: upstream first, our compat second.
sys.path.insert(0, str(PYTHON_SRC))
sys.path.insert(0, str(PYTHON_SRC / "compat"))
sys.path.insert(0, str(VENDOR))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def recorded_hashes() -> dict[str, str]:
    """Hashes PROVENANCE.md claims for the vendored files."""
    text = (ROOT / "vendor" / "PROVENANCE.md").read_text(encoding="utf-8")
    found: dict[str, str] = {}
    for match in re.finditer(r"`(prime/[^`]+)`\s*\|\s*`([0-9a-f]{64})`", text):
        found[match.group(1)] = match.group(2)
    return found


class UpstreamCoordinates(unittest.TestCase):
    """Provenance must let someone else find the exact source, offline-checkably."""

    def setUp(self) -> None:
        self.text = (ROOT / "vendor" / "PROVENANCE.md").read_text(encoding="utf-8")

    def test_records_a_full_length_commit_sha(self) -> None:
        # A tag can be moved; a commit cannot. A short sha can collide.
        self.assertRegex(self.text, r"`ea9d9602ec0938d9e454e8963107cd85af1565c6`")

    def test_records_the_repository_url(self) -> None:
        self.assertIn("https://github.com/PrimeIntellect-ai/prime-agent", self.text)

    def test_every_permalink_is_pinned_to_the_commit(self) -> None:
        """No link may point at a moving ref."""
        links = re.findall(r"https://[^\s)]*prime-agent[^\s)]*", self.text)
        self.assertTrue(links, "provenance must carry upstream links")
        for link in links:
            # The bare repo URL is fine; anything deeper must be commit-pinned.
            if link.rstrip("/").endswith("prime-agent"):
                continue
            with self.subTest(link=link):
                self.assertIn(
                    "ea9d9602ec0938d9e454e8963107cd85af1565c6",
                    link,
                    "a link to /main or /v0.10.0 would silently drift from what we vendored",
                )

    def test_records_the_path_inside_the_repository(self) -> None:
        self.assertIn("prime-agent-runtime/src/rlm/", self.text)


class VendorIsUnmodified(unittest.TestCase):
    """The tracked upstream files must stay exactly as published.

    This is the whole point of vendoring with provenance: a local edit that
    drifts from the recorded hash makes the record a lie, and makes a future
    upgrade's diff meaningless.
    """

    def test_provenance_records_hashes(self) -> None:
        self.assertTrue(recorded_hashes(), "PROVENANCE.md must record file hashes")

    def test_vendored_files_match_their_recorded_hashes(self) -> None:
        for relative, expected in recorded_hashes().items():
            path = ROOT / "vendor" / relative
            with self.subTest(file=relative):
                self.assertTrue(path.is_file(), f"{relative} is recorded but missing")
                self.assertEqual(
                    sha256(path),
                    expected,
                    f"{relative} differs from the hash in PROVENANCE.md — either it was edited "
                    f"(vendored upstream files must not be) or the record was not updated",
                )

    def test_repl_py_still_imports_from_bash_unmodified(self) -> None:
        # Proof we did NOT patch the import away: the upstream line is intact,
        # and it is our own shim that satisfies it.
        source = (VENDOR / "rlm" / "repl.py").read_text(encoding="utf-8")
        self.assertIn("from .bash import _kill_live_handles", source)
        self.assertNotIn("dsh-python-repl patch", source, "no local patch may remain in vendored code")

    def test_vendor_contains_upstream_files_only(self) -> None:
        """Ownership is expressed by DIRECTORY, not by a list of exceptions.

        A per-file "this one is ours" note rots: the next version bump adds a
        file and the note silently goes stale. So `vendor/prime/rlm/` must
        contain nothing but what upstream shipped.
        """
        # Directories count too. The original check said `is_file()`, so a
        # `__pycache__/` the kernel wrote while importing its own vendored
        # module walked straight past the test whose whole job is catching
        # that — only .gitignore kept it out of git (found 2026-09-22).
        present = sorted(
            entry.name for entry in (VENDOR / "rlm").iterdir() if not entry.name.startswith(".")
        )
        self.assertEqual(
            present,
            ["repl.md", "repl.py"],
            "vendor/prime/rlm/ must hold upstream files only — our shims belong in python/compat/, "
            "and nothing (not even generated bytecode) may be written into it",
        )

    def test_vendor_has_no_init_so_rlm_stays_a_namespace_package(self) -> None:
        # An __init__.py in either portion would collapse the namespace package
        # and hide the other directory's modules.
        self.assertFalse((VENDOR / "rlm" / "__init__.py").exists())
        self.assertFalse((PYTHON_SRC / "compat" / "rlm" / "__init__.py").exists())

    def test_our_shim_lives_outside_vendor(self) -> None:
        shim_path = PYTHON_SRC / "compat" / "rlm" / "bash.py"
        self.assertTrue(shim_path.is_file(), "our bash shim must live in python/compat/")
        shim = shim_path.read_text(encoding="utf-8")
        self.assertIn("not upstream code", shim.lower())
        # It must expose ONLY what repl.py needs; a real bash entry point here
        # would be a permission bypass.
        self.assertNotIn("def bash(", shim)
        self.assertNotIn("class BashHandle", shim)
        self.assertIn('__all__ = ["_kill_live_handles", "_rehydrate_persistent_shells"]', shim)

    def test_rlm_really_resolves_across_both_directories(self) -> None:
        """The namespace package actually spans vendor + compat."""
        import rlm

        portions = [Path(p).resolve() for p in rlm.__path__]
        self.assertIn((VENDOR / "rlm").resolve(), portions)
        self.assertIn((PYTHON_SRC / "compat" / "rlm").resolve(), portions)

    def test_upstream_wins_when_both_portions_could_provide_a_module(self) -> None:
        # vendorRoot is first on the path, so upstream can never be shadowed.
        import rlm.repl

        self.assertEqual(Path(rlm.repl.__file__).resolve(), (VENDOR / "rlm" / "repl.py").resolve())

    def test_shim_satisfies_the_exact_import_repl_makes(self) -> None:
        from rlm.bash import _kill_live_handles, _rehydrate_persistent_shells

        self.assertIsNone(_kill_live_handles())
        self.assertIsNone(_rehydrate_persistent_shells())

    def test_shim_resolves_from_our_directory_not_vendor(self) -> None:
        import rlm.bash

        self.assertEqual(
            Path(rlm.bash.__file__).resolve(),
            (PYTHON_SRC / "compat" / "rlm" / "bash.py").resolve(),
        )

    def test_factory_shim_resolves_from_our_directory_not_vendor(self) -> None:
        import rlm.factory

        self.assertEqual(
            Path(rlm.factory.__file__).resolve(),
            (PYTHON_SRC / "compat" / "rlm" / "factory.py").resolve(),
        )

    def test_factory_shim_offers_no_factory(self) -> None:
        # repl.py reads exactly these three names; an empty action list makes
        # every factory_activity request an unknown action before it is scheduled.
        import rlm.factory

        self.assertEqual(
            rlm.factory.__all__, ["ACTIVITY_ACTIONS", "ACTIVITY_TIMEOUT_MS_CAP", "schedule_activity"]
        )
        self.assertEqual(rlm.factory.ACTIVITY_ACTIONS, ())

    def test_no_prime_native_capability_is_importable(self) -> None:
        """Only `repl` and our `bash`/`factory` shims exist under `rlm`.

        Upstream's package would also carry harness/mcp/skill; none of those
        may be reachable, or the kernel would expose capabilities that bypass
        DSH's gates.
        """
        import importlib.util

        for forbidden in ("rlm.harness", "rlm.mcp", "rlm.mcp_base", "rlm.skill"):
            with self.subTest(module=forbidden):
                self.assertIsNone(
                    importlib.util.find_spec(forbidden), f"{forbidden} must not be importable"
                )


class ReplModuleContract(unittest.TestCase):
    """Symbols `python/bootstrap.py` binds to inside the kernel."""

    def setUp(self) -> None:
        import rlm.repl as repl

        self.repl = repl

    def test_host_request_exists_and_is_awaitable(self) -> None:
        import inspect

        self.assertTrue(hasattr(self.repl, "host_request"))
        self.assertTrue(inspect.iscoroutinefunction(self.repl.host_request))

    def test_current_cell_is_a_contextvar(self) -> None:
        import contextvars

        self.assertIsInstance(self.repl._current_cell, contextvars.ContextVar)

    def test_current_cell_default_is_none_outside_a_cell(self) -> None:
        self.assertIsNone(self.repl._current_cell.get())

    def test_host_request_refuses_when_not_serving(self) -> None:
        # Fail-closed: no event loop means no host, and a silent hang would be
        # worse than an error.
        import asyncio

        async def attempt() -> str:
            try:
                await self.repl.host_request({"kind": "tool_call"})
            except RuntimeError as exc:
                return str(exc)
            return "no error"

        self.assertIn("not serving", asyncio.run(attempt()))

    def test_panel_and_error_hooks_keep_their_signatures(self) -> None:
        import inspect

        expected = {
            "_send": ["event"],
            "_compile_cell": ["code", "filename"],
            "_handle_list_names": ["req", "ns"],
            "_error_event": ["cell_id", "exc"],
        }
        for name, parameters in expected.items():
            with self.subTest(name=name):
                self.assertEqual(list(inspect.signature(getattr(self.repl, name)).parameters), parameters)

    def test_snapshot_skip_sets_bootstrap_extends_still_exist(self) -> None:
        # bootstrap.py adds the bridge's names to these at runtime, the vendored
        # file untouched; an upgrade that renames them must fail here.
        self.assertIsInstance(self.repl._ALWAYS_SKIP, set)
        self.assertIsInstance(self.repl._RESTORE_SKIP, set)

    def test_protocol_version_matches_our_bridge(self) -> None:
        # src/protocol.ts pins PROTOCOL_VERSION = 3.
        doc = (VENDOR / "rlm" / "repl.md").read_text(encoding="utf-8")
        self.assertIn("current protocol version is `3`", doc.lower().replace("the ", "the "))


class KernelProcessProtocol(unittest.TestCase):
    """End-to-end against a REAL kernel subprocess, no mocks.

    Covers the framing assumptions `src/kernel.ts` makes: one JSON object per
    line, `ready` first, `result` only for a non-None trailing expression, and
    exactly one `done` per request id.
    """

    @classmethod
    def setUpClass(cls) -> None:
        env = dict(os.environ)
        # kernel.ts 给每个内核现设这个变量；从环境里继承来的旧值可能指向
        # 已死的进程（比如从内核子进程重启过宿主），看门狗会让内核立刻退出。
        env.pop("PRIME_AGENT_KERNEL_OWNER_PID", None)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(VENDOR), str(PYTHON_SRC / "compat"), str(PYTHON_SRC)]
        )
        env["PYTHONUNBUFFERED"] = "1"
        # Mirror the real kernel: no bytecode written beside the vendored source.
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        cls.proc = subprocess.Popen(
            [sys.executable, "-m", "rlm.repl"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            cwd=str(VENDOR),
        )
        cls.ready = json.loads(cls.proc.stdout.readline())

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            cls.proc.stdin.close()
            cls.proc.wait(timeout=10)
        except Exception:
            cls.proc.kill()

    def run_cell(self, cell_id: str, code: str) -> list[dict]:
        self.proc.stdin.write(json.dumps({"type": "execute", "id": cell_id, "code": code}) + "\n")
        self.proc.stdin.flush()
        events = []
        while True:
            line = self.proc.stdout.readline()
            if not line:
                break
            event = json.loads(line)
            events.append(event)
            if event.get("event") == "done" and event.get("id") == cell_id:
                break
        return events

    def test_factory_activity_is_refused_and_the_kernel_keeps_serving(self) -> None:
        self.proc.stdin.write(json.dumps({"type": "factory_activity", "id": "f1", "action": "run"}) + "\n")
        self.proc.stdin.flush()
        events = self.run_cell("after-factory", "1 + 1")
        refusals = [e for e in events if e["event"] == "error" and e.get("ename") == "ProtocolError"]
        self.assertEqual(len(refusals), 1)
        self.assertIn("unknown factory activity action", refusals[0]["evalue"])
        self.assertEqual([e["text"] for e in events if e["event"] == "result"], ["2"])

    def test_handshake_announces_protocol_3(self) -> None:
        self.assertEqual(self.ready["event"], "ready")
        self.assertEqual(self.ready["protocol"], 3)

    def test_handshake_reports_a_python_at_or_above_our_floor(self) -> None:
        major, minor = (int(p) for p in self.ready["python"].split(".")[:2])
        self.assertGreaterEqual((major, minor), (3, 11))

    def test_every_event_is_one_json_object_per_line(self) -> None:
        events = self.run_cell("fmt", "print('a')\nprint('b')\n42")
        self.assertTrue(all(isinstance(e, dict) and "event" in e for e in events))

    def test_trailing_expression_produces_a_result_event(self) -> None:
        events = self.run_cell("t1", "1 + 1")
        results = [e for e in events if e["event"] == "result"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["text"], "2")

    def test_none_trailing_expression_produces_no_result_event(self) -> None:
        events = self.run_cell("t2", "None")
        self.assertEqual([e for e in events if e["event"] == "result"], [])

    def test_assignment_produces_no_result_event(self) -> None:
        events = self.run_cell("t3", "x = 5")
        self.assertEqual([e for e in events if e["event"] == "result"], [])

    def test_exactly_one_done_per_request(self) -> None:
        events = self.run_cell("t4", "print('x')\n7")
        self.assertEqual(len([e for e in events if e["event"] == "done"]), 1)

    def test_namespace_persists_across_requests(self) -> None:
        self.run_cell("p1", "carried = 'kept'")
        events = self.run_cell("p2", "carried")
        self.assertIn("kept", str(events))

    def test_error_carries_the_real_exception_type(self) -> None:
        events = self.run_cell("e1", "1/0")
        errors = [e for e in events if e["event"] == "error"]
        self.assertEqual(errors[0]["ename"], "ZeroDivisionError")
        done = [e for e in events if e["event"] == "done"][0]
        self.assertEqual(done["status"], "error")

    def test_top_level_return_is_a_syntax_error(self) -> None:
        events = self.run_cell("e2", "return 1")
        errors = [e for e in events if e["event"] == "error"]
        self.assertEqual(errors[0]["ename"], "SyntaxError")

    def test_bootstrap_installs_our_namespace_in_the_real_kernel(self) -> None:
        # The integration our TS tests exercise indirectly, asserted directly.
        events = self.run_cell(
            "boot",
            "import bootstrap as _b, json as _j; "
            "print(_j.dumps(_b._bootstrap(['echo'], ['bash'], 1, [])))",
        )
        payload = None
        for event in events:
            if event["event"] == "stdout" and event["text"].strip().startswith("{"):
                payload = json.loads(event["text"])
        self.assertIsNotNone(payload, "bootstrap must report its skills")
        self.assertEqual(payload["loaded"], [])
        events = self.run_cell("installed", "(type(tools.echo).__name__, 'echo' in dir(tools))")
        self.assertEqual([e["text"] for e in events if e["event"] == "result"], ["('_ToolProxy', True)"])
        events = self.run_cell(
            "local-skills",
            "print(_j.dumps(await skills.list()))\n"
            "print(_j.dumps(await skills.describe('absent')))\n"
            "print('mcp' not in globals())",
        )
        self.assertFalse(any(e["event"] == "host_request" for e in events))
        text = "".join(e.get("text", "") for e in events if e["event"] == "stdout")
        self.assertIn('"status": "ready"', text)
        self.assertIn('"status": "unknown"', text)
        self.assertIn("True", text)

    def test_bridge_reads_the_kernels_own_cell_id(self) -> None:
        # Our attribution depends on rlm.repl setting _current_cell around each
        # execute; assert that directly rather than trusting the docs.
        events = self.run_cell(
            "cellid",
            "import rlm.repl as _r; print(_r._current_cell.get())",
        )
        text = "".join(e.get("text", "") for e in events if e["event"] == "stdout")
        self.assertIn("cellid", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
