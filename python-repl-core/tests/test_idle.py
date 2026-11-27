"""Unit tests for idle child-process counting in python_repl_core.idle."""
from __future__ import annotations

import os
import subprocess
import unittest
from unittest.mock import MagicMock, patch

from python_repl_core import idle


def _ps_process(stdout: str, returncode: int = 0, pid: int = 99999) -> MagicMock:
    proc = MagicMock()
    proc.pid = pid
    proc.returncode = returncode
    proc.communicate.return_value = (stdout, None)
    return proc


class IdleChildrenTests(unittest.TestCase):
    def test_counts_one_child_when_ps_pid_is_also_listed(self) -> None:
        me = os.getpid()
        pgid = os.getpgid(0)
        ps_pid = 88888
        child_pid = 77777
        stdout = f"{me} 1 {pgid}\n{ps_pid} {me} {pgid}\n{child_pid} 12345 {pgid}\n12345 1 12345\n"
        proc = _ps_process(stdout, pid=ps_pid)

        with patch("python_repl_core.idle.subprocess.Popen", return_value=proc) as popen:
            self.assertEqual(idle._children(), 1)

        popen.assert_called_once_with(
            ["ps", "-A", "-o", "pid=,ppid=,pgid="],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        proc.communicate.assert_called_once_with(timeout=5)

    def test_returns_zero_when_only_kernel_and_ps_exist(self) -> None:
        me = os.getpid()
        pgid = os.getpgid(0)
        ps_pid = 88888
        stdout = f"{me} 1 {pgid}\n{ps_pid} {me} {pgid}\n"
        proc = _ps_process(stdout, pid=ps_pid)

        with patch("python_repl_core.idle.subprocess.Popen", return_value=proc):
            self.assertEqual(idle._children(), 0)

    def test_counts_one_child_when_ps_pid_is_absent_from_output(self) -> None:
        me = os.getpid()
        pgid = os.getpgid(0)
        ps_pid = 88888
        child_pid = 77777
        stdout = f"{me} 1 {pgid}\n{child_pid} {me} {pgid}\n"
        proc = _ps_process(stdout, pid=ps_pid)

        with patch("python_repl_core.idle.subprocess.Popen", return_value=proc):
            self.assertEqual(idle._children(), 1)

    def test_checks_only_direct_children_outside_the_group_for_session_membership(self) -> None:
        me, group, session = 10, 10, 1
        rows = "10 1 10\n20 10 20\n30 10 30\n40 1 40\n50 40 10\n60 10 10\n"
        proc = _ps_process(rows, pid=60)
        with patch.object(idle.os, "getpid", return_value=me), patch.object(idle.os, "getpgid", return_value=group), \
             patch.object(idle.subprocess, "Popen", return_value=proc), \
             patch.object(idle.os, "getsid", side_effect={0: session, 20: session, 30: 30}.__getitem__) as getsid:
            # One direct child in another group, and one same-group grandchild.
            self.assertEqual(idle._children(), 2)
            self.assertEqual([call.args for call in getsid.call_args_list], [(0,), (20,), (30,)])

    def test_session_lookup_distinguishes_exit_from_unreadable_process(self) -> None:
        me, group = os.getpid(), os.getpgid(0)
        child = me + group + 1
        proc = _ps_process(f"{me} 1 {group}\n{child} {me} {child}\n", pid=child + 1)
        with patch.object(idle.subprocess, "Popen", return_value=proc):
            for error, expected in ((ProcessLookupError(), 0), (PermissionError(), -1)):
                with self.subTest(error=error), patch.object(idle.os, "getsid", side_effect=[1, error]):
                    self.assertEqual(idle._children(), expected)

    def test_incomplete_or_unreadable_process_table_keeps_the_kernel(self) -> None:
        for rows in ("", "1 0 1\n", "unreadable\n"):
            with self.subTest(rows=rows), patch.object(idle.os, "getpid", return_value=42), \
                 patch.object(idle.subprocess, "Popen", return_value=_ps_process(rows)):
                self.assertEqual(idle._children(), -1)

    def test_returns_minus_one_on_nonzero_exit(self) -> None:
        me = os.getpid()
        pgid = os.getpgid(0)
        proc = _ps_process(f"{me} 1 {pgid}\n", returncode=1)

        with patch("python_repl_core.idle.subprocess.Popen", return_value=proc):
            self.assertEqual(idle._children(), -1)

    def test_kills_and_returns_minus_one_on_timeout(self) -> None:
        proc = MagicMock()
        proc.pid = 88888
        proc.communicate.side_effect = [subprocess.TimeoutExpired(["ps"], 5), ("", None)]

        with patch("python_repl_core.idle.subprocess.Popen", return_value=proc):
            self.assertEqual(idle._children(), -1)

        proc.kill.assert_called_once_with()
        self.assertEqual(proc.communicate.call_count, 2)
        self.assertEqual(proc.communicate.call_args_list[0].kwargs, {"timeout": 5})
        self.assertEqual(proc.communicate.call_args_list[1].args, ())
