"""Synthetic metadata-only external export binding; never inspect Core bytes."""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from codex_service.attachment_exports import bind, shape, ENVIRONMENT
from codex_service.contract import Refused


class ExportShapeTests(unittest.TestCase):
    def test_closed_absolute_shape_and_overlap_before_metadata(self):
        for value in (None, True, 7, '/', 'relative', '/a//b', '/a/../b', '/a/', '/x\0y'):
            with self.subTest(value=value), self.assertRaises(Refused):
                shape(value)
        with patch.object(Path, 'lstat', side_effect=AssertionError('private metadata read')):
            for value in ('/private/core', '/private/core/export', '/private'):
                with self.assertRaisesRegex(Refused, 'scope_overlap'):
                    bind(value, 62001, 62003, ['/private/core'])


@unittest.skipUnless(os.geteuid() == 0, 'root-only synthetic custody fixture')
class ExportPackageTests(unittest.TestCase):
    def setUp(self):
        from codex_service_fixture import ServiceFixture, UID, GID
        self.uid, self.gid = UID, GID
        self.fixture = ServiceFixture(); self.addCleanup(self.fixture.close)
        self.fixture.prepare()
        self.exports = self.fixture.root / 'external-exports'
        self.exports.mkdir(mode=0o700); os.chown(self.exports, UID, GID)

    def package(self, value):
        from codex_bounded.trust import digest
        from codex_service.package import Package
        service = self.fixture.package / 'service.json'
        descriptor = json.loads(service.read_text()); descriptor['attachment_export_dir'] = value
        service.write_text(json.dumps(descriptor))
        manifest = self.fixture.package / 'manifest.json'; metadata = json.loads(manifest.read_text())
        metadata['files']['service.json'] = digest(service); manifest.write_text(json.dumps(metadata))
        return Package(self.fixture.package, digest(manifest))

    def test_optional_legacy_and_current_external_root_environment(self):
        from codex_service.package import Package
        from codex_bounded.trust import digest
        legacy = Package(self.fixture.package, digest(self.fixture.package / 'manifest.json'))
        self.assertNotIn(ENVIRONMENT, legacy.environment())
        for mode in (0o700, 0o750):
            self.exports.chmod(mode)
            selected = self.package(str(self.exports))
            self.assertEqual(selected.attachment_export_dir, self.exports)
            self.assertEqual(selected.environment()[ENVIRONMENT], str(self.exports))

    def test_refuses_core_account_workspace_ledger_overlap_and_alias(self):
        for path in (self.fixture.home / 'exports', self.fixture.account,
                     self.fixture.workspace, self.fixture.ledger_directory):
            with self.subTest(path=path), self.assertRaisesRegex(Refused, 'scope_overlap'):
                self.package(str(path))
        alias = self.fixture.root / 'export-alias'; alias.symlink_to(self.exports)
        with self.assertRaisesRegex(Refused, 'ancestor'):
            self.package(str(alias))

    def test_refuses_wrong_owner_group_or_mode_without_changing_metadata(self):
        for uid, gid, mode in ((0, self.gid, 0o700), (self.uid, 0, 0o700),
                               (self.uid, self.gid, 0o710), (self.uid, self.gid, 0o770)):
            os.chown(self.exports, uid, gid); self.exports.chmod(mode)
            with self.subTest(uid=uid, gid=gid, mode=mode), self.assertRaises(Refused):
                self.package(str(self.exports))
            meta = self.exports.stat()
            self.assertEqual((meta.st_uid, meta.st_gid, meta.st_mode & 0o777), (uid, gid, mode))
