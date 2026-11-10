"""元数据探针必须立即拒绝FIFO，避免等业务超时。"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from browser_control.transport import _META
class MetadataGuard(unittest.TestCase):
    def test_fifo_rejected_without_writer(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'fifo';os.mkfifo(path)
            result=subprocess.run([sys.executable,'-c',_META,str(path)],capture_output=True,text=True,timeout=2)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('artifact must be owned regular file',result.stderr)
    def test_regular_metadata_and_oversize_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'file';path.write_text('metadata')
            result=subprocess.run([sys.executable,'-c',_META,str(path)],capture_output=True,text=True,timeout=2)
            self.assertEqual(result.returncode,0,result.stderr)
            with path.open('r+b') as f:f.truncate(256*1024*1024+1)
            result=subprocess.run([sys.executable,'-c',_META,str(path)],capture_output=True,text=True,timeout=2)
            self.assertNotEqual(result.returncode,0);self.assertIn('256 MiB',result.stderr)
if __name__=='__main__':unittest.main()
