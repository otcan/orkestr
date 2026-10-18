"""Owned synthetic bytes and kernel locks only; no SQLite/server is running."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import stopped_copy


class StoppedCopyTests(unittest.TestCase):
    def fixture(self, root):
        home=root/'home';(home/'control').mkdir(parents=True);(home/'data').mkdir()
        for name in ('core.sqlite3','core.sqlite3-wal','core.sqlite3-shm'):
            (home/'data'/name).write_bytes(('synthetic '+name).encode())
        return home

    def copy(self,source,destination):
        with patch.object(stopped_copy,'private_home',side_effect=lambda path:path),patch.object(stopped_copy,'fresh_path',side_effect=lambda path,protected:path):
            return stopped_copy.copy_home(source,destination)

    def test_whole_database_wal_shm_bytes_and_independent_inodes(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);home=self.fixture(root);target=root/'copy'
            self.copy(home,target)
            for name in ('core.sqlite3','core.sqlite3-wal','core.sqlite3-shm'):
                self.assertEqual((home/'data'/name).read_bytes(),(target/'data'/name).read_bytes())
                self.assertNotEqual((home/'data'/name).stat().st_ino,(target/'data'/name).stat().st_ino)

    def test_busy_source_refuses_without_copy(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);home=self.fixture(root);target=root/'copy'
            with stopped_copy.locked(home),self.assertRaisesRegex(RuntimeError,'busy'):
                self.copy(home,target)
            self.assertFalse(target.exists())

    def test_symlink_or_stale_socket_marker_refuses_before_copy(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);home=self.fixture(root);target=root/'copy'
            (home/'control/launcher.sock').symlink_to(home/'missing')
            with self.assertRaisesRegex(RuntimeError,'stopped home'):self.copy(home,target)
            self.assertFalse(target.exists())

    def test_incomplete_copy_refused(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);home=self.fixture(root);target=root/'copy'
            real=stopped_copy.shutil.copytree
            def incomplete(source,destination,*args,**kwargs):
                result=real(source,destination,*args,**kwargs)
                if Path(source)==home:(Path(destination)/'data/core.sqlite3-wal').unlink()
                return result
            with patch.object(stopped_copy.shutil,'copytree',side_effect=incomplete),self.assertRaisesRegex(RuntimeError,'incomplete'):
                self.copy(home,target)
            self.assertTrue((home/'data/core.sqlite3-wal').exists())
