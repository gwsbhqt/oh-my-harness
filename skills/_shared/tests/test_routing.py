"""机器选择参数在不同工具入口和命令参数中的边界。"""

import contextlib
import io
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agentkit.remote import ssh, target


class Routing(unittest.TestCase):
    def test_routing_words_in_command_arguments(self):
        argv = ["-H", "alpha", "run", "curl", "-H", "Accept: application/json", "url"]
        self.assertEqual(target._extract(argv, "remote-host"), (argv[2:], "alpha", False))
        self.assertEqual(target._extract(["type", "Finder", "--host"], "computer-use"), (["type", "Finder", "--host"], None, False))
        self.assertEqual(target._extract(["send", "id", "-H"], "dsh-use"), (["send", "id", "-H"], None, False))
        for tool in ("computer-use", "dsh-use"):
            with self.assertRaises(ValueError):
                target._extract(["status", "-H", "alpha"], tool)

    def test_browser_use_is_rejected_before_ssh(self):
        argv = ["-H", "alpha", "status"]
        with contextlib.redirect_stderr(io.StringIO()), \
                mock.patch.object(ssh, "known_hosts") as hosts, \
                mock.patch.object(ssh, "run_remote") as remote:
            with self.assertRaisesRegex(ValueError, "unsupported tool"):
                target.resolve_target("browser-use", "alpha")
            self.assertEqual(target.route("browser-use", argv), (argv, None, 2))
            self.assertEqual(target.dispatch("browser-use", argv), (argv, 2))
        hosts.assert_not_called()
        remote.assert_not_called()


if __name__ == "__main__":
    unittest.main()
