"""实际多进程默认目标配置更新与载荷权限回归。"""
import os
import sys
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
SHARED = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SHARED))
from agentkit.remote import pins, ssh

class SharedState(unittest.TestCase):
    def test_atomic_parallel_read_modify_write_keeps_every_update(self):
        with tempfile.TemporaryDirectory() as temp:
            code = """import sys,time
from agentkit.remote import pins
with pins.pin_lock('computer-use'):
 p=pins.read_pin('computer-use')
 time.sleep(.02)
 p.setdefault('hosts',{})[sys.argv[1]]={'cwd':sys.argv[1]}
 pins.write_pin(p,'computer-use')
"""
            env = dict(os.environ, XDG_STATE_HOME=temp, PYTHONPATH=str(SHARED))
            children = [subprocess.Popen([sys.executable, "-c", code, str(i)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for i in range(12)]
            for child in children:
                out, err = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 0, err.decode())
            path = Path(temp) / "computer-use/pin.json"
            self.assertEqual(len(json.loads(path.read_text())["hosts"]), len(children))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_script_staging_is_private(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "payload.sh"
            done = subprocess.run(["bash", "-c", "umask 022\n"+ssh.stash_here(str(path), "true")], capture_output=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

if __name__ == "__main__": unittest.main()
