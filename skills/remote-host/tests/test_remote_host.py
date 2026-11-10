"""Offline tests for remote-host: no network, no remote host.

Remote behaviour is exercised by running the generated shell LOCALLY under a
throwaway $HOME — a job, a wait, a manifest are the same bash on either side.
Run:  python3 -m unittest discover -s tests -v   (from the skill directory)
"""

import argparse
import io
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path[:0] = [str(SCRIPTS.parent / "src"), str(SCRIPTS.parents[1] / "_shared")]

from agentkit.remote import pins, reach, ssh  # noqa: E402
from remote_host.commands import basic, config, core, doctor, fanout, jobs, onboard, ready, shot, transfer  # noqa: E402


class TempHome(unittest.TestCase):
    """Every test gets its own $HOME and state dir."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / ".ssh").mkdir()
        (self.home / ".ssh" / "config").write_text("Host worker mini alpha h\n")
        self.env = mock.patch.dict(os.environ, {"HOME": str(self.home),
                                                "XDG_STATE_HOME": str(self.home / "state"),
                                                "REMOTE_HOST_NO_LOG": "1"})
        self.env.start()
        ssh.PROXY["on"] = False

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def bash(self, script, timeout=60, **kw):
        return subprocess.run(["bash", "-s"], input=script.encode(), capture_output=True,
                              timeout=timeout, env=dict(os.environ), **kw)


def ns(**kw):
    return argparse.Namespace(**kw)


class WindowsRun(TempHome):
    def test_powershell_payload_is_stdin_and_agent_forwarding_is_disabled(self):
        payload = "Write-Output \"中文 '$value'\""
        args = ns(host="alpha", interp="powershell", cwd="C:\\a'b", command=[payload])
        with mock.patch.object(basic.subprocess, "run", return_value=ns(returncode=37)) as run:
            self.assertEqual(basic.cmd_run(args), 37)
        argv = run.call_args.args[0]
        self.assertIn("-a", argv)
        self.assertEqual(run.call_args.kwargs["input"], payload.encode())
        self.assertNotIn(payload, argv[-1])
        import base64
        encoded = re.search(r"-EncodedCommand ([A-Za-z0-9+/=]+)", argv[-1]).group(1)
        bootstrap = base64.b64decode(encoded).decode("utf-16-le")
        self.assertIn("where.exe pwsh.exe", argv[-1])
        self.assertIn("if errorlevel 1 (powershell.exe", argv[-1])
        self.assertIn("Set-Location -LiteralPath 'C:\\a''b'", bootstrap)

    def test_pwsh_uses_powershell_7_and_disables_agent_forwarding(self):
        args = ns(host="alpha", interp="pwsh", cwd=None, command=["$PSVersionTable.PSVersion"])
        with mock.patch.object(basic.subprocess, "run", return_value=ns(returncode=0)) as run:
            self.assertEqual(basic.cmd_run(args), 0)
        argv = run.call_args.args[0]
        self.assertIn("-a", argv)
        self.assertTrue(argv[-1].startswith("pwsh.exe "))

    def test_powershell_rejects_proxy_and_dependencies(self):
        args = ns(host="alpha", interp="powershell", cwd=None, command=["echo hi"], with_=["pkg"])
        with mock.patch.object(basic.subprocess, "run") as run:
            self.assertEqual(basic.cmd_run(args), 2)
            run.assert_not_called()


class PosixRun(TempHome):
    def test_with_packages_reach_uv_unquoted(self):
        bin_dir = self.home / "bin"
        bin_dir.mkdir()
        (bin_dir / "uv").write_text('#!/bin/sh\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\n')
        (bin_dir / "python3").write_text("#!/bin/sh\n")
        for f in bin_dir.iterdir():
            f.chmod(0o755)
        args = ns(host="alpha", interp="python", cwd=None, command=["print(1)"], with_=["pandas>=2,rich"])
        with mock.patch.object(basic, "run_remote", return_value=0) as remote:
            self.assertEqual(basic.cmd_run(args), 0)
        env = {**os.environ, "PATH": f"{bin_dir}:/usr/bin:/bin"}
        r = subprocess.run(["bash", "-s"], input=remote.call_args.args[1].encode(), capture_output=True, timeout=60, env=env)
        out = r.stdout.decode()
        self.assertIn("[pandas>=2]", out, r.stderr.decode())
        self.assertIn("[rich]", out)
        self.assertNotIn("'", out)


# ── pins ─────────────────────────────────────────────────────────────────────

class DoctorAuth(TempHome):
    def test_source_rejection_does_not_recommend_replacing_keys(self):
        # The same publickey error occurs when AllowUsers rejects an IPv6 source.
        for family_name, family in (("inet", socket.AF_INET), ("inet6", socket.AF_INET6),
                                    ("any", socket.AF_UNSPEC)):
            with self.subTest(family=family_name):
                address = "198.51.100.3" if family_name == "inet" else "fe80::1%en0"
                conf = {"hostname": "alpha.local", "port": "22", "addressfamily": family_name}
                out = io.StringIO()
                with (mock.patch.object(doctor, "ssh_config", return_value=conf),
                      mock.patch.object(doctor, "relay", return_value=None),
                      mock.patch.object(socket, "getaddrinfo", return_value=[(0, 0, 0, "", (address, 22))]) as lookup,
                      mock.patch.object(doctor, "tcp_probe", return_value=("open", "SSH-2.0-test")) as tcp,
                      mock.patch.object(doctor.subprocess, "run", side_effect=[
                          ns(stdout="known"), ns(returncode=255, stderr="Permission denied (publickey).")]) as run,
                      redirect_stdout(out)):
                    self.assertEqual(doctor.cmd_doctor(ns(host="alpha")), 1)
                lookup.assert_called_once_with("alpha.local", 22, family=family, proto=socket.IPPROTO_TCP)
                tcp.assert_called_once_with(address, 22, 5, banner=True)
                self.assertIn("ControlMaster=no", run.call_args.args[0])
                self.assertIn("ControlPath=none", run.call_args.args[0])
                self.assertIn("AllowUsers", out.getvalue())
                self.assertIn("既有磁盘密钥", out.getvalue())
                self.assertNotIn("ssh-copy-id", out.getvalue())


class PerHostPins(TempHome):
    def use(self, **kw):
        base = dict(name=None, interp=None, cwd=None, clear=False, proxy=False, no_proxy=False)
        base.update(kw)
        with redirect_stdout(io.StringIO()), mock.patch.object(sys, "stderr", io.StringIO()):
            return pins.cmd_use(ns(tool="remote-host", **base))

    def test_directory_is_remembered_per_host(self):
        self.use(name="worker", cwd="/data00/tmp/example-home/botmux")
        self.use(name="mini", cwd="~/workspace")
        self.use(name="worker")
        self.assertEqual(core.cwd_of(ns(host="mini")), "~/workspace")
        self.assertEqual(core.cwd_of(ns()), "/data00/tmp/example-home/botmux")

    def test_other_host_does_not_inherit_pinned_directory(self):
        # The field bug: -H mini ran `cd a host-specific directory` pinned for worker.
        self.use(name="worker", cwd="/data00/tmp/example-home/botmux")
        self.assertIsNone(core.cwd_of(ns(host="mini")))

    def test_interpreter_is_per_host_too(self):
        self.use(name="worker", interp="fish")
        self.assertEqual(core.interp_of(ns(host="worker"))[0], "fish")
        self.assertEqual(core.interp_of(ns(host="mini"))[0], "bash")

    def test_clear_one_host_keeps_the_others(self):
        self.use(name="mini", cwd="~/a")
        self.use(name="worker", cwd="/b")
        self.use(name="mini", clear=True)
        pin = pins.read_pin("remote-host")
        self.assertNotIn("mini", pin["hosts"])
        self.assertEqual(pin["hosts"]["worker"]["cwd"], "/b")

    def test_status_shows_pinned_effective_target_before_ssh_without_changing_pin(self):
        self.use(name="alpha")
        out = io.StringIO()
        with (mock.patch("remote_host.commands.basic.ssh_config", return_value={"hostname": "198.51.100.11"}),
              mock.patch("agentkit.remote.reach.local_addr_towards", return_value="203.0.113.49"),
              mock.patch("remote_host.commands.basic.run_remote", return_value=255) as remote,
              mock.patch("remote_host.commands.basic.subprocess.run", return_value=ns(stdout="")),
              redirect_stdout(out)):
            from remote_host.commands import basic
            self.assertEqual(basic.cmd_status(ns(host=None, interp=None, cwd=None)), 255)
        self.assertIn("host:    alpha  (pinned)", out.getvalue())
        self.assertIn("target:  198.51.100.11", out.getvalue())
        self.assertIn("network: local route uses 203.0.113.49", out.getvalue())
        self.assertEqual(pins.read_pin("remote-host")["host"], "alpha")
        remote.assert_called_once()

    def test_proxy_pin(self):
        self.use(name="alpha", proxy=True)
        self.assertTrue(core.host_pin("alpha").get("proxy"))
        self.use(name="alpha", no_proxy=True)
        self.assertFalse(core.host_pin("alpha").get("proxy"))


class OnboardProbe(unittest.TestCase):
    def test_port_open_uses_the_reach_fallback(self):
        with mock.patch.object(reach, "tcp_probe", return_value=("open", "SSH-2.0-x")):
            self.assertEqual(onboard.port_open("198.51.100.11"), "SSH-2.0-x")
        with mock.patch.object(reach, "tcp_probe", return_value=("timeout", "timed out")):
            self.assertIsNone(onboard.port_open("198.51.100.11"))


# ── screenshot ───────────────────────────────────────────────────────────────

# This machine's three displays (2026-09-23): 5K main, portrait on the left,
# the laptop on the right — points, origin bottom-left, scale 2.
FRAMES = [(0, 0, 2560, 1440, 2), (2560, 0, 1728, 1117, 2), (-1440, -516, 1440, 2560, 2)]


class ScreenCrop(unittest.TestCase):
    def test_boxes_match_a_real_capture(self):
        # A full capture of these displays is 11456x5120; the crops below were
        # checked against it by eye on the real machine.
        self.assertEqual(shot.crop_box(FRAMES, 0), (1208, 2880, 2880, 5120))
        self.assertEqual(shot.crop_box(FRAMES, 1), (1854, 8000, 2234, 3456))
        self.assertEqual(shot.crop_box(FRAMES, 2), (0, 0, 5120, 2880))

    def test_unknown_geometry_means_no_crop(self):
        self.assertIsNone(shot.crop_box(FRAMES, 3))
        self.assertIsNone(shot.crop_box([(0, 0, 100, 100, 2), (100, 0, 100, 100, 1)], 0))

    def test_the_remote_calculation_agrees(self):
        lines = "\n".join(",".join(str(v) for v in f) for f in FRAMES) + "\n"
        for i in range(3):
            out = subprocess.run([sys.executable, "-c", shot._CROP_PY, str(i)], input=lines,
                                 capture_output=True, text=True).stdout.split()
            self.assertEqual(tuple(int(v) for v in out), shot.crop_box(FRAMES, i))


class Screenshot(TempHome):
    """The host-side script against a stand-in Snipaste: a CLI that writes an
    image, and a same-named process playing the running app."""

    NAME = "rhfakesnip"

    def setUp(self):
        super().setUp()
        macos = self.home / "Fake.app" / "Contents" / "MacOS"
        macos.mkdir(parents=True)
        self.cli = macos / self.NAME
        # remote-host finds the running app by its full path in the process table.
        self.daemon = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", str(self.cli)])

    def tearDown(self):
        self.daemon.kill()
        self.daemon.wait()
        super().tearDown()

    def fake(self, body):
        self.cli.write_text("#!/bin/bash\n" + body)
        self.cli.chmod(0o755)

    def writes_png(self, w=400, h=200):
        # snip --full -o <file> …: make a real PNG with sips from a PPM.
        self.fake(f'while [ "$1" != -o ]; do shift; done; out="$2"\n'
                  f'printf "P6 {w} {h} 255\\n" > "$out.ppm"; head -c {w * h * 3} /dev/zero >> "$out.ppm"\n'
                  f'sips -s format png "$out.ppm" --out "$out" >/dev/null 2>&1; rm -f "$out.ppm"\n')

    def run_shot(self, **kw):
        r = self.bash(shot.shot_script(snipaste=str(self.cli), **kw), timeout=60)
        lines = [l for l in r.stdout.decode().splitlines() if l.startswith(shot.MARK)]
        return r, (lines[-1][len(shot.MARK):] if lines else None)

    def size(self, path):
        out = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path], capture_output=True, text=True).stdout
        return tuple(int(v) for v in re.findall(r"pixel\w+: (\d+)", out))

    @unittest.skipUnless(sys.platform == "darwin", "sips is macOS-only")
    def test_capture_is_shrunk_to_a_jpeg(self):
        self.writes_png(400, 200)
        r, path = self.run_shot(max_edge=100)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(path.endswith(".jpg"))
        self.assertEqual(self.size(path), (100, 50))
        self.assertFalse(os.path.exists(path[:-4] + ".png"))

    @unittest.skipUnless(sys.platform == "darwin", "sips is macOS-only")
    def test_png_keeps_full_resolution(self):
        self.writes_png(400, 200)
        r, path = self.run_shot(png=True)
        self.assertTrue(path.endswith(".png"))
        self.assertEqual(self.size(path), (400, 200))

    def test_missing_snipaste_says_how_to_install(self):
        self.cli = self.home / "Nope.app" / "Contents" / "MacOS" / "Snipaste"
        r, path = self.run_shot()
        self.assertEqual(r.returncode, 127)
        self.assertIn("brew install --cask snipaste", r.stderr.decode())
        self.assertIsNone(path)

    def test_no_image_names_the_likely_causes(self):
        self.fake("exit 0\n")
        r, path = self.run_shot()
        self.assertEqual(r.returncode, 1)
        self.assertIn("Screen Recording", r.stderr.decode())
        self.assertIsNone(path)

    def test_a_cli_that_never_returns_is_bounded(self):
        # Snipaste without Screen Recording: `snip --block` never answers.
        self.fake("sleep 600\n")
        started = time.time()
        r, path = self.run_shot()
        self.assertEqual(r.returncode, 1)
        self.assertLess(time.time() - started, 40)
        self.assertIn("Screen Recording", r.stderr.decode())

    @unittest.skipUnless(sys.platform == "darwin", "sips is macOS-only")
    def test_flat_capture_is_flagged_but_returned(self):
        self.writes_png(400, 200)  # all black: what a capture without the permission looks like
        r, path = self.run_shot()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIsNotNone(path)
        self.assertIn("one flat colour", r.stderr.decode())


# ── fan-out ──────────────────────────────────────────────────────────────────

class FanOut(unittest.TestCase):
    def test_strip_host_removes_every_spelling(self):
        self.assertEqual(fanout.strip_host(["-H", "a,b", "run", "--table", "ls", "-l"]), ["run", "ls", "-l"])
        self.assertEqual(fanout.strip_host(["--host=a,b", "-Ha", "run", "x"]), ["run", "x"])

    def test_stdin_is_read_only_when_the_command_is_absent(self):
        # An agent's stdin can be an open pipe that never closes.
        self.assertFalse(fanout.reads_stdin(["run", "uptime"]))
        self.assertTrue(fanout.reads_stdin(["run"]))
        self.assertTrue(fanout.reads_stdin(["run", "--table"]))
        self.assertFalse(fanout.reads_stdin(["doctor"]))

    def test_duplicate_hosts_keep_separate_columns(self):
        self.assertEqual(fanout.unique_labels(["a", "b", "a"]), ["a", "b", "a#2"])

    def test_table_marks_rows_that_differ(self):
        table = fanout.render_table(["cask=16\nshell=fish\n", "cask=17\nshell=fish\n"], ["alpha", "mini"])
        lines = table.splitlines()
        self.assertTrue(lines[1].startswith("≠") and "cask" in lines[1])
        self.assertTrue(lines[2].startswith("  ") and "shell" in lines[2])

    def test_missing_key_shows_dash(self):
        self.assertIn("-", fanout.render_table(["a=1\n", "b=2\n"], ["x", "y"]).splitlines()[1])

    def test_chinese_text_uses_terminal_column_width(self):
        table = fanout.render_table(["app=中文\nx=1\n", "app=英文\nx=1\n"], ["mini", "alpha"])
        self.assertIn("中文  英文", table)
        self.assertIsNone(fanout.render_table(["app=" + "中" * 31], ["mini"]))

    def test_long_multilingual_value_falls_back_without_guessing_equality(self):
        long = "中文应用名/Applications/Very Long Directory/" + "A" * 85
        self.assertIsNone(fanout.render_table([f"apps={long}\n", f"apps={long}\n"], ["mini", "alpha"]))

        outputs = [f"apps={long}\nnot-a-key from mini\n", f"apps={long}\nnot-a-key from alpha\n"]
        fake = [subprocess.CompletedProcess([], 0, outputs[0].encode(), b""),
                subprocess.CompletedProcess([], 1, outputs[1].encode(), b"install failed")]
        stdout, stderr = io.StringIO(), io.StringIO()
        with (mock.patch.object(fanout.subprocess, "run", side_effect=fake),
              redirect_stdout(stdout), mock.patch.object(sys, "stderr", stderr)):
            self.assertEqual(fanout.fan_out(["status"], ["mini", "alpha"], True), 1)
        for original in outputs:
            self.assertIn(original.rstrip("\n"), stdout.getvalue())
        self.assertNotIn("≠ apps", stdout.getvalue())
        self.assertIn("[alpha] install failed", stderr.getvalue())
        self.assertIn("mini=0  alpha=1", stderr.getvalue())

    def test_fan_out_child_killed_by_signal_is_a_failure(self):
        fake = [subprocess.CompletedProcess([], 0, b"", b""), subprocess.CompletedProcess([], -9, b"", b"")]
        with (mock.patch.object(fanout.subprocess, "run", side_effect=fake),
              redirect_stdout(io.StringIO()), mock.patch.object(sys, "stderr", io.StringIO())):
            self.assertEqual(fanout.fan_out(["status"], ["mini", "alpha"], False), 137)

    def test_parse_kv_keeps_repeats(self):
        self.assertEqual(core.parse_kv("var=A\nvar=B\nnoise\n"), {"var": ["A", "B"]})


# ── jobs, run for real under a temp $HOME ────────────────────────────────────

class Jobs(TempHome):
    spec = core.INTERPRETERS["bash"]

    def start(self, name, body, progress=None, every=1):
        return self.bash(jobs.job_start_script(name, self.spec, body, progress, every, [], None))

    def test_options_after_the_name_are_options(self):
        # REMAINDER used to swallow them: `-t 3` waited the default 600s.
        a = jobs.take_job_opts(ns(command=["-t", "3", "--progress", "du", "--every=5", "make", "-j4"],
                                  timeout=600, progress=None, every=30, lines=40))
        self.assertEqual((a.timeout, a.progress, a.every, a.command), (3, "du", 5, ["make", "-j4"]))
        b = jobs.take_job_opts(ns(command=["--", "-t", "x"], timeout=600, progress=None, every=30, lines=40))
        self.assertEqual((b.timeout, b.command), (600, ["-t", "x"]))

    def test_bad_name_is_refused(self):
        with self.assertRaises(SystemExit):
            jobs.job_name("a b")

    def test_start_returns_at_once_and_wait_gets_the_exit_code(self):
        t0 = time.time()
        self.assertEqual(self.start("j1", "sleep 1; echo out; echo err >&2; exit 7").returncode, 0)
        self.assertLess(time.time() - t0, 3)
        done = self.bash(jobs.job_wait_script("j1", 20, False, 10))
        self.assertEqual(done.returncode, 7)
        self.assertIn(b"out", done.stdout)
        self.assertIn(b"err", done.stdout)

    def test_wait_timeout_is_124_and_job_keeps_running(self):
        self.start("j2", "sleep 30")
        self.assertEqual(self.bash(jobs.job_wait_script("j2", 1, False, 5)).returncode, 124)
        self.assertIn(b"running", self.bash(jobs.job_list_script()).stdout)
        self.bash(jobs.job_kill_script("j2"))
        self.assertIn(b"exited 143", self.bash(jobs.job_list_script()).stdout)

    def test_a_running_name_is_not_reused(self):
        self.start("j3", "sleep 30")
        self.assertEqual(self.start("j3", "echo again").returncode, 2)
        self.bash(jobs.job_kill_script("j3"))

    def test_progress_lines_and_output_both_survive(self):
        # Regression: `>` vs the sampler's `>>` overwrote each other's lines.
        self.start("j4", "for i in 1 2 3; do echo step$i; sleep 1; done", progress="echo tick", every=1)
        out = self.bash(jobs.job_wait_script("j4", 20, True, 50)).stdout.decode()
        for want in ("step1", "step2", "step3", "[progress"):
            self.assertIn(want, out)

    def test_follow_flag_after_the_name(self):
        a = jobs.take_job_opts(ns(command=["--follow", "-t", "30", "--", "make"], timeout=None,
                                  progress=None, every=30, lines=40))
        self.assertEqual((a.follow, a.timeout, a.command), (True, 30, ["make"]))

    def cmd(self, action, name, command, **kw):
        """cmd_job with every remote script run by a local bash; returns (code, output)."""
        out = []

        def local(host, script, capture=False):
            r = self.bash(script)
            out.append(r.stdout.decode() + r.stderr.decode())
            return r.returncode

        base = dict(action=action, name=name, command=command, progress=None, every=30, lines=40,
                    timeout=None, follow=False, host="h", interp=None, cwd=None, with_=None)
        args = ns(**{**base, **kw})
        with mock.patch.object(jobs, "run_remote", side_effect=local), mock.patch.object(core, "read_pin", return_value={}):
            code = jobs.cmd_job(args)
        return code, "".join(out), args

    def test_start_follow_is_one_call_ending_with_the_jobs_exit_code(self):
        # Field report 2026-09-23: jobs were started, then a background shell
        # was wrapped around `job follow` to get notified — or a sleep loop.
        code, out, args = self.cmd("start", "jf", ["echo first; sleep 1; echo second; exit 3"],
                                   follow=True)
        self.assertEqual(code, 3)
        self.assertIn("first", out)
        self.assertIn("second", out)
        self.assertIn("job jf exited 3", out)
        self.assertEqual(args.timeout, jobs.FOLLOW_TIMEOUT)

    def test_shell_symbols_as_separate_argv_are_rejected_before_remote_call(self):
        for symbol in ("&&", "|", ";"):
            with self.subTest(symbol=symbol), mock.patch.object(jobs, "run_remote") as remote:
                with self.assertRaisesRegex(SystemExit, "literal arguments.*script on stdin"):
                    self.cmd("start", "bad", ["brew", "install", "a", symbol, "brew", "install", "b"])
                remote.assert_not_called()
        code, out, _ = self.cmd("start", "script", ["printf '%s\n' '&&'"], follow=True)
        self.assertEqual(code, 0)
        self.assertIn("&&", out)

    def test_pipeline_exit_codes_require_explicit_pipefail(self):
        cases = (("false | tail -n 1", 0),
                 ("set -o pipefail\nfalse | tail -n 1", 1),
                 ("set -o pipefail\nprintf 'ok\n' | grep missing", 1),
                 ("printf 'ok\n' | grep missing; test $? -eq 1", 0),
                 ("false; exit $?", 1))
        for i, (script, expected) in enumerate(cases):
            with self.subTest(script=script):
                code, _, _ = self.cmd("start", f"pipe{i}", [script], follow=True)
                self.assertEqual(code, expected)

    def test_failed_install_substitute_preserves_exit_and_error(self):
        code, out, _ = self.cmd("start", "install-failed",
                                ["bash", "-c", "echo installation failed >&2; exit 23"], follow=True)
        self.assertEqual(code, 23)
        self.assertIn("installation failed", out)
        self.assertIn("job install-failed exited 23", out)

    def test_plain_start_still_returns_at_once(self):
        t0 = time.time()
        code, out, args = self.cmd("start", "jp", ["sleep", "5"])
        self.assertEqual(code, 0)
        self.assertLess(time.time() - t0, 3)
        self.assertEqual(args.timeout, jobs.WAIT_TIMEOUT)
        self.bash(jobs.job_kill_script("jp"))

    def test_kill_takes_the_whole_tree(self):
        self.start("j5", "sleep 60 & sleep 60 & wait")
        time.sleep(0.5)
        root_pid = (self.home / ".cache/remote-host/jobs/j5/pid").read_text().strip()
        pending, children = [root_pid], []
        while pending:
            parent = pending.pop()
            found = subprocess.run(["pgrep", "-P", parent], capture_output=True)
            self.assertIn(found.returncode, (0, 1), found.stderr)
            descendants = found.stdout.decode().split()
            children.extend(descendants)
            pending.extend(descendants)
        self.assertTrue(children, "the fixture must start child processes")
        killed = self.bash(jobs.job_kill_script("j5"))
        self.assertEqual(killed.returncode, 0, killed.stderr)
        time.sleep(0.5)
        for child in children:
            with self.assertRaises(ProcessLookupError, msg=f"job child {child} survived"):
                os.kill(int(child), 0)


# ── wait / app ───────────────────────────────────────────────────────────────

class Wait(TempHome):
    def test_port_ready(self):
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen()
        port = srv.getsockname()[1]
        try:
            self.assertEqual(self.bash(ready.wait_script(port=str(port), timeout=5)).returncode, 0)
        finally:
            srv.close()

    def test_timeout_is_124(self):
        self.assertEqual(self.bash(ready.wait_script(file=str(self.home / "never"), timeout=1, every=1)).returncode, 124)

    def test_file_appears_and_goes(self):
        f = self.home / "flag"
        threading.Timer(1, f.touch).start()
        self.assertEqual(self.bash(ready.wait_script(file=str(f), timeout=10, every=1)).returncode, 0)
        threading.Timer(1, f.unlink).start()
        self.assertEqual(self.bash(ready.wait_script(file=str(f), gone=True, timeout=10, every=1)).returncode, 0)

    def test_nothing_to_wait_for_is_an_error(self):
        with self.assertRaises(SystemExit):
            ready.wait_script()


class AppLogs(TempHome):
    """`remote-host app logs`: find where an app logs even when no directory carries its name."""

    def make_app(self, name="Tiny Tool", exe="Tiny Tool", bid="dev.gizmo.tiny"):
        contents = self.home / "Applications" / f"{name}.app" / "Contents"
        contents.mkdir(parents=True)
        import plistlib
        (contents / "Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": exe, "CFBundleIdentifier": bid}))

    def run_logs(self, name="Tiny Tool"):
        r = self.bash(ready.app_logs_script(name, since=1, lines=5), timeout=150)
        return r.returncode, r.stdout.decode() + r.stderr.decode()

    @unittest.skipUnless(sys.platform == "darwin", "macOS app layout")
    def test_logs_found_through_the_bundle_id_words(self):
        # Like Clash Party → ~/Library/Application Support/mihomo-party/logs.
        self.make_app()
        logs = self.home / "Library" / "Application Support" / "gizmo-data" / "logs"
        logs.mkdir(parents=True)
        (logs / "main.log").write_text("started\nlistening\n[ERROR] open /tmp/x.sock: EACCES\nidle\n")
        storage = logs.parent / "Local Storage" / "leveldb"
        storage.mkdir(parents=True)
        (storage / "000017.log").write_bytes(b"\x00\x01binary error\x00")
        (logs.parent / "unrelated.bin").write_bytes(b"x")
        code, out = self.run_logs()
        self.assertEqual(code, 0, out)
        self.assertIn("gizmo-data/logs/main.log", out)
        self.assertIn("EACCES", out)
        self.assertNotIn("leveldb", out)
        self.assertIn("'gizmo'", out)

    @unittest.skipUnless(sys.platform == "darwin", "macOS app layout")
    def test_a_log_without_errors_shows_its_last_lines(self):
        self.make_app()
        logs = self.home / "Library" / "Logs" / "Tiny Tool"
        logs.mkdir(parents=True)
        (logs / "run.log").write_text("\n".join(f"line {i}" for i in range(10)) + "\n")
        code, out = self.run_logs()
        self.assertIn("line 9", out)
        self.assertIn("no error lines", out)

    def test_missing_app_is_named(self):
        code, out = self.run_logs("Nowhere")
        self.assertNotEqual(code, 0)
        self.assertIn("no Nowhere.app", out)


class App(TempHome):
    """osascript/open/pgrep/pkill replaced by stubs that flip a marker file."""

    def setUp(self):
        super().setUp()
        stubs = self.home / "bin"
        stubs.mkdir()
        run = self.home / "running"
        self.run = run
        (stubs / "pgrep").write_text(f'#!/bin/sh\n[ -f {run} ] && echo 4242\n[ -f {run} ]\n')
        (stubs / "open").write_text(f"#!/bin/sh\ntouch {run}\n")
        # A polite app quits on the AppleScript request …
        (stubs / "osascript").write_text(f"#!/bin/sh\nrm -f {run}\n")
        (stubs / "pkill").write_text(f"#!/bin/sh\nrm -f {run}; echo pkill >> {self.home}/log\n")
        for s in stubs.iterdir():
            s.chmod(0o755)
        os.environ["PATH"] = f"{stubs}:{os.environ['PATH']}"

    def test_start_waits_for_the_process(self):
        done = self.bash(ready.app_script("start", "Clash Party", timeout=5))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(b"running (pids 4242", done.stdout)

    def test_stop_asks_nicely_first(self):
        self.run.touch()
        self.assertEqual(self.bash(ready.app_script("stop", "Clash Party", timeout=5)).returncode, 0)
        self.assertFalse((self.home / "log").exists(), "a polite app must not be pkill'ed")

    def test_stop_escalates_when_quit_is_ignored(self):
        (self.home / "bin" / "osascript").write_text("#!/bin/sh\ntrue\n")
        self.run.touch()
        done = self.bash(ready.app_script("stop", "Clash Party", timeout=1))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("pkill", (self.home / "log").read_text())

    def test_status_of_a_stopped_app_is_1(self):
        self.assertEqual(self.bash(ready.app_script("status", "Zed")).returncode, 1)


# ── manifest / verify / copy ─────────────────────────────────────────────────

class Transfer(TempHome):
    def tree(self, root):
        root.mkdir(parents=True)
        (root / "sub" / "deep").mkdir(parents=True)
        (root / "a.txt").write_text("hello\n")
        (root / "sub" / "deep" / "c d.txt").write_text("with space\n")
        os.symlink("a.txt", root / "link to a")
        with open(root / "sparse.img", "wb") as f:
            f.seek(64 << 20)
            f.write(b"tail")
        return root

    def manifest(self, path, quick=False):
        done = self.bash(ssh.PRELUDE + transfer.manifest_script(str(path), quick))
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.decode().splitlines()

    def test_manifest_lists_files_dirs_links_with_spaces(self):
        m = self.manifest(self.tree(self.home / "src"))
        s = transfer.summarize(m)
        self.assertEqual((s["files"], s["dirs"], s["links"]), (3, 2, 1))
        self.assertIn("L\ta.txt\tlink to a", m)
        self.assertTrue(any(line.endswith("\tsub/deep/c d.txt") for line in m))

    def test_quick_manifest_has_no_hashes(self):
        m = self.manifest(self.tree(self.home / "src"), quick=True)
        self.assertTrue(all(line.split("\t")[1] == "-" for line in m if line.startswith("F")))

    def test_compare_finds_every_kind_of_difference(self):
        a = self.manifest(self.tree(self.home / "a"))
        b_root = self.tree(self.home / "b")
        (b_root / "a.txt").write_text("changed\n")
        (b_root / "sub" / "deep" / "c d.txt").unlink()
        (b_root / "new").write_text("x")
        missing, extra, changed = transfer.compare(a, self.manifest(b_root))
        self.assertEqual((missing, extra, changed), (["sub/deep/c d.txt"], ["new"], ["a.txt"]))

    def test_sockets_and_fifos_are_left_out(self):
        # git's fsmonitor--daemon.ipc crashed the manifest (2026-09-23).
        root = self.tree(self.home / "src")
        os.mkfifo(root / "fifo")
        sock = socket.socket(socket.AF_UNIX)
        sock.bind(str(root / "sub" / "s.ipc"))
        try:
            m = self.manifest(root)
        finally:
            sock.close()
        self.assertFalse(any(line.endswith(("\tfifo", "\tsub/s.ipc")) for line in m))
        self.assertEqual(transfer.summarize(m)["files"], 3)

    def test_identical_trees_share_a_digest(self):
        a = self.manifest(self.tree(self.home / "a"))
        b = self.manifest(self.tree(self.home / "b"))
        self.assertEqual(transfer.summarize(a)["digest"], transfer.summarize(b)["digest"])

    def copy(self, src, dst, **kw):
        base = dict(src=str(src), dst=str(dst), replace=False, no_verify=False, quick=False,
                    no_compress=False, every=0)
        base.update(kw)
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), mock.patch.object(sys, "stderr", err):
            try:
                code = transfer.cmd_copy(ns(**base))
            except SystemExit as e:
                code = e.code
        log = out.getvalue() + err.getvalue()
        if isinstance(code, str):  # sys.exit("remote-host: …") carries its message as the code
            log, code = log + code, 1
        return code, log

    def test_copy_is_staged_verified_and_keeps_holes(self):
        src = self.tree(self.home / "src")
        (self.home / "dst").mkdir()
        code, log = self.copy(src, self.home / "dst")
        self.assertEqual(code, 0, log)
        self.assertIn("verified — identical", log)
        placed = self.home / "dst" / "src" / "sparse.img"
        self.assertEqual(placed.stat().st_size, (64 << 20) + 4)
        self.assertLess(placed.stat().st_blocks * 512, 8 << 20, "a sparse file must stay sparse")
        self.assertFalse(any(p.name.startswith(".remote-host-incoming") for p in (self.home / "dst").iterdir()))

    def test_existing_target_is_refused_then_moved_aside_with_replace(self):
        src = self.tree(self.home / "src")
        (self.home / "dst" / "src").mkdir(parents=True)
        code, log = self.copy(src, self.home / "dst")
        self.assertNotEqual(code, 0)
        self.assertIn("--replace", log)
        code, log = self.copy(src, self.home / "dst", replace=True)
        self.assertEqual(code, 0, log)
        self.assertTrue(any(".remote-host-old-" in p.name for p in (self.home / "dst").iterdir()))

    def test_split_loc(self):
        self.assertEqual(transfer.split_loc("mini:~/x"), ("mini", "~/x"))
        self.assertEqual(transfer.split_loc("user@198.18.0.5:/a"), ("user@198.18.0.5", "/a"))
        self.assertEqual(transfer.split_loc("/local/path"), (None, "/local/path"))
        self.assertEqual(transfer.split_loc("mini:"), ("mini", "~"))

    def test_mac_to_linux_drops_appledouble_but_mac_to_mac_keeps_xattrs(self):
        # Caught by --verify on the first live Mac → Linux copy: `._name` files.
        sender, _, _ = transfer.copy_scripts("/x", "/y", "x", "bsdtar", "gnu", False)
        self.assertIn("--no-mac-metadata", sender)
        self.assertIn("COPYFILE_DISABLE=1", sender)
        sender, receiver, _ = transfer.copy_scripts("/x", "/y", "x", "bsdtar", "bsdtar", False)
        self.assertNotIn("--no-mac-metadata", sender)
        self.assertIn("tar -S", receiver)


# ── onboard ──────────────────────────────────────────────────────────────────

class Onboard(TempHome):
    def test_guess_user_from_mac_names(self):
        self.assertEqual(onboard.guess_user("alexdeMac-alpha"), "alex")
        self.assertEqual(onboard.guess_user("alex的Mac alpha"), "alex")
        self.assertEqual(onboard.guess_user("bihaiqingtiandeMac-mini.local"), "bihaiqingtian")
        self.assertEqual(onboard.guess_user("Ann's MacBook Pro"), "ann")
        self.assertIsNone(onboard.guess_user("L6D14YLF21"))
        self.assertIsNone(onboard.guess_user("示例用户的Mac mini"))

    def test_parse_dns_sd_and_avahi(self):
        dns = ("Browsing for _ssh._tcp.local.\n"
               " 1:38:12.882  Add        3   1 local.               _ssh._tcp.           示例用户的Mac mini\n"
               " 1:38:12.882  Add        2  16 local.               _ssh._tcp.           示例用户的Mac mini\n")
        self.assertEqual(onboard.parse_browse(dns, "_ssh._tcp"), ["示例用户的Mac mini"])
        avahi = "+;en0;IPv4;alpha;_ssh._tcp;local\n"
        self.assertEqual(onboard.parse_browse(avahi, "_ssh._tcp"), ["alpha"])

    def test_askpass_answers_without_a_tty(self):
        done = onboard.with_askpass("s3cret", ["sh", "-c", '"$SSH_ASKPASS"'], capture_output=True, text=True)
        self.assertEqual(done.stdout.strip(), "s3cret")

    def mux(self, have=(), brew=None, sudo=False, apt=False):
        """Run MUX_SCRIPT locally with only stub tools on PATH. `brew` lists what
        `brew install` can install; `apt` makes `sudo -n apt-get install` work."""
        bin_ = Path(self.home) / "stubs"
        bin_.mkdir()
        def stub(name, body):
            (bin_ / name).write_text("#!/bin/sh\n" + body + "\n")
            (bin_ / name).chmod(0o755)
        for tool in have:
            stub(tool, "exit 0")
        if brew is not None:
            stub("brew", f'case " {" ".join(brew)} " in *" $2 "*) printf "#!/bin/sh\\n" > "{bin_}/$2"; '
                         f'chmod +x "{bin_}/$2";; *) exit 1;; esac')
        stub("sudo", 'if [ "$1" = -n ]; then shift; fi; ' + ('exec "$@"' if sudo else "exit 1"))
        if apt:
            stub("apt-get", f'[ "$1" = install ] && printf "#!/bin/sh\\n" > "{bin_}/$3"; '
                            f'[ "$1" = install ] && chmod +x "{bin_}/$3"; exit 0')
        done = subprocess.run(["/bin/sh", "-c", onboard.MUX_SCRIPT], capture_output=True, text=True,
                              env={"PATH": f"{bin_}:/usr/bin:/bin", "HOME": str(self.home)})
        return onboard.parse_mux(done.stdout)

    def test_mux_keeps_existing_tmux(self):
        self.assertEqual(self.mux(have=["tmux"], brew=["tmux"]), ("tmux", False))

    def test_mux_installs_tmux_with_brew(self):
        self.assertEqual(self.mux(brew=["tmux"]), ("tmux", True))

    def test_mux_installs_tmux_through_passwordless_sudo(self):
        self.assertEqual(self.mux(sudo=True, apt=True), ("tmux", True))

    def test_mux_reports_none_when_nothing_installs(self):
        self.assertEqual(self.mux(brew=[], sudo=False, apt=True), (None, False))

    def test_alias_is_appended_once(self):
        cfg = self.home / ".ssh" / "config"
        cfg.write_text("Host worker\n    HostName 198.18.0.1\n")
        self.assertTrue(onboard.append_alias("alpha", "198.51.100.11", "alex"))
        self.assertFalse(onboard.append_alias("alpha", "198.51.100.11", "alex"))
        text = cfg.read_text()
        self.assertEqual(text.count("Host alpha"), 1)
        self.assertIn("User alex", text)

    def test_port_open_reads_the_banner(self):
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen()
        port = srv.getsockname()[1]
        def serve():
            conn, _ = srv.accept()
            with conn:
                conn.sendall(b"SSH-2.0-test\r\n")
        threading.Thread(target=serve, daemon=True).start()
        try:
            self.assertEqual(onboard.port_open("127.0.0.1", port), "SSH-2.0-test")
        finally:
            srv.close()
        self.assertIsNone(onboard.port_open("127.0.0.1", 1, timeout=1))


class Cli(unittest.TestCase):
    def test_help_lists_every_subcommand(self):
        out = subprocess.run([sys.executable, str(SCRIPTS / "remote-host"), "--help"],
                             capture_output=True, text=True).stdout
        for cmd in ("run", "send", "job", "wait", "app", "doctor", "manifest",
                    "verify", "copy", "discover", "onboard", "use"):
            self.assertIn(cmd, out)

    def test_every_module_imports_cleanly(self):
        for mod in (config, core, fanout, jobs, onboard, ready, transfer):
            self.assertTrue(mod.__doc__, f"{mod.__name__} needs a module docstring")

    def test_argv_words_keep_their_quoting(self):
        self.assertEqual(core.read_body(["uptime -p"]), "uptime -p")
        self.assertEqual(core.read_body(["bash", "-c", "for i in 1 2; do echo $i; done"]),
                         "bash -c 'for i in 1 2; do echo $i; done'")




class SafetyRegression(TempHome):
    def test_copy_dangling_destination_is_not_followed(self):
        src = self.home / 'item'
        src.write_text('new')
        dst = self.home / 'dst'; dst.mkdir()
        (dst/'item').symlink_to('missing')
        args = ns(src=str(src), dst=str(dst), replace=False, no_verify=False,
                  quick=False, no_compress=True, every=0)
        with self.assertRaisesRegex(SystemExit, 'exists'):
            transfer.cmd_copy(args)
        self.assertEqual(os.readlink(dst/'item'), 'missing')

    def test_copy_stage_is_unique_and_existing_backup_aborts(self):
        one = transfer.copy_scripts('/x', str(self.home), 'x', 'gnu', 'gnu', False)[2]
        two = transfer.copy_scripts('/x', str(self.home), 'x', 'gnu', 'gnu', False)[2]
        self.assertNotEqual(one, two)
        stage = self.home/'.remote-host-incoming-token'; stage.mkdir()
        (stage/'x').write_text('new')
        (self.home/'x').write_text('old')
        (self.home/'x.remote-host-old-token').write_text('existing backup')
        result = self.bash(transfer.finalize_script(str(stage), str(self.home), 'x', True))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.home/'x').read_text(), 'old')
        self.assertEqual((stage/'x').read_text(), 'new')

    def test_copy_file_concurrent_finalize_has_one_winner(self):
        scripts = []
        for token in ('one','two'):
            stage = self.home/('.remote-host-incoming-'+token); stage.mkdir()
            (stage/'x').write_text(token)
            scripts.append(transfer.finalize_script(str(stage),str(self.home),'x',False))
        with __import__('concurrent.futures').futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(self.bash,scripts))
        self.assertEqual(sorted(r.returncode for r in results),[0,1])
        self.assertIn((self.home/'x').read_text(),('one','two'))
        self.assertEqual(len(list(self.home.glob('.remote-host-incoming-*'))),1)

    def test_copy_dangling_source_survives(self):
        src = self.home/'link'; src.symlink_to('absent')
        dst = self.home/'dst'; dst.mkdir()
        result = transfer.cmd_copy(ns(src=str(src),dst=str(dst),replace=False,no_verify=False,
                                     quick=False,no_compress=True,every=0))
        self.assertEqual(result,0)
        self.assertEqual(os.readlink(dst/'link'),'absent')

    def test_get_put_preserves_stow_symlink_and_verifies(self):
        from remote_host.commands import basic
        src = self.home/'source'; src.write_bytes(b'new\x00content')
        real = self.home/'config-repo'/'config'; real.parent.mkdir(); real.write_text('old')
        link = self.home/'config'; link.symlink_to('config-repo/config')
        self.assertEqual(basic.transfer_file(None,str(src),None,str(link)),0)
        self.assertTrue(link.is_symlink())
        self.assertEqual(os.readlink(link),'config-repo/config')
        self.assertEqual(real.read_bytes(),src.read_bytes())

    def receive(self,path,body,expected,guard=''):
        from remote_host.commands import basic
        return subprocess.run(['bash','-c',basic.file_script(basic.FILE_RECEIVE_PY,str(path),'source',expected,guard)],
                              input=body,capture_output=True)

    def test_file_short_transfer_and_guard_leave_original(self):
        import hashlib
        target = self.home/'target'; target.write_text('old')
        bad = self.receive(target,b'short',hashlib.sha256(b'long expected').hexdigest())
        self.assertNotEqual(bad.returncode,0)
        self.assertIn(b'SHA-256',bad.stderr)
        self.assertEqual(target.read_text(),'old')
        guarded = self.receive(target,b'new',hashlib.sha256(b'new').hexdigest(),'0'*64)
        self.assertNotEqual(guarded.returncode,0)
        self.assertEqual(target.read_text(),'old')
        self.assertFalse(list(self.home.glob('.remote-host-file-incoming-*')))

    def test_file_target_changed_during_transfer_is_refused(self):
        from remote_host.commands import basic
        import hashlib
        target = self.home/'target'; target.write_text('old')
        proc = subprocess.Popen(['bash','-c',basic.file_script(basic.FILE_RECEIVE_PY,str(target),'source',hashlib.sha256(b'new').hexdigest(),'')],
                                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        deadline = time.monotonic()+5
        while not list(self.home.glob('.remote-host-file-incoming-*')) and time.monotonic()<deadline:
            time.sleep(.01)
        self.assertTrue(list(self.home.glob('.remote-host-file-incoming-*')))
        target.write_text('changed by another writer')
        out, err = proc.communicate(b'new',timeout=5)
        self.assertNotEqual(proc.returncode,0,err)
        self.assertIn(b'changed during transfer',err)
        self.assertEqual(target.read_text(),'changed by another writer')

    def test_file_directory_dangling_and_hardlink_refused(self):
        from remote_host.commands import basic
        src = self.home/'source'; src.write_text('new')
        self.assertNotEqual(basic.transfer_file(None,str(self.home),None,str(src)),0)
        dangling = self.home/'link'; dangling.symlink_to('missing')
        self.assertNotEqual(basic.transfer_file(None,str(src),None,str(dangling)),0)
        linked = self.home/'linked'; os.link(src,linked)
        self.assertNotEqual(basic.transfer_file(None,str(src),None,str(linked)),0)
        self.assertEqual(linked.read_text(),'new')

    def test_jobs_dot_dot_and_symlink_escape_refused(self):
        for name in ('.','..'):
            with self.assertRaises(SystemExit): jobs.job_name(name)
        root = self.home/'.cache/remote-host/jobs'; root.mkdir(parents=True)
        outside = self.home/'outside'; outside.mkdir(); (outside/'keep').write_text('safe')
        (root/'escape').symlink_to(outside)
        result = self.bash(jobs.job_start_script('escape',core.INTERPRETERS['bash'],'echo bad',None,1,[],None))
        self.assertNotEqual(result.returncode,0)
        self.assertEqual((outside/'keep').read_text(),'safe')

    def test_jobs_concurrent_start_owns_exactly_one_payload(self):
        script = jobs.job_start_script('race',core.INTERPRETERS['bash'],'sleep 1; exit 9',None,1,[],None)
        with __import__('concurrent.futures').futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(self.bash,[script,script]))
        self.assertEqual(sorted(r.returncode for r in results),[0,2])
        self.assertEqual(self.bash(jobs.job_wait_script('race',5,False,10)).returncode,9)

    def test_jobs_lost_and_unrelated_pid_cannot_be_killed(self):
        d = self.home/'.cache/remote-host/jobs/stale'; d.mkdir(parents=True)
        unrelated = subprocess.Popen(['sleep','30'])
        try:
            (d/'pid').write_text(str(unrelated.pid)); (d/'identity').write_text('not this process')
            self.assertEqual(self.bash(jobs.job_wait_script('stale',1,False,10)).returncode,125)
            self.assertNotEqual(self.bash(jobs.job_kill_script('stale')).returncode,0)
            self.assertIsNone(unrelated.poll())
        finally:
            unrelated.terminate(); unrelated.wait(timeout=5)

    def test_send_busy_rejects_before_writing_payload_and_uuid_isolation(self):
        from remote_host.commands import session
        session.with_names()
        lock = self.home/'.cache/remote-host/agent.busy'; lock.mkdir(parents=True)
        marker = self.home/'.cache/remote-host/agent.sh'; marker.write_text('original payload')
        scripts=[]
        args=ns(host='h',session='agent',interp='bash',cwd=None,command=['echo new'],
                with_=None,detach=True,timeout='1',lines=0)
        with mock.patch.object(session,'find_mux',return_value='MUX=true\n'), mock.patch.object(session,'run_remote',side_effect=lambda h,s:scripts.append(s) or self.bash(s).returncode):
            self.assertEqual(session.cmd_send(args),2)
            self.assertEqual(session.cmd_send(args),2)
        self.assertEqual(marker.read_text(),'original payload')
        self.assertNotEqual(scripts[0],scripts[1])
        self.assertEqual(len(list(lock.parent.glob('agent.*.sh'))),0)

    def test_send_reset_writes_cancelled_and_removes_busy(self):
        from remote_host.commands import session
        lock=self.home/'.cache/remote-host/agent.busy'; lock.mkdir(parents=True)
        rc=self.home/'.cache/remote-host/agent.call.rc'; (lock/'rc').write_text(str(rc))
        args=ns(host='h',session='agent')
        with mock.patch.object(session,'find_mux',return_value='MUX=true\n'), mock.patch.object(session,'run_remote',side_effect=lambda h,s:self.bash(s).returncode):
            self.assertEqual(session.cmd_reset(args),0)
        self.assertEqual(rc.read_text(),'143\n')
        self.assertFalse(lock.exists())

    def test_tmp_inherited_nonmember_group_is_preserved_without_chown(self):
        from remote_host.commands import basic
        with tempfile.TemporaryDirectory(prefix='remote-host-group-regression-', dir='/tmp') as directory:
            root=Path(directory)
            source=root/'source'; source.write_text('new')
            target=root/'original'; target.write_text('old')
            link=root/'linked'; link.symlink_to('original')
            before=target.stat()
            if before.st_gid in os.getgroups()+[os.getegid()]:
                self.skipTest('this filesystem does not inherit a nonmember group; real /tmp shape unavailable')
            self.assertEqual(before.st_uid,os.geteuid())
            self.assertEqual(basic.transfer_file(None,str(source),None,str(link)),0)
            after=target.stat()
            self.assertEqual((before.st_uid,before.st_gid,before.st_mode),(after.st_uid,after.st_gid,after.st_mode))
            self.assertTrue(link.is_symlink())
            self.assertEqual(target.read_text(),'new')

    def test_matching_ownership_does_not_call_chown(self):
        from remote_host.commands import basic
        import hashlib
        target=self.home/'original'; target.write_text('old')
        before=target.stat()
        prefix="import os\ndef no_chown(*args): raise PermissionError('unnecessary chown forbidden')\nos.fchown=no_chown\nos.chown=no_chown\n"
        result=subprocess.run(['bash','-c',basic.file_script(prefix+basic.FILE_RECEIVE_PY,str(target),'source',hashlib.sha256(b'new').hexdigest(),'')],
                              input=b'new',capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((before.st_uid,before.st_gid),(target.stat().st_uid,target.stat().st_gid))
        self.assertEqual(target.read_text(),'new')

    def test_file_xattrs_are_preserved(self):
        from remote_host.commands import basic
        src=self.home/'source'; src.write_text('new')
        target=self.home/'target'; target.write_text('old')
        before=target.stat()
        if sys.platform == 'darwin':
            set_attr=subprocess.run(['/usr/bin/xattr','-w','remote-host.fixture','oldattr',str(target)],capture_output=True)
            self.assertEqual(set_attr.returncode,0,set_attr.stderr)
        else:
            os.setxattr(target,'user.remote-host.fixture',b'oldattr')
        self.assertEqual(basic.transfer_file(None,str(src),None,str(target)),0)
        after=target.stat()
        self.assertEqual((before.st_uid,before.st_gid,before.st_mode),(after.st_uid,after.st_gid,after.st_mode))
        if sys.platform == 'darwin':
            got=subprocess.run(['/usr/bin/xattr','-p','remote-host.fixture',str(target)],capture_output=True)
            self.assertEqual(got.returncode,0,got.stderr)
            self.assertEqual(got.stdout.strip(),b'oldattr')
        else:
            self.assertEqual(os.getxattr(target,'user.remote-host.fixture'),b'oldattr')

    def test_sender_failure_after_complete_bytes_never_commits(self):
        from remote_host.commands import basic
        src=self.home/'source'; src.write_text('new')
        dst=self.home/'dest'; dst.write_text('old')
        def failed_source(host,script):
            self.assertIsNone(host)
            return ['bash','-c',script+'; exit 255']
        with mock.patch.object(transfer,'endpoint',side_effect=failed_source):
            self.assertEqual(basic.transfer_file(None,str(src),None,str(dst)),255)
        self.assertEqual(dst.read_text(),'old')

    def test_stale_session_reset_records_lost_and_releases_lock(self):
        from remote_host.commands import session
        lock=self.home/'.cache/remote-host/agent.busy'; lock.mkdir(parents=True)
        rc=self.home/'.cache/remote-host/agent.call.rc'; (lock/'rc').write_text(str(rc))
        with mock.patch.object(session,'find_mux',return_value='MUX=false\n'), mock.patch.object(session,'run_remote',side_effect=lambda h,s:self.bash(s).returncode):
            self.assertEqual(session.cmd_reset(ns(host='h',session='agent')),125)
        self.assertEqual(rc.read_text(),'125\n')
        self.assertFalse(lock.exists())

    def test_worker_exec_failure_writes_exit_127(self):
        import json
        d=self.home/'worker'; d.mkdir()
        result=subprocess.run([sys.executable,'-c',jobs.JOB_WORKER,str(d),json.dumps(['/remote-host-no-such-executable']),'token'],capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((d/'rc').read_text(),'127\n')
        self.assertIn('failed to start',(d/'out.log').read_text())

    def test_cli_run_send_strip_exactly_one_separator(self):
        from remote_host.commands import cli
        for command, fn in [('run','cmd_run'),('send','cmd_send')]:
            captured=[]
            with mock.patch.object(cli,fn,side_effect=lambda a:captured.append(a) or 0):
                self.assertEqual(cli.execute(['-H','h',command,'-i','bash','--','--','-i','literal']),0)
            self.assertEqual(captured[0].command,['--','-i','literal'])
            self.assertEqual(captured[0].interp,'bash')


if __name__ == "__main__":
    unittest.main()
