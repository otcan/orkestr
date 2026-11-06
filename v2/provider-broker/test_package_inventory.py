"""A fast inventory walk retains Root custody and fresh per-check observations."""
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from codex_service.package import Package
from codex_service.contract import Refused
from codex_bounded.trust import Refused as CustodyRefused


@unittest.skipUnless(os.geteuid() == 0, 'Root package custody fixture')
class PackageInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='package-inventory-', dir='/')
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        self.root = self.parent / 'package'
        self.root.mkdir(mode=0o750)
        (self.root / 'sub').mkdir(mode=0o750)
        for name in ('module.py', 'sub/helper.py'):
            p = self.root / name
            p.write_text('synthetic fixture code\n')
            p.chmod(0o440)
        self.package = SimpleNamespace(root=self.root,
                                      inventory={'module.py', 'sub/helper.py'})

    def check(self):
        Package.verify_inventory(self.package)

    def test_exact_inventory_and_empty_directories_remain_valid(self):
        self.check()
        (self.root / 'empty').mkdir(mode=0o750)
        self.check()

    def test_unlisted_files_and_missing_files_refuse(self):
        extra = self.root / 'sub/unlisted.py'
        extra.write_text('synthetic extra')
        with self.assertRaises((Refused, CustodyRefused)):
            self.check()
        extra.unlink()
        (self.root / 'module.py').unlink()
        with self.assertRaises((Refused, CustodyRefused)):
            self.check()

    def test_file_directory_and_package_symlinks_refuse(self):
        for name in ('module.py', 'sub'):
            original = self.root / name
            retained = self.parent / ('retained-' + name)
            original.rename(retained)
            original.symlink_to(retained)
            with self.assertRaises((Refused, CustodyRefused)):
                self.check()
            original.unlink()
            retained.rename(original)
        alias = self.parent / 'alias'
        alias.symlink_to(self.root)
        self.package.root = alias
        with self.assertRaises((Refused, CustodyRefused)):
            self.check()

    def test_next_check_observes_hard_links_and_write_permissions(self):
        self.check()
        original = self.root / 'module.py'
        link = self.parent / 'hard-link'
        os.link(original, link)
        with self.assertRaises((Refused, CustodyRefused)):
            self.check()
        link.unlink()
        for path in (original, self.root / 'sub', self.parent):
            before = path.stat().st_mode & 0o777
            path.chmod(before | 0o020)
            with self.assertRaises((Refused, CustodyRefused)):
                self.check()
            path.chmod(before)
        self.check()

    def test_foreign_owners_and_special_files_refuse(self):
        original = self.root / 'module.py'
        os.chown(original, 65534, -1)
        with self.assertRaises((Refused, CustodyRefused)):
            self.check()
        os.chown(original, 0, -1)
        original.unlink()
        os.mkfifo(original, 0o600)
        with self.assertRaises((Refused, CustodyRefused)):
            self.check()


if __name__ == '__main__':
    unittest.main()
