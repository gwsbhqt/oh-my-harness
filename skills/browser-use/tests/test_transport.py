"""只用临时文件和本机 shell 验证远程协议，不连接 SSH 或用户浏览器。"""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from browser_use.errors import BrowserUseError
from browser_use import transport as t


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.bin = self.home / ".local/bin"
        self.bin.mkdir(parents=True)
        self.calls = []
        self.req = {"host": "fixture", "session": "owned_task", "browser": "Chrome", "target": "tab-exact",
                    "action": "page_evaluate", "params": {"script": "'$(touch no);\n中文\""}}
        self.probe = {"tool": "browser-use", "protocol": 1, "features": ["local-routing", "remote-rpc"]}
        self.reply = {"ok": True, "result": {"answer": 42}}
        self.patches = [patch.object(t.ssh, "PRELUDE", ""),
                        patch.object(t, "_run_remote", side_effect=self.run_local),
                        patch.object(t, "_scp", side_effect=self.copy_file)]
        for p in self.patches:
            p.start()
        self.write_tool()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def write_tool(self):
        tool = self.bin / "browser-use"
        tool.write_text("#!" + sys.executable + "\n" + r"""
import json,sys
if sys.argv[1:]==['--local','capabilities','--json']:
 print(json.dumps(json.load(open(__file__+'.probe'))))
elif sys.argv[1:]==['rpc','--json']:
 r=json.load(sys.stdin)
 assert r['host']=='local' and r['session']=='owned_task' and r['rpcTimeout']>0
 json.dump(r,open(__file__+'.request','w'))
 reply=json.load(open(__file__+'.reply'))
 print(json.dumps(reply))
 sys.exit(reply.get('exit',0))
else: sys.exit(99)
""")
        tool.chmod(0o700)
        Path(str(tool)+".probe").write_text(json.dumps(self.probe))
        Path(str(tool)+".reply").write_text(json.dumps(self.reply))

    def run_local(self, host, script, deadline):
        self.assertEqual(host, "fixture")
        self.calls.append(script)
        env = dict(os.environ, HOME=str(self.home))
        return subprocess.run(["bash", "-c", script], capture_output=True, env=env,
                              timeout=t._remaining(deadline))

    def copy_file(self, host, source, destination, deadline, upload=False):
        self.assertEqual(host, "fixture")
        shutil.copyfile(source, destination)

    def error(self, code, request=None):
        with self.assertRaises(BrowserUseError) as caught:
            t.RemoteTransport().call(request or self.req, timeout=10)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_protocol_json_quotes_and_one_action(self):
        original = copy.deepcopy(self.req)
        result = t.RemoteTransport().call(self.req, timeout=10)
        sent = json.loads(Path(str(self.bin / "browser-use")+".request").read_text())
        self.assertEqual(sent["params"], original["params"])
        self.assertEqual(sent["target"], "tab-exact")
        self.assertEqual(self.req, original)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(result["hostContext"]["host"], "fixture")

    def test_explicit_launcher_is_quoted_and_never_falls_back(self):
        destination = self.home / "alternate '$(no) browser-use"
        for suffix in ("", ".probe", ".reply"):
            shutil.copyfile(str(self.bin / "browser-use")+suffix, str(destination)+suffix)
        destination.chmod(0o700)
        self.assertEqual(t.RemoteTransport(launcher=str(destination)).probe("fixture", 10), self.probe)
        with patch.dict(os.environ, {"BROWSER_USE_REMOTE_LAUNCHER": str(destination)}):
            self.assertEqual(t.RemoteTransport().probe("fixture", 10), self.probe)
        with self.assertRaises(BrowserUseError):
            t.RemoteTransport(launcher="relative")

    def test_probe(self):
        self.assertEqual(t.RemoteTransport().probe("fixture", 10), self.probe)
        self.assertEqual(len(self.calls), 1)

    def test_missing_peer_is_code5(self):
        (self.bin / "browser-use").unlink()
        self.error(5)
        self.assertEqual(len(self.calls), 1)

    def test_old_protocol_no_action(self):
        for key, value in [("tool", "not-browser-use"), ("protocol", True), ("features", []), ("protocol", 2)]:
            self.probe[key] = value
            self.write_tool()
            self.error(5)
        self.assertTrue(all("capabilities" in c for c in self.calls))

    def test_invalid_context_rejected_before_transport(self):
        for key,value in [("host","local"),("host","-option"),("session",None),("params",[]),("browser","Safari")]:
            request = dict(self.req, **{key:value})
            self.error(2, request)
        self.assertEqual(self.calls, [])

    def test_disconnect_unknown_no_retry(self):
        with patch.object(t, "_run_remote", return_value=subprocess.CompletedProcess([],255,b"",b"Connection reset")):
            exc = self.error(4)
        self.assertEqual(exc.outcome,"unknown")

    def test_business_error_preserved(self):
        self.reply = {"ok":False,"code":6,"error":"denied","outcome":"unknown","data":{"count":3},"exit":6}
        self.write_tool()
        exc = self.error(6)
        self.assertEqual(exc.outcome,"unknown")
        self.assertEqual(exc.host,"fixture")
        self.assertEqual(exc.data["count"],3)
        self.assertEqual(len(self.calls),2)

    def test_upload_lost_response_keeps_owned_stage_unknown(self):
        local=self.home/"explicit.txt"
        local.write_bytes(b"fixture")
        self.req.update(action="page_upload",params={"files":[str(local)]})
        original=self.run_local
        def lost(host,script,deadline):
            done=original(host,script,deadline)
            if "rpc --json" in script:
                return subprocess.CompletedProcess([],255,b"",b"Connection reset")
            return done
        with patch.object(t,"_run_remote",side_effect=lost):
            exc=self.error(4)
        self.assertEqual(exc.outcome,"unknown")
        self.assertTrue(exc.data["stageUntilRelease"])
        stages=exc.data["ownedStages"]
        self.assertTrue(Path(stages[0]["directory"]).exists())
        t.RemoteTransport()._cleanup("fixture",stages,time.monotonic()+10)

    def test_business_json_paths_not_fetched(self):
        self.reply["result"]={"path":"/not-readable","artifact":{"path":"/secret"},"nested":{"page_shot":"/secret"}}
        self.write_tool()
        with patch.object(t.RemoteTransport,"_fetch",side_effect=AssertionError("not an artifact")):
            result=t.RemoteTransport().call(self.req,10)
        self.assertEqual(result["artifact"]["path"],"/secret")

    def artifact(self, action, field):
        remote=self.home/"remote '$(no).png"
        remote.write_bytes(b"fixture-artifact\x00bytes")
        self.req.update(action=action,params={})
        self.reply["result"] = {field:str(remote)} if field!="artifact" else {field:{"path":str(remote),"complete":False}}
        self.write_tool()
        return remote

    def test_all_artifact_fields_download_checked_private_new(self):
        for action,field in [("page_snap","shot"),("page_shot","path"),("element_screenshot","path"),("debug_source","artifact"),("output_diff_screenshot","artifact")]:
            remote=self.artifact(action,field)
            result=t.RemoteTransport().call(self.req,10)
            node=result if field!="artifact" else result["artifact"]
            path=Path(node[field if field!="artifact" else "path"])
            self.assertEqual(path.read_bytes(),remote.read_bytes())
            self.assertEqual(node["sha256"],hashlib.sha256(remote.read_bytes()).hexdigest())
            self.assertEqual(node["remotePath"],str(remote))
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            self.assertEqual(path.parent.stat().st_mode&0o777,0o700)
            path.unlink(); path.parent.rmdir()

    def test_error_artifact_downloads_without_repeating_action(self):
        remote=self.artifact("debug_source","artifact")
        self.reply={"ok":False,"code":1,"error":"incomplete","data":self.reply["result"],"exit":1}
        self.write_tool()
        exc=self.error(1)
        path=Path(exc.data["artifact"]["path"])
        self.assertFalse(exc.data["artifact"]["complete"])
        self.assertEqual(path.read_bytes(),remote.read_bytes())
        path.unlink(); path.parent.rmdir()

    def test_explicit_local_out_not_sent_to_remote(self):
        self.artifact("page_shot","path")
        dest=self.home/"local new.png"
        self.req["params"]={"out":str(dest),"overwrite":False}
        result=t.RemoteTransport().call(self.req,10)
        sent=json.loads(Path(str(self.bin/"browser-use")+".request").read_text())
        self.assertNotIn("out",sent["params"])
        self.assertEqual(result["path"],str(dest))
        self.assertEqual(dest.stat().st_mode&0o777,0o600)

    def test_existing_out_symlink_never_overwritten(self):
        self.req.update(action="page_shot",params={"out":str(self.home/"out")})
        (self.home/"out").symlink_to("missing")
        self.error(6)
        self.assertEqual(self.calls,[])

    def test_checksum_mismatch_not_published(self):
        self.artifact("page_shot","path")
        with patch.object(t,"_metadata",return_value={"bytes":0,"sha256":"wrong"}):
            self.error(5)

    def test_upload_and_override_stage_unique_checksum_cleanup(self):
        local=self.home/"explicit '$file.txt"
        local.write_bytes(b"safe-fixture")
        for action,key in [("page_upload","files"),("page_upload_via_chooser","files"),("network_override","file")]:
            upload=action in t._UPLOADS
            self.req.update(action=action,params={key:[str(local)] if upload else str(local)})
            result=t.RemoteTransport().call(self.req,10)
            sent=json.loads(Path(str(self.bin/"browser-use")+".request").read_text())
            paths=sent["params"][key] if upload else [sent["params"][key]]
            for p in paths:
                self.assertTrue(p.startswith("/tmp/browser-use-stage-"))
                if upload:
                    self.assertEqual(Path(p).read_bytes(),b"safe-fixture")
                    self.assertTrue(result["stageUntilRelease"])
                    self.assertEqual(sent["remoteStages"],result["ownedStages"])
                else:
                    self.assertFalse(Path(p).parent.exists())
            if upload:
                t.RemoteTransport()._cleanup("fixture",result["ownedStages"],time.monotonic()+10)
                self.assertFalse(Path(paths[0]).parent.exists())
            self.assertEqual(local.read_bytes(),b"safe-fixture")

    def test_download_directory_keeps_remote_meaning(self):
        self.req.update(action="page_download",params={"directory":"/remote/download"})
        t.RemoteTransport().call(self.req,10)
        sent=json.loads(Path(str(self.bin/"browser-use")+".request").read_text())
        self.assertEqual(sent["params"]["directory"],"/remote/download")

    def test_scp_uses_native_sftp_and_safe_argv(self):
        self.patches[2].stop()
        with patch.object(t,"_process",return_value=subprocess.CompletedProcess([],0,b"",b"")) as process:
            t._scp("fixture","/path '$file","/local file",time.monotonic()+10)
        args=process.call_args.args[0]
        self.assertNotIn("-O",args)
        self.assertEqual(args[-2:],["fixture:/path '$file","/local file"])

    def test_native_process_retains_stderr_and_exit(self):
        done=t._process(["bash","-c","printf error >&2; exit 7"],None,time.monotonic()+10)
        self.assertEqual(done.returncode,7)
        self.assertEqual(done.stderr,b"error")
        with self.assertRaises(BrowserUseError) as caught:
            t._checked(done)
        self.assertIn("error",str(caught.exception))

    def test_cleanup_refuses_replaced_directory_identity(self):
        directory=Path(tempfile.mkdtemp(prefix="browser-use-stage-"))
        stage={"directory":str(directory),"device":directory.stat().st_dev,"inode":-1,"files":[]}
        try:
            with self.assertRaises(BrowserUseError):
                t.RemoteTransport()._cleanup("fixture",[stage],time.monotonic()+10)
            self.assertTrue(directory.exists())
        finally:
            directory.rmdir()

    def test_local_wait_timeout_unknown(self):
        with self.assertRaises(BrowserUseError) as caught:
            t._process(["bash","-c","read x"],b"",time.monotonic()-1)
        self.assertEqual(caught.exception.outcome,"unknown")

    def test_cleanup_refuses_foreign_entry(self):
        directory=Path(tempfile.mkdtemp(prefix="browser-use-stage-"))
        (directory/"foreign").write_bytes(b"leave")
        try:
            with self.assertRaises(BrowserUseError):
                t.RemoteTransport()._cleanup("fixture",[{"directory":str(directory),"files":[], "device": directory.stat().st_dev, "inode": directory.stat().st_ino}],time.monotonic()+10)
            self.assertEqual((directory/"foreign").read_bytes(),b"leave")
        finally:
            (directory/"foreign").unlink();directory.rmdir()


if __name__ == "__main__":
    unittest.main()
