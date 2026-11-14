"""四个工具共用的选机与转发：隔离 pin，保留 argv、SSH 状态与截图内容。"""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agentkit.remote import adapters, pins, ssh, target


class TargetCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        (self.home / ".ssh").mkdir()
        (self.home / ".ssh/config").write_text("Host alpha beta blocked\n")
        patch = mock.patch.dict(os.environ, {"HOME": str(self.home),
            "XDG_STATE_HOME": str(self.home / "state"),
            "XDG_CACHE_HOME": str(self.home / "cache"), "REMOTE_HOST_NO_LOG": "1"})
        patch.start()
        self.addCleanup(patch.stop)
        ssh.PROXY["on"] = False

    def call(self, tool, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            if tool == "remote-host":
                cleaned, _, code = target.route(tool, list(args))
            else:
                cleaned, code = target.dispatch(tool, list(args))
        return cleaned, code, out.getvalue(), err.getvalue()

    def route(self, tool, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            cleaned, host, code = target.route(tool, list(args))
        return cleaned, host, code, out.getvalue(), err.getvalue()

    def result(self, code=0, data=b""):
        return subprocess.CompletedProcess([], code, data, b"")


class Pins(TargetCase):
    def test_defaults_and_old_remote_host_pin(self):
        self.assertEqual(target.resolve_target("computer-use"), "local")
        self.assertEqual(target.resolve_target("dsh-use"), "local")
        with self.assertRaises(ValueError):
            target.resolve_target("remote-host")
        pins.write_pin({"host": "alpha", "hosts": {"alpha": {"cwd": "~/work"}}}, "remote-host")
        self.assertEqual(target.resolve_target("remote-host"), "alpha")
        self.assertEqual(target.resolve_target("computer-use"), "local")
        self.assertEqual(pins.read_pin("remote-host")["hosts"]["alpha"]["cwd"], "~/work")

    def test_invalid_pin_never_silently_falls_back_to_local(self):
        malformed = ["{", "[]", '{"host":""}', '{"host":null}',
                     '{"host":5}', '{"hosts":[]}', '{"hosts":{"alpha":4}}',
                     '{"hosts":{"alpha":{"cwd":7}}}']
        for text in malformed:
            path = pins.pin_file("computer-use")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    target.resolve_target("computer-use")
                self.assertNotEqual(self.call("computer-use", "apps")[1], None)
        with mock.patch.object(Path, "read_text", side_effect=PermissionError("unreadable pin")):
            with self.assertRaises(PermissionError):
                target.resolve_target("computer-use")
            result = self.call("computer-use", "apps", "--json")
        self.assertEqual(result[1], 2)
        self.assertIn("unreadable", json.loads(result[2])["error"])

    def test_local_host_conflict_cannot_bypass_remote_selection(self):
        with mock.patch.object(ssh, "run_remote") as remote:
            for host in ("alpha", "missing"):
                result = self.call("computer-use", "-H", host, "--local", "apps", "--json")
                self.assertEqual(result[1], 2)
                self.assertFalse(json.loads(result[2])["ok"])
        remote.assert_not_called()

    def test_control_commands_support_clean_structured_json(self):
        for tool in ("computer-use", "dsh-use"):
            for action in ("use", "pin"):
                result = self.call(tool, action, "alpha", "--json")
                self.assertEqual(result[1], 0)
                self.assertEqual(json.loads(result[2]), {"ok": True, "tool": tool, "target": "alpha"})
            result = self.call(tool, "hosts", "--json")
            data = json.loads(result[2])
            self.assertEqual(data["target"], "alpha")
            self.assertEqual(data["hosts"], ["local", "alpha", "beta", "blocked"])
            result = self.call(tool, "use", "--clear", "--json")
            self.assertEqual(json.loads(result[2])["target"], "local")

    def test_explicit_empty_host_is_not_local(self):
        with self.assertRaises(ValueError):
            target.resolve_target("computer-use", "")

    def test_tool_specific_use_output_has_no_interpreter_settings(self):
        self.call("computer-use", "use", "alpha")
        out = self.call("computer-use", "use")[2]
        self.assertIn("alpha", out)
        self.assertNotIn("interp", out)
        self.assertNotIn("cwd", out)

    def test_each_tool_changes_only_its_own_pin(self):
        pins.write_pin({"host": "alpha"}, "remote-host")
        self.assertEqual(self.call("computer-use", "use", "beta")[1], 0)
        self.assertEqual(self.call("dsh-use", "pin", "alpha")[1], 0)
        self.assertEqual(target.resolve_target("computer-use"), "beta")
        self.assertEqual(target.resolve_target("dsh-use"), "alpha")
        self.call("computer-use", "use", "local")
        self.assertEqual(target.resolve_target("computer-use"), "local")
        self.assertEqual(pins.read_pin("remote-host")["host"], "alpha")
        self.assertEqual(target.resolve_target("dsh-use"), "alpha")
        self.call("dsh-use", "use", "--clear")
        self.assertEqual(target.resolve_target("dsh-use"), "local")
        self.assertEqual(pins.read_pin("remote-host")["host"], "alpha")

    def test_use_pin_alias_and_unknown_host_leave_state_unchanged(self):
        for tool in target.TOOLS:
            self.assertEqual(self.call(tool, "pin", "alpha")[1], 0)
            before = pins.read_pin(tool)
            self.assertNotEqual(self.call(tool, "use", "no-such-host")[1], 0)
            self.assertEqual(pins.read_pin(tool), before)
            out = self.call(tool, "hosts")[2]
            self.assertIn("alpha  (pinned)", out)
            self.assertEqual("local" in out, tool != "remote-host")

    def test_remote_host_local_clears_but_cannot_execute(self):
        self.call("remote-host", "use", "alpha")
        self.assertEqual(self.call("remote-host", "use", "local")[1], 0)
        self.assertNotIn("host", pins.read_pin("remote-host"))
        for args in [("--local", "run", "true"), ("-H", "local", "run", "true")]:
            self.assertEqual(self.route("remote-host", *args)[2], 2)

    def test_local_flag_overrides_pin_without_mutating(self):
        self.call("computer-use", "use", "alpha")
        with mock.patch.object(ssh, "run_remote") as remote:
            cleaned, code, _, _ = self.call("computer-use", "--local", "shot")
        self.assertEqual((cleaned, code), (["shot"], None))
        self.assertEqual(target.resolve_target("computer-use"), "alpha")
        remote.assert_not_called()


class Routing(TargetCase):
    def test_prefix_host_and_arguments_preserve_whitespace(self):
        with mock.patch.object(ssh, "run_remote", return_value=17) as run:
            cleaned, code, out, err = self.call("dsh-use", "-H", "alpha", "message", "id", "a b; $(oops)")
        self.assertEqual(cleaned, ["message", "id", "a b; $(oops)"])
        self.assertEqual(code, 17)
        self.assertEqual(out, "")
        self.assertIn("target alpha", err)
        self.assertIn("exit 17", err)
        self.assertIn("'a b; $(oops)'", run.call_args.args[1])

    def test_flags_embedded_in_text_and_after_separator_are_not_consumed(self):
        text = "say -H alpha and --host beta"
        args = ["--local", "message", "id", text, "--", "--host", "-H"]
        cleaned, code, _, _ = self.call("dsh-use", *args)
        self.assertEqual(code, None)
        self.assertEqual(cleaned, args[1:])

    def test_command_payload_flags_do_not_route_or_disappear(self):
        for text in ("-H", "--host", "--local"):
            cleaned, code, _, _ = self.call("computer-use", "type", "Finder", text)
            self.assertIsNone(code)
            self.assertEqual(cleaned, ["type", "Finder", text])
        self.call("computer-use", "use", "alpha")
        with mock.patch.object(ssh, "run_remote", return_value=0) as run:
            self.call("computer-use", "type", "Finder", "--local")
        self.assertEqual(run.call_args.args[0], "alpha")
        self.assertIn("--local type Finder --local", run.call_args.args[1])

    def test_json_transport_and_unknown_alias_errors_are_objects(self):
        for tool in ("computer-use", "dsh-use"):
            result = self.call(tool, "-H", "missing", "status", "--json")
            self.assertFalse(json.loads(result[2])["ok"])
            self.assertNotEqual(result[1], 0)
            with mock.patch.object(ssh, "run_remote", return_value=self.result(255)):
                result = self.call(tool, "-H", "alpha", "status", "--json")
            self.assertFalse(json.loads(result[2])["ok"])
            self.assertEqual(result[1], 255)

    def test_remote_json_error_remains_unchanged(self):
        raw = b'{"ok":false,"error":"tool error","code":9}\n'
        with mock.patch.object(ssh, "run_remote", return_value=self.result(9, raw)):
            result = self.call("computer-use", "-H", "alpha", "shot", "--json")
        self.assertEqual(result[1], 9)
        self.assertEqual(result[2], raw.decode())

    def test_host_equal_and_compact_forms(self):
        for flag in ("--host=alpha", "-Halpha"):
            with mock.patch.object(ssh, "run_remote", return_value=0) as run:
                self.assertEqual(self.call("computer-use", flag, "apps")[1], 0)
            self.assertEqual(run.call_args.args[0], "alpha")

    def test_unknown_host_or_bad_flag_returns_nonzero_not_local(self):
        with mock.patch.object(ssh, "run_remote") as run:
            for args in [("-H", "missing", "apps"), ("-H",), ("--host=", "apps")]:
                self.assertNotEqual(self.call("computer-use", *args)[1], 0)
        run.assert_not_called()

    def test_dsh_answer_json_payload_is_not_output_json_flag(self):
        payload = '{"answers":[{"id":"one","value":"yes"}]}'
        for args in (["answer", "session", "--json", payload],
                     ["answer", "session", "--json=" + payload],
                     ["answer", "session", "--json", "[]"]):
            self.assertFalse(target._wants_json(args, "dsh-use"))
            with mock.patch.object(ssh, "run_remote", return_value=0) as run:
                self.assertEqual(self.call("dsh-use", "-H", "alpha", *args)[1], 0)
            self.assertEqual(run.call_args.kwargs, {})
        args = ["answer", "session", "--json", payload, "--json"]
        self.assertTrue(target._wants_json(args, "dsh-use"))
        with mock.patch.object(ssh, "run_remote", return_value=self.result(data=b"business reply\n")):
            result = self.call("dsh-use", "-H", "alpha", *args)
        self.assertEqual(result[1], 0)
        self.assertEqual(result[2], "business reply\n")

    def test_remote_serve_is_rejected_without_running_empty_stdin(self):
        with mock.patch.object(ssh, "run_remote") as run:
            result = self.call("computer-use", "-H", "alpha", "serve", "--json")
        self.assertEqual(result[1], 2)
        self.assertIn("bidirectional", json.loads(result[2])["error"])
        run.assert_not_called()
        self.assertIsNone(self.call("computer-use", "serve")[1])

    def test_remote_restart_receipt_starts_local_watch_without_reusing_remote_session(self):
        import uuid
        request_id = str(uuid.uuid4())
        origin = "session-" + str(uuid.uuid4())
        receipt = {"ok":True,"status":"queued","data":{"requestId":request_id}}
        with mock.patch.dict(os.environ, {"DSH_SESSION_ID":origin}), mock.patch.object(ssh,"run_remote",return_value=self.result(data=json.dumps(receipt).encode())), mock.patch("agentkit.remote.notifications.start_restart_watch",return_value={"watchId":request_id,"pid":12,"statePath":"/fixture"}) as start, mock.patch("agentkit.remote.notifications.capture_ssh_target",return_value={"fixture":"original"}):
            result = self.call("dsh-use","-H","alpha","restart","--when-idle","--detach","--json")
        self.assertEqual(result[1],0)
        self.assertTrue(json.loads(result[2])["watchStarted"])
        start.assert_called_once_with("alpha",request_id,origin,ssh_snapshot={"fixture":"original"})

    def test_remote_restart_watch_failure_retains_sent_receipt(self):
        import uuid
        receipt = {"ok":True,"status":"queued","data":{"requestId":str(uuid.uuid4())}}
        with mock.patch.dict(os.environ, {"DSH_SESSION_ID":"session-"+str(uuid.uuid4())}), mock.patch.object(ssh,"run_remote",return_value=self.result(data=json.dumps(receipt).encode())) as execute, mock.patch("agentkit.remote.notifications.start_restart_watch",side_effect=OSError("fixture spawn error")), mock.patch("agentkit.remote.notifications.capture_ssh_target",return_value={"fixture":"original"}):
            result = self.call("dsh-use","-H","alpha","restart","--when-idle","--detach","--json")
        self.assertEqual(result[1],1)
        data=json.loads(result[2])
        self.assertFalse(data["watchStarted"])
        self.assertEqual(data["data"],receipt["data"])
        self.assertIn("fixture spawn",data["watchError"])
        self.assertEqual(execute.call_count,1)

    def test_remote_restart_from_subagent_skips_watch_and_succeeds(self):
        import uuid
        request_id = str(uuid.uuid4())
        receipt = {"ok":True,"status":"queued","data":{"requestId":request_id}}
        with mock.patch.dict(os.environ, {"DSH_SESSION_ID":str(uuid.uuid4())}), mock.patch.object(ssh,"run_remote",return_value=self.result(data=json.dumps(receipt).encode())) as execute, mock.patch("agentkit.remote.notifications.start_restart_watch") as start, mock.patch("agentkit.remote.notifications.capture_ssh_target",return_value={"fixture":"original"}):
            result = self.call("dsh-use","-H","alpha","restart","--when-idle","--detach","--json")
        self.assertEqual(result[1],0)
        data=json.loads(result[2])
        self.assertFalse(data["watchStarted"])
        self.assertIn(f"restart-status --request-id {request_id}",data["watchSkipped"])
        start.assert_not_called()
        self.assertEqual(execute.call_count,1)

    def test_remote_restart_without_origin_session_is_not_given_fake_notification(self):
        with mock.patch.dict(os.environ, {"DSH_SESSION_ID":""}), mock.patch.object(ssh, "run_remote", return_value=self.result(data=b'{"ok":true}')):
            result = self.call("dsh-use", "-H", "alpha", "restart", "--when-idle", "--detach", "--json")
        self.assertEqual(result[1], 0)
        self.assertNotIn("watchStarted", json.loads(result[2]))

    def test_generic_json_is_passed_through_not_guessed(self):
        with mock.patch.object(ssh, "run_remote", return_value=self.result(data=b'{"apps":[]}')) as run:
            result = self.call("computer-use", "-H", "alpha", "apps", "--json")
        self.assertEqual(json.loads(result[2]), {"apps": []})
        self.assertEqual(len(run.call_args.args), 2)
        self.assertEqual(run.call_args.kwargs, {"capture": "stdout"})

    def test_remote_host_route_leaves_host_lists_and_commands_to_remote_host(self):
        self.assertEqual(self.route("remote-host", "run", "-H", "alpha,beta", "exit 31")[:3], (["run", "exit 31"], "alpha,beta", None))
        self.assertEqual(self.route("remote-host", "discover")[:3], (["discover"], None, None))
        self.assertEqual(self.route("remote-host", "-H", "alpha", "hosts")[1:3], (None, 0))

    def test_real_ssh_refused_connection_keeps_255(self):
        config = self.home / "isolated-ssh-config"
        config.write_text("Host blocked\n HostName 127.0.0.1\n Port 1\n BatchMode yes\n ConnectTimeout 1\n")
        with mock.patch.object(ssh, "remote_argv", side_effect=lambda host, command="bash -l -s":
                ["ssh", "-F", str(config), host, command]), mock.patch.object(ssh, "ssh_hint", side_effect=lambda code, host: code):
            self.assertEqual(self.call("dsh-use", "-H", "blocked", "status")[1], 255)



    def test_remote_host_payload_host_flag_is_not_a_machine_selection(self):
        args, host, local = target._extract(["-H", "alpha", "run", "curl", "-H", "Accept: application/json", "https://example.invalid"], "remote-host")
        self.assertEqual(host, "alpha")
        self.assertEqual(args, ["run", "curl", "-H", "Accept: application/json", "https://example.invalid"])
        self.assertFalse(local)

    def test_proxy_run_does_not_interpret_payload_headers_as_hosts(self):
        payload = ["proxy-run", "--local-proxy", "http://127.0.0.1:7890", "curl", "-H", "Accept: application/json"]
        args, host, local = target._extract(["-H", "alpha", *payload], "remote-host")
        self.assertEqual((args, host, local), (payload, "alpha", False))

    def test_misplaced_machine_options_refuse_before_local_execution(self):
        for tool, command in (("dsh-use", "health"), ("dsh-use", "start"), ("computer-use", "apps")):
            for words in (["-H", "alpha"], ["--host", "alpha"], ["--host=alpha"]):
                result = self.call(tool, command, *words, "--json")
                self.assertEqual(result[1], 2)
                self.assertIn("precede", result[3])

    def test_snap_shot_flag_takes_no_value_so_trailing_host_is_still_refused(self):
        result = self.call("computer-use", "snap", "Finder", "--shot", "-H", "alpha", "--json")
        self.assertEqual(result[1], 2)
        self.assertIn("precede", result[3])

    def test_context_values_before_command_do_not_break_payload_boundary(self):
        argv=["-i","py","-H","alpha","run","print", "-H","literal"]
        args,host,_=target._extract(argv,"remote-host")
        self.assertEqual(host,"alpha")
        self.assertEqual(args,["-i","py","run","print","-H","literal"])
        args,host,_=target._extract(["run","-i","py","-H","alpha","print","-H","literal"],"remote-host")
        self.assertEqual(host,"alpha")
        self.assertEqual(args,["run","-i","py","print","-H","literal"])

    def test_literal_routing_words_in_text_following_options_are_kept(self):
        self.assertEqual(target._extract(["send","--now","session-aaaa","-H"],"dsh-use")[0], ["send","--now","session-aaaa","-H"])
        self.assertEqual(target._extract(["click","Finder","--label","--host"],"computer-use")[0], ["click","Finder","--label","--host"])

    def test_conflicting_machine_selections_refuse(self):
        result = self.call("computer-use", "-H", "alpha", "-H", "beta", "apps", "--json")
        self.assertEqual(result[1], 2)
        self.assertFalse(json.loads(result[2])["ok"])


class Staging(TargetCase):
    def local_script(self, script):
        return subprocess.run(["bash", "-s"], input=script.encode(), capture_output=True)

    def install_tool(self, tool, code=0):
        entry = self.home / ".local/bin" / tool
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_text(f"#!{sys.executable}\nimport json, os, sys\nif '--capabilities' in sys.argv:\n print(json.dumps({{'ok':True,'tool':{tool!r},'protocol':1,'features':['local-routing','task-outcomes','snapshot-token','snapshot-status','restart-receipts']}}))\n sys.exit(0)\nprint(json.dumps({{'args':sys.argv[1:], 'shell':os.getenv('DSH_SHELL'), 'session':os.getenv('DSH_SESSION_ID')}}))\nsys.exit({code})\n")
        entry.chmod(0o755)

    def test_staged_argv_and_exit_are_lossless(self):
        self.install_tool("computer-use", 42)
        args = ["type", "a b", "$(touch bad)", "single'quote", "line1\n__REMOTE_HOST_EOF__\nline3", "", "--", "-H"]
        done = self.local_script(target.command_script("computer-use", args))
        self.assertEqual(done.returncode, 42, done.stderr)
        self.assertEqual(json.loads(done.stdout)["args"], ["--local", *args])
        self.assertFalse((self.home / "bad").exists())
        self.assertEqual(list((self.home / ".cache/remote-host").iterdir()), [])

    def test_authentication_failure_is_not_relabelled_as_network_failure(self):
        error = io.StringIO()
        with contextlib.redirect_stderr(error), mock.patch("agentkit.remote.reach.diagnose", side_effect=AssertionError("不能覆盖真实身份校验错误")):
            self.assertEqual(ssh.ssh_hint(255, "alpha", b"Host key verification failed."), 255)
            self.assertEqual(ssh.ssh_hint(255, "alpha", b"Permission denied (publickey)."), 255)
        self.assertIn("主机身份校验失败", error.getvalue())
        self.assertIn("登录认证失败", error.getvalue())

    def test_old_remote_tool_is_refused_before_any_action(self):
        self.install_tool("computer-use")
        entry = self.home / ".local/bin/computer-use"
        entry.write_text(f"#!{sys.executable}\nfrom pathlib import Path\nimport sys\nif '--capabilities' in sys.argv: print('{{}}'); sys.exit(0)\nPath({str(self.home / 'changed')!r}).write_text('bad')\n")
        entry.chmod(0o755)
        done = self.local_script(target.command_script("computer-use", ["click", "Finder", "--id", "Delete"]))
        self.assertEqual(done.returncode, 78, done.stderr)
        self.assertFalse((self.home / "changed").exists())
        self.assertEqual(done.stdout, b"")
        self.assertIn("未执行命令".encode(), done.stderr)

    def test_wrong_tool_or_missing_feature_cannot_pass_handshake(self):
        for peer in ({"ok":True,"tool":"dsh-use","protocol":1,"features":["local-routing"]},
                     {"ok":True,"tool":"computer-use","protocol":1,"features":["local-routing"]},
                     {"ok":True,"tool":"computer-use","protocol":9,"features":["local-routing","snapshot-token","snapshot-status"]}):
            self.install_tool("computer-use")
            entry = self.home / ".local/bin/computer-use"
            entry.write_text(f"#!{sys.executable}\nimport sys\nprint({json.dumps(peer)!r})\n")
            entry.chmod(0o755)
            done = self.local_script(target.command_script("computer-use", ["apps"]))
            self.assertEqual(done.returncode, 78)
            self.assertEqual(done.stdout, b"")

    def test_missing_tool_never_runs_system_tool(self):
        done = self.local_script(target.command_script("computer-use", ["apps"]))
        self.assertEqual(done.returncode, 127)
        self.assertIn(b"remote tool missing", done.stderr)
        self.assertEqual(done.stdout, b"")

    def test_dsh_shell_source_survives_but_session_does_not(self):
        self.install_tool("dsh-use")
        with mock.patch.dict(os.environ, {"DSH_SHELL": "dsh; literal", "DSH_SESSION_ID": "local-session"}):
            done = self.local_script(target.command_script("dsh-use", ["restart", "--detach"]))
        self.assertEqual(done.returncode, 0, done.stderr)
        data = json.loads(done.stdout)
        self.assertEqual(data["shell"], "dsh; literal")
        self.assertIsNone(data["session"])


    def test_dsh_session_alone_still_marks_remote_shell_source(self):
        self.install_tool("dsh-use")
        with mock.patch.dict(os.environ, {"DSH_SHELL": "", "DSH_SESSION_ID": "local-session"}):
            done = self.local_script(target.command_script("dsh-use", ["restart"]))
        self.assertEqual(json.loads(done.stdout)["shell"], "1")
        self.assertIsNone(json.loads(done.stdout)["session"])


class Screenshots(TargetCase):
    def test_snap_json_and_shot_json_rewrite_only_documented_fields(self):
        for action, key in (("snap", "shot"), ("shot", "path")):
            data = {key: "/remote/a b.png", "elements": [{"id": 3, "label": "A"}], "other": 12}
            with mock.patch.object(ssh, "run_remote", return_value=self.result(data=json.dumps(data).encode())) as run, \
                 mock.patch.object(adapters, "_fetch_shot", return_value=("/local/readable.png", 0)) as fetch:
                _, code, out, _ = self.call("computer-use", "-H", "alpha", action, "--json")
            self.assertEqual(code, 0)
            result = json.loads(out)
            self.assertEqual(result["remotePath"], data[key])
            self.assertEqual(result[key], "/local/readable.png")
            self.assertEqual(result["path"], "/local/readable.png")
            self.assertEqual(result["elements"], data["elements"])
            fetch.assert_called_once_with("alpha", data[key])
            self.assertEqual(run.call_args.kwargs, {"capture": "stdout"})

    def test_text_uses_explicit_json_capture_then_prints_local_paths(self):
        for action, key in (("snap", "shot"), ("shot", "path")):
            data = {key: "/remote/shot.png", "elements": [{"idx": 4, "axid": "an-id", "role": "button", "label": "OK"}]}
            with mock.patch.object(ssh, "run_remote", return_value=self.result(data=json.dumps(data).encode())) as run, \
                 mock.patch.object(adapters, "_fetch_shot", return_value=("/local/shot.png", 0)):
                _, code, out, _ = self.call("computer-use", "-H", "alpha", action)
            self.assertEqual(code, 0)
            self.assertIn("--json", run.call_args.args[1])
            self.assertIn("/local/shot.png", out)
            self.assertNotIn("/remote/shot.png", out)
            if action == "snap":
                self.assertIn("4\tbutton\tOK", out)

    def test_diff_text_and_json_do_not_require_screenshot(self):
        data = {"mode": "diff", "changed": True, "app": "Finder",
                "added": [{"idx": 2, "role": "button", "label": "New", "axid": "a"}],
                "removed": [{"role": "button", "label": "Old", "axid": "b"}]}
        with mock.patch.object(ssh, "run_remote", return_value=self.result(data=json.dumps(data).encode())), \
             mock.patch.object(adapters, "_fetch_shot") as fetch:
            result = self.call("computer-use", "-H", "alpha", "snap", "Finder", "--diff")
            json_result = self.call("computer-use", "-H", "alpha", "snap", "Finder", "--diff", "--json")
        self.assertEqual(result[1], 0)
        self.assertIn("APP Finder", result[2])
        self.assertIn("DIFF +1新增 / -1消失", result[2])
        self.assertIn("New", result[2])
        self.assertIn("Old", result[2])
        self.assertEqual(json.loads(json_result[2]), data)
        fetch.assert_not_called()

    def test_snapshot_token_and_failure_details_survive_forwarding(self):
        data = {"ok":True,"mode":"snap","snapshot":"fixture-token","elements":[],
                "screenshot":{"requested":True,"ok":False,"via":None,"error":"screen denied"}}
        with mock.patch.object(ssh, "run_remote", return_value=self.result(data=json.dumps(data).encode())), mock.patch.object(adapters, "_fetch_shot") as fetch:
            result = self.call("computer-use", "-H", "alpha", "snap", "Finder", "--json")
            self.assertEqual(json.loads(result[2]), data)
            text = self.call("computer-use", "-H", "alpha", "snap", "Finder")
        self.assertIn("screen denied", text[2])
        self.assertIn("fixture-token", text[2])
        fetch.assert_not_called()

    def test_diff_no_changes_is_not_empty(self):
        with mock.patch.object(ssh, "run_remote", return_value=self.result(data=b'{"mode":"diff","changed":false}')):
            self.assertIn("DIFF 无变化", self.call("computer-use", "-H", "alpha", "snap", "--diff")[2])

    def test_leading_json_flag_still_captures_screenshot(self):
        with mock.patch.object(ssh, "run_remote", return_value=self.result(data=b'{"path":"/r.png"}')), \
             mock.patch.object(adapters, "_fetch_shot", return_value=("/l.png", 0)):
            result = self.call("computer-use", "-H", "alpha", "--json", "shot")
        self.assertEqual(json.loads(result[2])["path"], "/l.png")

    def test_non_json_stdout_is_not_inferred_or_rewrapped(self):
        with mock.patch.object(ssh, "run_remote", return_value=self.result(data=b"SHOT /remote/shot.png\n")), \
             mock.patch.object(adapters, "_fetch_shot") as fetch:
            _, code, out, _ = self.call("computer-use", "-H", "alpha", "shot", "--json")
        self.assertNotEqual(code, 0)
        self.assertFalse(json.loads(out)["ok"])
        self.assertIn("not valid JSON", json.loads(out)["error"])
        fetch.assert_not_called()

    def test_failure_retains_remote_exit_and_does_not_fetch(self):
        with mock.patch.object(ssh, "run_remote", return_value=self.result(19, b"failed\n")), \
             mock.patch.object(adapters, "_fetch_shot") as fetch:
            self.assertEqual(self.call("computer-use", "-H", "alpha", "shot")[1], 19)
        fetch.assert_not_called()

    def test_download_failure_is_nonzero(self):
        with mock.patch.object(ssh, "run_remote", return_value=self.result(data=b'{"path":"/r.png"}')), \
             mock.patch.object(adapters, "_fetch_shot", return_value=(None, 255)):
            self.assertEqual(self.call("computer-use", "-H", "alpha", "shot")[1], 255)

    def test_file_bytes_are_downloaded_and_remote_path_is_safely_quoted(self):
        source = self.home / "a b'$(bad).png"
        source.write_bytes(b"\x89PNG\x00fixture")
        with mock.patch.object(ssh, "remote_argv", return_value=["bash", "-s"]):
            local, code = target._fetch_shot("alpha", str(source))
        self.assertEqual(code, 0)
        self.assertEqual(Path(local).read_bytes(), source.read_bytes())
        self.assertTrue(Path(local).is_absolute())


if __name__ == "__main__":
    unittest.main()
