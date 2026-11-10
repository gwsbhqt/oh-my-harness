"""暂存由任务持有；不连接用户浏览器。"""
import os
from pathlib import Path
import tempfile
import unittest
from browser_control.errors import BrowserControlError
from browser_control.uploads import UploadLedger
class UploadTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.store=UploadLedger(self.root/'private'/'uploads.json')
        self.stage=Path('/tmp')/('browser-control-stage-'+os.urandom(6).hex());self.stage.mkdir(mode=0o700)
        self.name='a'*32+'-fixture.txt';self.file=self.stage/self.name
        self.file.write_text('file still readable');self.file.chmod(0o600)
        s=self.stage.stat();self.desc={'directory':str(self.stage),'device':s.st_dev,'inode':s.st_ino,'files':[self.name]}
        self.addCleanup(self.tmp.cleanup);self.addCleanup(self.clear_fixture)
    def clear_fixture(self):
        if self.stage.exists():
            for name in self.stage.iterdir():name.unlink()
            self.stage.rmdir()
    def test_retained_until_target_release_owner_isolated(self):
        self.store.register('a','Chrome','target',[self.desc],[str(self.file)])
        self.assertEqual(self.file.read_text(),'file still readable')
        self.store.release('b','Chrome');self.assertTrue(self.file.exists())
        self.store.release('a','Chrome','target');self.assertFalse(self.stage.exists())
    def test_record_restores_and_refuses_wrong_owner(self):
        self.store.register('a','Chrome','target',[self.desc],[str(self.file)])
        restored=UploadLedger(self.store.path)
        with self.assertRaises(BrowserControlError):restored.register('b','Chrome','target',[self.desc],[str(self.file)])
        restored.release('a','Chrome');self.assertFalse(self.stage.exists())
    def test_file_replacement_refuses_delete(self):
        self.store.register('a','Chrome','target',[self.desc],[str(self.file)])
        self.file.unlink();self.file.write_text('external');self.file.chmod(0o600)
        with self.assertRaises(BrowserControlError):self.store.release('a','Chrome')
        self.assertEqual(self.file.read_text(),'external')
    def test_descriptor_and_unowned_entry_refuse(self):
        for bad in ({**self.desc,'directory':'/tmp/other'},{**self.desc,'inode':0}):
            with self.assertRaises(BrowserControlError):self.store.register('a','Chrome','target',[bad],[str(self.file)])
        (self.stage/'external').write_text('external')
        with self.assertRaises(BrowserControlError):self.store.register('a','Chrome','target',[self.desc],[str(self.file)])
    def test_corrupt_ledger_fails_closed(self):
        self.store.register('a','Chrome','target',[self.desc],[str(self.file)])
        self.store.path.write_text('{}')
        with self.assertRaises(BrowserControlError):UploadLedger(self.store.path)
if __name__=='__main__':unittest.main()
