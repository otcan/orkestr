"""Synthetic stopped-service metadata; never stops a service or opens Core."""
import fcntl
import contextlib
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from codex_service.password_recovery import configuration, stopped, manager_lock, password, main

CONFIG = {'unit':'synthetic.service','cgroup':'/system.slice/synthetic.service'}


class RecoveryConfigurationTests(unittest.TestCase):
    def test_closed_service_and_cgroup_contract(self):
        self.assertEqual(configuration(CONFIG), CONFIG)
        for value in (None, {}, CONFIG | {'extra':True}, CONFIG | {'unit':'--other.service'},
                      CONFIG | {'cgroup':'/system.slice/other.service'},
                      CONFIG | {'cgroup':'/../synthetic.service'}):
            with self.subTest(value=value), self.assertRaises(Exception):
                configuration(value)

    def test_active_wrong_or_populated_unit_never_qualifies_as_stopped(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            group = base/'system.slice/synthetic.service'
            group.mkdir(parents=True)
            (group/'cgroup.events').write_text('populated 0\nfrozen 0\n')
            def runner(text):
                return lambda *_args,**_kwargs: subprocess.CompletedProcess([],0,text,'')
            good = 'LoadState=loaded\nActiveState=inactive\nMainPID=0\nControlGroup=/system.slice/synthetic.service\n'
            stopped(CONFIG,runner(good),base)
            with self.assertRaisesRegex(Exception,'unit_unknown'):
                stopped(CONFIG,runner('LoadState=not-found\nActiveState=inactive\nMainPID=0\nControlGroup=\n'),base)
            for bad in (good.replace('inactive','active'),good.replace('MainPID=0','MainPID=123'),
                        good.replace('/system.slice/synthetic.service','/system.slice/other.service')):
                with self.assertRaises(Exception):
                    stopped(CONFIG,runner(bad),base)
            (group/'cgroup.events').write_text('populated 1\nfrozen 0\n')
            with self.assertRaisesRegex(Exception,'children_present'):
                stopped(CONFIG,runner(good),base)

    def test_cgroup_alias_refused(self):
        with tempfile.TemporaryDirectory() as root:
            base=Path(root);(base/'system.slice').mkdir();(base/'target').mkdir()
            (base/'target/cgroup.events').write_text('populated 0\n')
            (base/'system.slice/synthetic.service').symlink_to(base/'target')
            runner=lambda *_args,**_kwargs: subprocess.CompletedProcess([],0,'LoadState=loaded\nActiveState=inactive\nMainPID=0\nControlGroup=\n','')
            with self.assertRaisesRegex(Exception,'cgroup_alias'):
                stopped(CONFIG,runner,base)

    def test_secret_pipe_is_bounded_and_not_an_argument(self):
        read,write=os.pipe()
        try:
            os.write(write,b'synthetic-recovery-password\n');os.close(write);write=None
            self.assertEqual(password(read),'synthetic-recovery-password')
        finally:
            os.close(read)
            if write is not None:os.close(write)

    def test_invalid_cli_arguments_never_echo_accidental_secret_values(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(main(None,['--username','synthetic','--password','NEVER-EXPORT']),2)
        self.assertNotIn('NEVER-EXPORT',output.getvalue())
        self.assertIn('operator_recovery_arguments',output.getvalue())


@unittest.skipUnless(os.geteuid()==0,'root-only lock custody fixtures')
class RecoveryLockTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='recovery-lock-',dir='/root')
        self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name)
        self.path=self.root/'manager.lock';self.path.touch(mode=0o600)

    def test_exact_existing_lock_excludes_active_manager(self):
        first,info=manager_lock(self.root)
        try:
            self.assertEqual((info.st_dev,info.st_ino),(self.path.stat().st_dev,self.path.stat().st_ino))
            with self.assertRaises(BlockingIOError):manager_lock(self.root)
        finally:os.close(first)
        second,_=manager_lock(self.root);os.close(second)

    def test_missing_or_linked_manager_lock_is_not_replaced(self):
        self.path.unlink()
        with self.assertRaises(Exception):manager_lock(self.root)
        self.assertFalse(self.path.exists())
        target=self.root/'other';target.touch(mode=0o600);self.path.symlink_to(target)
        with self.assertRaises(Exception):manager_lock(self.root)
        self.assertEqual(target.stat().st_size,0)
