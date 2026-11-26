"""Restart one live kernel through its manager, preserving the original on refusal."""
import ast
import asyncio
import gc
import tempfile
import threading
import unittest
from pathlib import Path

from agy_python_repl.manager import KernelManager
from python_repl_core.snapshot_store import open_snapshot


class KernelRestartTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.data = self.root / "data"
        self.project = self.root / "project"
        self.project.mkdir()
        self.manager = KernelManager(data_dir=self.data, skill_roots=[], project_skill_roots=[Path("skills")])
        self.addAsyncCleanup(self.manager.shutdown_all)

    async def cell(self, source, name="analysis", cwd=None):
        result = await self.manager.run_code(source, kernel=name, cwd=cwd)
        self.assertEqual(result["status"], "ok", result)
        return ast.literal_eval(result["result"]), result

    async def restart(self, name="analysis", cwd=None):
        return await self.manager.kernel_state("restart", kernel=name, cwd=cwd)

    async def test_new_code_uses_the_live_directory_and_the_original_project_skills(self):
        home = self.project
        other = self.root / "other"
        local = other / "changed in cell"
        local.mkdir(parents=True)
        skill = home / "skills" / "fixture-reader"
        module = skill / "src" / "fixture_reader"
        module.mkdir(parents=True)
        (skill / "SKILL.md").write_text("---\nname: fixture-reader\ndescription: Fixture\n---\n")
        (module / "__init__.py").write_text("IDENTITY = 'original-project'\n")
        code = local / "fixture_version.py"
        code.write_text("def current(): return 'old'\n")
        await self.cell("rows = [7]\nsummary = {'rows':rows}\nskills.fixture_reader.IDENTITY", cwd=home)
        pid, _ = await self.cell(f"os.chdir({str(local)!r})\nimport fixture_version as lib\n"
                                 "from fixture_version import current\nassert current() == 'old'\nos.getpid()", cwd=other)
        peer, _ = await self.cell("peer = 23\n(os.getpid(), peer)", name="neighbor")
        code.write_text("def current(): return 'updated'\n")
        self.manager.auto_snapshot = False  # An explicit restart must save even with automatic saving disabled.
        await self.cell("rows.append(11)\nsum(rows)")
        result = await self.restart(cwd=other)
        self.assertEqual(result["status"], "ok", result)
        self.assertTrue({"rows", "summary", "lib", "current"}.issubset(result["restored"]))
        after, _ = await self.cell("(os.getpid(), str(Path.cwd()), rows, rows is summary['rows'], "
                                   "current(), lib is sys.modules['fixture_version'], current is lib.current, "
                                   "skills.fixture_reader.IDENTITY)", cwd=other)
        self.assertNotEqual(after[0], pid)
        self.assertEqual(after[1:], (str(local), [7, 11], True, "updated", True, True, "original-project"))
        self.assertEqual((await self.cell("(os.getpid(), peer)", name="neighbor"))[0], peer)
        inactive = await self.restart("not-running")
        self.assertEqual((inactive["status"], inactive["original_kept"]), ("error", False))
        self.assertNotIn("not-running", self.manager._kernels)

    async def test_write_failure_and_skipped_value_keep_the_running_process(self):
        pid, _ = await self.cell("values = [7]\nos.getpid()", cwd=self.project)
        saved = await self.manager.kernel_state("snapshot", kernel="analysis")
        payload = Path(saved["snapshot_path"])
        files = (payload, payload.with_suffix(".manifest.json"))
        original = [path.read_bytes() for path in files]
        store = payload.resolve(strict=True).parent.parent
        self.assertTrue(store.is_relative_to(self.data) and (store / "current").is_symlink())
        # A regular file in place of the staging marker fails real publication even when tests run as root.
        blocker = store / ".publishing"
        blocker.write_text("invalid staging record")
        try:
            _, failed = await self.cell("values.append(11)\nsum(values)")
            self.assertIn("snapshot_error", failed)
            refused = await self.restart()
            self.assertTrue(refused["original_kept"], refused)
            self.assertEqual(refused["status"], "error")
            self.assertIn(blocker.name, refused["error"])
            self.assertEqual((await self.cell("values.append(13)\n(os.getpid(), sum(values))"))[0], (pid, 31))
            self.assertEqual([path.read_bytes() for path in files], original)
        finally:
            blocker.unlink()
        await self.cell("stream = (n for n in range(3))\nnext(stream)")
        refused = await self.restart()
        self.assertEqual((refused["status"], refused["original_kept"]), ("error", True), refused)
        self.assertEqual([item["name"] for item in refused["skipped"]], ["stream"])
        self.assertEqual((await self.cell("(os.getpid(), next(stream), sum(values))"))[0], (pid, 1, 31))

    async def test_partial_candidate_and_start_failure_keep_original_memory(self):
        module = self.project / "fixture_sensor.py"
        module.write_text("class Sensor:\n    value = 13\n")
        pid, _ = await self.cell("from fixture_sensor import Sensor\ninstrument = Sensor()\nos.getpid()", cwd=self.project)
        module.unlink()
        failed = await self.restart()
        self.assertEqual((failed["status"], failed["original_kept"]), ("error", True), failed)
        self.assertIn("instrument", {item["name"] for item in failed["failed"]})
        loop = asyncio.get_running_loop()
        diagnostics = []
        self.addCleanup(loop.set_exception_handler, loop.get_exception_handler())
        loop.set_exception_handler(lambda _loop, event: diagnostics.append(event["message"]))
        exits_early = self.root / "exits-before-ready"
        exits_early.write_text("#!/bin/sh\nexit 23\n")
        exits_early.chmod(0o700)
        for interpreter, message in ((self.root / "no-such-interpreter", "FileNotFoundError"),
                                     (exits_early, "Kernel process exited")):
            with self.subTest(interpreter=interpreter.name):
                self.manager.python_exe = str(interpreter)
                failed = await self.restart()
                self.assertEqual((failed["status"], failed["original_kept"]), ("error", True), failed)
                self.assertIn(message, failed["error"])
        gc.collect()
        self.assertEqual(diagnostics, [])
        self.assertEqual((await self.cell("(os.getpid(), instrument.value + 1)"))[0], (pid, 14))

    @staticmethod
    def committed_files(payload):
        manifest = payload.with_suffix(".manifest.json")
        pointer = payload.resolve().parent.parent / "current"
        return payload.read_bytes(), manifest.read_bytes(), pointer.readlink()

    async def test_refused_restart_keeps_the_previous_commit_and_live_changes(self):
        self.manager.auto_snapshot = False
        for case in ("skipped", "failed"):
            with self.subTest(case=case):
                pid, _ = await self.cell("first, second = 7, 11\nos.getpid()", case, self.project)
                saved = await self.manager.kernel_state("snapshot", kernel=case)
                payload = Path(saved["snapshot_path"])
                before = self.committed_files(payload)
                if case == "skipped":
                    setup = "extra = (n for n in range(3))"
                else:
                    setup = "class Broken:\n    def __reduce__(self): return (int, ('not-a-number',))\nextra = Broken()"
                await self.cell("first, second = 70, 110\n" + setup + "\nfirst + second", case)
                result = await self.restart(case)
                self.assertEqual((result["status"], result["original_kept"]), ("error", True), result)
                self.assertIn("extra", {v["name"] for v in result[case]})
                self.assertEqual((await self.cell("(os.getpid(), first + second)", case))[0], (pid, 180))
                self.assertEqual(self.committed_files(payload), before)
        await self.manager.shutdown_all()
        self.manager.auto_snapshot = True
        for case in ("skipped", "failed"):
            values, fresh = await self.cell("(first, second, 'extra' in globals())", case, self.project)
            self.assertEqual(values, (7, 11, False))
            self.assertEqual(fresh["restored"]["status"], "ok")

    async def test_success_publishes_the_same_serialization_as_the_verified_process(self):
        self.manager.auto_snapshot = False
        await self.cell("first, second = 7, 11\nos.getpid()", cwd=self.project)
        saved = await self.manager.kernel_state("snapshot", kernel="analysis")
        payload = Path(saved["snapshot_path"])
        before = self.committed_files(payload)
        await self.cell("first, second = 70, 110\nclass Once:\n"
                        "    def __reduce__(self):\n"
                        "        with Path('serialized').open('a') as stream: stream.write('x')\n"
                        "        return (str, (Path('serialized').read_text(),))\n"
                        "witness = Once()\nfirst + second")
        accepted = await self.restart()
        self.assertEqual(accepted["status"], "ok", accepted)
        committed = self.committed_files(payload)
        self.assertNotEqual(committed[2], before[2])
        self.assertEqual((await self.cell("(first, second, witness)"))[0], (70, 110, "x"))
        self.assertEqual((self.project / "serialized").read_text(), "x")
        await self.manager.shutdown_all()
        self.manager.auto_snapshot = True
        values, fresh = await self.cell("(first, second, witness)", cwd=self.project)
        self.assertEqual(values, (70, 110, "x"))
        self.assertEqual(fresh["restored"]["status"], "ok")

    async def test_another_reader_allows_cancellation_before_restart_publication(self):
        self.manager.auto_snapshot = False
        pid, _ = await self.cell("first, second = 7, 11\nos.getpid()", cwd=self.project)
        saved = await self.manager.kernel_state("snapshot", kernel="analysis")
        payload = Path(saved["snapshot_path"])
        before = self.committed_files(payload)
        await self.cell("first, second = 70, 110\nclass MarkRead:\n"
                        "    def __reduce__(self): return (Path.touch, (Path('candidate-read'),))\n"
                        "mark = MarkRead()\nfirst + second")

        # Reading an ordinary legacy snapshot holds a shared lock on this directory until restore finishes.
        legacy = payload.with_name("older.dill")
        meta = legacy.with_suffix(".manifest.json")
        legacy.hardlink_to(payload.resolve(strict=True))
        meta.hardlink_to(payload.with_suffix(".manifest.json").resolve(strict=True))
        held, release = threading.Event(), threading.Event()

        def read_legacy():
            with open_snapshot(legacy, meta):
                held.set()
                release.wait(5)

        reading = asyncio.create_task(asyncio.to_thread(read_legacy))
        self.assertTrue(await asyncio.to_thread(held.wait, 5))
        restarting = asyncio.create_task(self.restart())
        try:
            async with asyncio.timeout(5):
                while not (self.project / "candidate-read").is_file():
                    if restarting.done():
                        self.fail(f"restart ended before restoring: {restarting.result()}")
                    await asyncio.sleep(0.01)
                self.assertEqual((await self.cell("6 * 7", "unrelated"))[0], 42)
                self.assertEqual(self.committed_files(payload), before)
                restarting.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await restarting
        finally:
            release.set()
            if not restarting.done():
                restarting.cancel()
                await asyncio.gather(restarting, return_exceptions=True)
            await reading
        self.assertEqual((await self.cell("(os.getpid(), first, second)"))[0], (pid, 70, 110))
        self.assertEqual(self.committed_files(payload), before)

    async def test_cancelled_private_write_keeps_the_previous_commit(self):
        self.manager.auto_snapshot = False
        pid, _ = await self.cell("first, second = 7, 11\nos.getpid()", cwd=self.project)
        saved = await self.manager.kernel_state("snapshot", kernel="analysis")
        payload = Path(saved["snapshot_path"])
        before = self.committed_files(payload)
        await self.cell("first, second = 70, 110\nclass Slow:\n"
                        "    def __reduce__(self):\n"
                        "        import time\n"
                        "        Path('saving').touch()\n"
                        "        while not Path('release').is_file(): time.sleep(0.02)\n"
                        "        return (int, (3,))\n"
                        "value = Slow()\nfirst + second")
        restarting = asyncio.create_task(self.restart())
        try:
            async with asyncio.timeout(10):
                while not (self.project / "saving").is_file():
                    if restarting.done():
                        self.fail(f"restart ended before saving: {restarting.result()}")
                    await asyncio.sleep(0.01)
                restarting.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await restarting
        finally:
            (self.project / "release").touch()
            if not restarting.done():
                restarting.cancel()
                await asyncio.gather(restarting, return_exceptions=True)
        self.assertEqual((await self.cell("(os.getpid(), first, second)"))[0], (pid, 70, 110))
        self.assertEqual(self.committed_files(payload), before)
        self.assertEqual(list(payload.parent.glob(".restart-*")), [])

    async def test_preexisting_partial_restore_preserves_its_snapshot_and_live_updates(self):
        module = self.project / "fixture_dialect.py"
        module.write_text("class Measure: pass\n")
        await self.cell("from fixture_dialect import Measure\nvalue = 7\nvalue", cwd=self.project)
        saved = await self.manager.kernel_state("snapshot", kernel="analysis")
        payload = Path(saved["snapshot_path"])
        files = (payload, payload.with_suffix(".manifest.json"))
        await self.manager.shutdown_all()
        original = [p.read_bytes() for p in files]
        module.unlink()
        pid, result = await self.cell("value += 2\nos.getpid()", cwd=self.project)
        self.assertEqual(result["restored"]["status"], "partial")
        refused = await self.restart()
        self.assertEqual((refused["status"], refused["original_kept"]), ("error", True), refused)
        self.assertEqual((await self.cell("(os.getpid(), value)"))[0], (pid, 9))
        self.assertEqual([p.read_bytes() for p in files], original)

    async def test_cancelled_candidate_keeps_ownership_and_unblocks_queued_work(self):
        self.manager.auto_snapshot = False
        module = self.project / "fixture_slow.py"
        module.write_text("class Sensor: pass\n")
        pid, _ = await self.cell("first, second = 7, 11\nos.getpid()", cwd=self.project)
        saved = await self.manager.kernel_state("snapshot", kernel="analysis")
        payload = Path(saved["snapshot_path"])
        before = self.committed_files(payload)
        await self.cell("from fixture_slow import Sensor\nfirst, second, number = 70, 110, 17\nnumber")
        module.write_text("from pathlib import Path\nimport time\nPath('restoring').touch()\ntime.sleep(30)\nclass Sensor: pass\n")
        restart = asyncio.create_task(self.restart())
        try:
            async with asyncio.timeout(10):
                while not (self.project / "restoring").is_file():
                    if restart.done():
                        self.fail(f"restart ended before restoring: {restart.result()}")
                    await asyncio.sleep(0.01)
            queued = asyncio.create_task(self.cell("number += 1\n(os.getpid(), number)"))
            contender = KernelManager(data_dir=self.data, skill_roots=[], project_skill_roots=[])
            self.addAsyncCleanup(contender.shutdown_all)
            with self.assertRaisesRegex(RuntimeError, "in use"):
                await contender.run_code("1", kernel="analysis", cwd=self.project)
            self.assertFalse(queued.done())
            self.assertEqual((await self.cell("6 * 7", name="separate"))[0], 42)
            restart.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await restart
            self.assertEqual((await queued)[0], (pid, 18))
            self.assertEqual((await self.cell("(os.getpid(), Sensor.__name__, first, second)"))[0], (pid, "Sensor", 70, 110))
            self.assertEqual(self.committed_files(payload), before)
        finally:
            if not restart.done():
                restart.cancel()
                await asyncio.gather(restart, return_exceptions=True)
        await self.manager.shutdown_all()
        self.manager.auto_snapshot = True
        values, reopened = await self.cell("(first, second, 'Sensor' in globals())", cwd=self.project)
        self.assertEqual(values, (7, 11, False))
        self.assertEqual(reopened["restored"]["status"], "ok")
