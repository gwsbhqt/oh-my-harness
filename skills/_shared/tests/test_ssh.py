"""共用 SSH 层：远端目录写法、连不上时的提示和诊断、借代理时的局域网地址。不连网、不碰真主机。"""

import contextlib
import errno
import io
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agentkit.remote import reach, ssh  # noqa: E402


class RemoteDir(unittest.TestCase):
    def test_tilde_is_the_remote_home(self):
        self.assertEqual(ssh.remote_dir("~"), '"$HOME"')
        self.assertEqual(ssh.remote_dir("~/a b"), "\"$HOME\"/'a b'")
        self.assertEqual(ssh.remote_dir("/abs/p"), "/abs/p")

    def test_it_really_expands_in_a_shell(self):
        out = subprocess.run(["bash", "-c", f"cd {ssh.remote_dir('~')} && pwd"],
                             capture_output=True, text=True, env=dict(os.environ, HOME="/tmp"))
        self.assertEqual(os.path.realpath(out.stdout.strip()), os.path.realpath("/tmp"))


class AuthHint(unittest.TestCase):
    def hint(self, code, why, detail="Connection timed out"):
        err = io.StringIO()
        with mock.patch.object(sys, "stderr", err), mock.patch.object(reach, "diagnose", return_value=why) as d:
            ssh.ssh_hint(code, "mini", detail)
        return err.getvalue(), d

    def test_login_error_is_not_relabelled_as_network(self):
        text, diagnosis = self.hint(255, None, "Permission denied (publickey,gssapi-with-mic)")
        self.assertIn("登录认证失败", text)
        self.assertIn("IPv4/IPv6", text)
        self.assertIn("AllowUsers", text)
        self.assertIn("既有磁盘密钥", text)
        self.assertNotIn("ssh-copy-id", text)
        diagnosis.assert_not_called()
        hostkey, diagnosis = self.hint(255, "misleading timeout", "Host key verification failed")
        self.assertIn("主机身份校验失败", hostkey)
        diagnosis.assert_not_called()

    def test_network_cause_replaces_the_auth_hint(self):
        text, _ = self.hint(255, "198.51.100.5:22 timed out, and this machine … is not on that LAN")
        self.assertIn("remote-host: cannot reach mini: 198.51.100.5:22 timed out", text)
        self.assertNotIn("ssh-copy-id", text)

    def test_payload_exit_codes_are_not_diagnosed(self):
        text, d = self.hint(1, "unused")
        self.assertEqual(text, "")
        d.assert_not_called()


class Reach(unittest.TestCase):
    """Why ssh got no further — each cause told apart (field report 2026-09-23:
    away from home, asleep, a changed IP and Remote Login off all looked like a timeout)."""

    def setUp(self):
        self.config_home = tempfile.TemporaryDirectory()
        self.addCleanup(self.config_home.cleanup)
        env = mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": self.config_home.name})
        env.start()
        self.addCleanup(env.stop)
        config = Path(self.config_home.name) / "remote-host" / "networks.json"
        config.parent.mkdir()
        config.write_text('{"192.0.2.0/24":"a sample hotspot","203.0.113.0/24":"a sample network"}')
        self.network_config = config

    def diagnose(self, hostname, port, **patches):
        conf = {"hostname": hostname, "port": str(port)}
        with mock.patch.object(reach, "ssh_config", return_value=conf), contextlib.ExitStack() as stack:
            for name, value in patches.items():
                stack.enter_context(mock.patch.object(reach, name, value))
            return reach.diagnose("mini", timeout=2)

    def test_open_port_means_not_the_network(self):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        try:
            self.assertIsNone(self.diagnose("127.0.0.1", server.getsockname()[1]))
        finally:
            server.close()

    def test_refused_port_means_remote_login_is_off(self):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()  # nothing listens there now: a real refusal
        why = self.diagnose("127.0.0.1", port)
        self.assertIn("refuses port", why)
        self.assertIn("Remote Login", why)

    def test_unresolvable_local_name_points_at_the_lan(self):
        why = self.diagnose("nosuchmachine-remote-host-test.local", 22,
                            socket=mock.Mock(getaddrinfo=mock.Mock(side_effect=OSError("nodename nor servname")),
                                             IPPROTO_TCP=socket.IPPROTO_TCP))
        self.assertIn("does not resolve", why)
        self.assertIn("remote-host discover", why)

    def timeout_from(self, mine):
        fake = mock.Mock(wraps=socket)
        fake.IPPROTO_TCP = socket.IPPROTO_TCP
        fake.timeout = socket.timeout
        fake.getaddrinfo = mock.Mock(return_value=[(0, 0, 0, "", ("198.51.100.5", 22))])
        fake.create_connection = mock.Mock(side_effect=socket.timeout("timed out"))
        return self.diagnose("198.51.100.5", 22, socket=fake, local_addr_towards=mock.Mock(return_value=mine))

    def test_timeout_from_another_network_says_you_are_away(self):
        why = self.timeout_from("203.0.113.49")
        self.assertIn("timed out", why)
        self.assertIn("not on that LAN", why)
        self.assertIn("203.0.113.49, a sample network", why)

    def test_the_known_networks_are_named(self):
        self.assertEqual(reach.network_name("192.0.2.3"), "a sample hotspot")
        self.assertEqual(reach.network_name("203.0.113.49"), "a sample network")
        self.assertIsNone(reach.network_name("198.18.0.3"))
        self.assertIn("(198.18.0.3) is not on that LAN", self.timeout_from("198.18.0.3"))

    def test_missing_user_network_config_has_no_labels(self):
        self.network_config.unlink()
        self.assertIsNone(reach.network_name("203.0.113.49"))

    def test_bad_user_config_is_reported(self):
        for data in ('[1]', '{"not-a-cidr":"x"}', '{"192.0.2.0/24":1}', 'invalid-json'):
            with self.subTest(data=data):
                self.network_config.write_text(data)
                with self.assertRaises(ValueError):
                    reach.network_name("192.0.2.3")

    def test_timeout_on_the_same_lan_says_asleep_or_moved(self):
        why = self.timeout_from("198.51.100.20")
        self.assertIn("asleep or off", why)
        self.assertIn("remote-host discover", why)

    def test_same_lan_is_a_private_slash_24(self):
        self.assertTrue(reach.same_lan("198.51.100.5", "198.51.100.200"))
        self.assertFalse(reach.same_lan("198.51.100.5", "203.0.113.5"))
        self.assertFalse(reach.same_lan("198.51.100.5", "fe80::1"))

    def test_all_address_candidates_and_ipv6_same_lan(self):
        rows=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.2',22)),
              (socket.AF_INET6,socket.SOCK_STREAM,6,'',('::1',22,0,0))]
        with mock.patch.object(reach,'ssh_config',return_value={'hostname':'test'}), mock.patch.object(reach.socket,'getaddrinfo',return_value=rows), mock.patch.object(reach,'tcp_probe',side_effect=[('timeout','timeout'),('open','')]) as probe:
            self.assertIsNone(reach.diagnose('h'))
            self.assertEqual(probe.call_count,2)
        self.assertTrue(reach.same_lan('fd00::1','fd00::2'))
        self.assertFalse(reach.same_lan('fd00::1','fd01::1'))


class LocalNetworkPrivacy(unittest.TestCase):
    """An Electron desktop app, 2026-09-23: python sockets got EHOSTUNREACH for every LAN
    host while ssh worked, so doctor said "turn on Remote Login"."""

    def setUp(self):
        blocked = mock.patch.dict(reach.LOCAL_NETWORK_BLOCKED, python=False)
        blocked.start()
        self.addCleanup(blocked.stop)

    def blocked(self, *a, **kw):
        raise OSError(errno.EHOSTUNREACH, "No route to host")

    def test_python_blocked_but_bash_reaches_counts_as_open(self):
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
            with mock.patch.object(reach.socket, "create_connection", self.blocked):
                self.assertEqual(reach.tcp_probe("127.0.0.1", port, 3, banner=True), ("open", "SSH-2.0-test"))
            self.assertTrue(reach.LOCAL_NETWORK_BLOCKED["python"])
        finally:
            srv.close()

    def test_python_blocked_and_nothing_listens_is_refused(self):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        with mock.patch.object(reach.socket, "create_connection", self.blocked):
            self.assertEqual(reach.tcp_probe("127.0.0.1", port, 2)[0], "refused")
        self.assertTrue(reach.LOCAL_NETWORK_BLOCKED["python"])

    def test_public_address_is_not_retried(self):
        with mock.patch.object(reach.socket, "create_connection", self.blocked), \
                mock.patch.object(reach, "_bash_probe") as fallback:
            self.assertEqual(reach.tcp_probe("8.8.8.8", 22, 1), ("error", "No route to host"))
            fallback.assert_not_called()


class Proxy(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = mock.patch.dict(os.environ, {"XDG_STATE_HOME": tmp.name})
        env.start()
        self.addCleanup(env.stop)
        ssh.PROXY["on"] = False
        self.addCleanup(ssh.PROXY.update, on=False)

    def test_off_means_no_proxy(self):
        self.assertEqual(ssh.remote_argv("worker"), ["ssh", *ssh.SSH_OPTS, "worker", "bash -l -s"])
        self.assertEqual(ssh.proxy_prelude("worker"), "")

    def test_on_points_the_host_at_this_machines_address_facing_it(self):
        ssh.PROXY["on"] = True
        with mock.patch.object(ssh, "ssh_config", return_value={"hostname": "127.0.0.1"}):
            self.assertIn("HTTPS_PROXY=http://127.0.0.1:7890", ssh.proxy_prelude("box"))

    def test_remote_host_proxy_overrides_the_address(self):
        ssh.PROXY["on"] = True
        with mock.patch.dict(os.environ, {"REMOTE_HOST_PROXY": "198.18.0.9:7891"}):
            self.assertIn("ALL_PROXY=http://198.18.0.9:7891", ssh.proxy_prelude("box"))

    def test_proxy_url_is_one_safe_shell_word(self):
        ssh.PROXY["on"] = True
        payload = "198.18.0.9:7891; $(printf injected) ' \""
        with mock.patch.dict(os.environ, {"REMOTE_HOST_PROXY": payload}):
            prelude = ssh.proxy_prelude("box")
        done = subprocess.run(["bash", "-c", prelude + 'printf "%s" "$HTTPS_PROXY"'],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, "http://" + payload)
        self.assertEqual(done.stderr, "")

    def test_proxy_url_rejects_control_characters(self):
        ssh.PROXY["on"] = True
        for char in ("\0", "\t", "\n", "\r", "\x1b", "\x7f"):
            with (
                self.subTest(char=repr(char)),
                mock.patch.object(ssh, "lan_proxy", return_value="127.0.0.1:7890" + char),
            ):
                with self.assertRaisesRegex(ValueError, "control characters"):
                    ssh.proxy_prelude("box")

    def test_a_host_off_the_lan_is_refused(self):
        ssh.PROXY["on"] = True
        with mock.patch.object(ssh, "ssh_config", return_value={"hostname": "no-such-host.invalid"}):
            with self.assertRaises(SystemExit) as e:
                ssh.proxy_prelude("box")
        self.assertIn("REMOTE_HOST_PROXY", str(e.exception.code))


if __name__ == "__main__":
    unittest.main()
