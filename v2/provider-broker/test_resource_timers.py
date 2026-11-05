"""Core keeps timer authority; native readers receive only a live read-only view."""
import os
from pathlib import Path
import shutil
import subprocess
import unittest

import test_resource_namespace as fixture
from codex_service.contract import Refused
from codex_service.resource_contract import context
from codex_service.resource_namespace import Activation
from codex_service.resource_receipt import verify, ns

CORE, EXEC = fixture.CORE, fixture.EXEC


@unittest.skipUnless(os.geteuid() == 0, 'Root namespace kernel fixture')
class TimerGrantNamespaceTests(unittest.TestCase):
    directory = fixture.ResourceNamespaceTests.directory
    file = fixture.ResourceNamespaceTests.file
    save = fixture.ResourceNamespaceTests.save

    def setUp(self):
        fixture.ResourceNamespaceTests.setUp(self)
        self.grants = self.directory('timer-source', CORE)
        os.chown(self.grants, CORE, EXEC)
        self.grant = self.file('timer-source/synthetic.grant', CORE, b'a' * 64)
        os.chown(self.grant, CORE, EXEC)
        self.reader = self.provider / 'agent-timer-grants'
        self.runtime['agent_timer_grants'] = dict(source=str(self.grants), target=str(self.reader))
        self.ctx = context(self.runtime, self.beta, self.profile, self.claude_config)
        info = self.grants.stat()
        self.row = dict(kind='agent_timer_grants', source=str(self.grants), target=str(self.reader),
                        uid=CORE, gid=EXEC, device=info.st_dev, inode=info.st_ino)
        self.doc['resources'].append(self.row)
        self.save()

    def actor(self, uid, script, *args):
        result = subprocess.run(['/usr/bin/python3', '-I', '-S', '-B', '-c', script, *map(str, args)],
                                user=uid, group=EXEC, extra_groups=[], capture_output=True, text=True,
                                env={'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1'}, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_core_atomic_refresh_is_readable_without_native_write_or_authority_access(self):
        # This byte-exact helper copy comes from the tested immutable source;
        # synthetic actors need no access to that source's private export parent.
        tool = self.root / 'agent_timer.py'
        shutil.copyfile(Path(__file__).resolve().parents[1] / 'tools/agent_timer.py', tool)
        tool.chmod(0o444)
        script = (
            'import importlib.util,os,sys;from pathlib import Path;'
            's=importlib.util.spec_from_file_location("timer",sys.argv[1]);'
            'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);'
            'p=Path(sys.argv[2]);assert m.read_grant(p)==sys.argv[3]*64;'
            'assert p.stat().st_uid==os.getuid();'
            'assert p.stat().st_mode&0o777==0o600;'
            '\nfor op in (lambda:p.write_text("foreign"),lambda:p.unlink(),'
            'lambda:(p.parent/"minted.grant").write_text("foreign")):'
            '\n try:op()'
            '\n except OSError as e:assert e.errno==30'
            '\n else:raise AssertionError("native grant mutation allowed")'
            '\nfor p in sys.argv[4:]:'
            '\n try:Path(p).read_bytes()'
            '\n except OSError as e:assert e.errno in (1,13)'
            '\n else:raise AssertionError("Core authority exposed")'
        )
        before = self.grants.stat()
        with Activation(self.selected, self.ctx):
            target = self.reader / self.grant.name
            self.actor(EXEC, script, tool, target, 'a', self.grant, self.core / 'bootstrap')
            self.actor(CORE,
                       'import os,sys;from pathlib import Path;p=Path(sys.argv[1]);'
                       'q=p.with_suffix(".new");f=os.open(q,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);'
                       'os.write(f,b"b"*64);os.fsync(f);os.close(f);os.replace(q,p)', self.grant)
            self.actor(EXEC, script, tool, target, 'b', self.grant, self.core / 'bootstrap')
            self.assertEqual((target.stat().st_dev, target.stat().st_ino),
                             (self.grant.stat().st_dev, self.grant.stat().st_ino))
            self.assertEqual(self.grant.stat().st_uid, CORE)
            verify(self.selected, self.ctx)
        after = self.grants.stat()
        self.assertEqual((before.st_uid, before.st_ino, before.st_mode),
                         (after.st_uid, after.st_ino, after.st_mode))

    def test_wrong_owner_target_source_and_missing_projection_are_refused(self):
        initial = ns('mnt')
        for key, changed in [('uid', fixture.OLD), ('target', str(self.provider / 'foreign')),
                             ('source', str(self.core))]:
            original = self.row[key]
            self.row[key] = changed
            self.save()
            with self.assertRaises(Refused):
                with Activation(self.selected, self.ctx):
                    self.fail('unbound grant selection admitted')
            self.assertEqual(ns('mnt'), initial)
            self.row[key] = original
        self.doc['resources'].remove(self.row)
        self.save()
        with self.assertRaisesRegex(Refused, 'resource_timer_set'):
            with Activation(self.selected, self.ctx):
                pass
        self.doc['resources'].append(self.row)
        self.runtime.pop('agent_timer_grants')
        self.ctx = context(self.runtime, self.beta, self.profile, self.claude_config)
        self.save()
        with self.assertRaisesRegex(Refused, 'resource_timer_binding'):
            with Activation(self.selected, self.ctx):
                pass

    def test_private_source_mode_and_retained_directory_identity_are_rechecked(self):
        self.grants.chmod(0o750)
        with self.assertRaisesRegex(Refused, 'resource_timer_private_mode'):
            with Activation(self.selected, self.ctx):
                pass
        self.grants.chmod(0o700)
        with Activation(self.selected, self.ctx):
            original = self.grants.with_suffix('.original')
            self.grants.rename(original)
            self.grants.mkdir(mode=0o700)
            os.chown(self.grants, CORE, EXEC)
            with self.assertRaisesRegex(Refused, 'resource_source_changed'):
                verify(self.selected, self.ctx)


if __name__ == '__main__':
    unittest.main()
