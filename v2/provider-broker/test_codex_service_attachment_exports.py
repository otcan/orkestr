"""Synthetic metadata-only external export binding; never inspect Core bytes."""
import json
import os
from pathlib import Path
import unittest
import subprocess
import sys
from types import SimpleNamespace
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

    def split(self):
        return SimpleNamespace(attachment_export_dir=self.exports, identity_split=True,
                               authority_uid=self.uid, gid=self.gid,
                               owner='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')

    def test_root_initializes_empty_scope_and_capsule_selects_only_that_mount(self):
        from codex_service.attachment_exports import initialize_conversation, conversation_mount
        package=self.split(); conversation='11111111-1111-4111-8111-111111111111'
        initialize_conversation(package,conversation)
        own=self.exports/conversation
        self.assertEqual(list(own.iterdir()),[])
        self.assertEqual((own.stat().st_uid,own.stat().st_gid,own.stat().st_mode&0o777),
                         (self.uid,self.gid,0o750))
        marker=own/'later-publication';marker.write_bytes(b'preserve');marker.chmod(0o640)
        os.chown(marker,self.uid,self.gid)
        initialize_conversation(package,conversation)
        self.assertEqual(marker.read_bytes(),b'preserve')
        with patch('codex_service.identity.launch_context',return_value=None):
            with self.assertRaisesRegex(Refused,'launch_context'):conversation_mount(package,'deep')
        capsule=dict(owner_id=package.owner,conversation_id=conversation,role='deep')
        with patch('codex_service.identity.launch_context',return_value=capsule):
            self.assertEqual(conversation_mount(package,'deep'),own)
            with self.assertRaisesRegex(Refused,'launch_context'):conversation_mount(package,'fast')
        own.chmod(0o770)
        with self.assertRaisesRegex(Refused,'scope'):initialize_conversation(package,conversation)

    def test_production_command_binds_capsule_conversation_readonly_at_same_path(self):
        from codex_service.attachment_exports import initialize_conversation
        from codex_service.profile import Configuration
        package=self.split();package.root=self.fixture.package
        conversation='11111111-1111-4111-8111-111111111111'
        initialize_conversation(package,conversation)
        config=object.__new__(Configuration);config.package=package;config.role='deep'
        config.issued=False;config.host_full_access=False
        config.profile=SimpleNamespace(_command=lambda *_:['bwrap','--chdir','/','native'])
        descriptor=os.open('/dev/null',os.O_RDONLY)
        capsule=dict(owner_id=package.owner,conversation_id=conversation,role='deep')
        try:
            with patch('codex_service.profile.policy.filter_fd',return_value=descriptor), \
                 patch('codex_service.profile.protected',side_effect=lambda p:p), \
                 patch('codex_service.identity.launch_context',return_value=capsule):
                command,fds=config.isolated_command()
            own=str(self.exports/conversation)
            self.assertIn(['--ro-bind',own,own],[command[i:i+3] for i in range(len(command))])
            self.assertNotIn(str(self.exports),command)
            self.assertEqual(fds,(descriptor,))
        finally:os.close(descriptor)

    def test_real_namespace_reads_own_export_only_and_refuses_writes(self):
        from codex_service.attachment_exports import initialize_conversation
        package=self.split(); conversation='11111111-1111-4111-8111-111111111111'
        other='22222222-2222-4222-8222-222222222222'
        for name in (conversation,other):
            initialize_conversation(package,name)
            item=self.exports/name/'file';item.write_bytes(b'authorized synthetic export')
            item.chmod(0o640);os.chown(item,self.uid,self.gid)
        own=self.exports/conversation
        core=self.fixture.home/'core.sqlite3';core.write_bytes(b'private synthetic Core')
        keydir=self.fixture.home/'keys';keydir.mkdir(mode=0o700)
        key=keydir/'attachment-ingest.age';key.write_bytes(b'private synthetic key')
        for path in (self.fixture.home,keydir,core,key):
            os.chown(path,self.uid-1,self.gid)
            path.chmod(0o700 if path.is_dir() else 0o600)
        self.assertTrue(core.is_file() and key.is_file())
        command=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session']
        for path in ('/usr','/lib','/lib64'):
            if Path(path).exists():command+=['--ro-bind',path,path]
        command+=['--proc','/proc','--dev','/dev','--tmpfs','/tmp','--ro-bind',str(own),str(own),
                  '--','/usr/bin/python3','-I','-S','-B','-c',
                  "from pathlib import Path;import sys,errno\np=Path(sys.argv[1]);assert (p/'file').read_bytes()==b'authorized synthetic export'\nprint('ready',flush=True);assert sys.stdin.read(1)=='G';assert (p/'later').read_bytes()==b'later publication'\nfor item in sys.argv[2:]:\n try:open(item,'rb')\n except OSError:pass\n else:raise AssertionError('foreign/private path visible')\ntry:(p/'write').write_bytes(b'no')\nexcept OSError as e:assert e.errno==errno.EROFS\nelse:raise AssertionError('export writable')\nprint('own-read foreign-core-key-denied readonly')",
                  str(own),str(self.exports/other/'file'),str(self.fixture.home/'core.sqlite3'),
                  str(self.fixture.home/'keys/attachment-ingest.age')]
        child=subprocess.Popen(command,user=self.uid,group=self.gid,extra_groups=[],stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
                               env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'})
        try:
            self.assertEqual(child.stdout.readline().strip(),'ready')
            later=own/'later';later.write_bytes(b'later publication');later.chmod(0o640)
            os.chown(later,self.uid,self.gid)
            stdout,stderr=child.communicate('G',timeout=15)
            self.assertEqual(child.returncode,0,stderr)
            self.assertEqual(stdout.strip(),'own-read foreign-core-key-denied readonly')
        finally:
            if child.poll() is None:child.kill();child.wait()
