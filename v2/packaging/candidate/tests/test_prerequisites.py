"""Synthetic dependency checks; no namespaces or product processes started."""
import stat
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'local-install'))
import prerequisites as p


class PrerequisiteTests(unittest.TestCase):
    def test_inventory_and_sanitized_probe(self):
        binary={'sha256':'a'*64}
        with patch.object(p,'trusted_binary',return_value=binary), patch.object(p.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=p.MARKER,stderr='')) as run:
            value=p.check()
        self.assertEqual(value['bwrap'],binary)
        self.assertTrue(value['pid_namespace'])
        args,kw=run.call_args
        self.assertIn('--die-with-parent',args[0]);self.assertIn('--unshare-user',args[0])
        self.assertEqual(kw['env'],{'PATH':'/usr/bin:/bin','LANG':'C'})
        self.assertEqual(kw['timeout'],10)

    def test_namespace_failure_retains_diagnostics(self):
        with patch.object(p,'trusted_binary',return_value={}), patch.object(p.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout='',stderr='user namespaces denied')):
            with self.assertRaisesRegex(p.PrerequisiteError,'user namespaces denied') as caught:p.check()
        self.assertEqual(caught.exception.code,'namespace_unavailable')

    def test_timeout_typed(self):
        with patch.object(p,'trusted_binary',return_value={}), patch.object(p.subprocess,'run',side_effect=p.subprocess.TimeoutExpired('bwrap',10)):
            with self.assertRaises(p.PrerequisiteError) as caught:p.check()
        self.assertEqual(caught.exception.code,'namespace_probe_failed')

    def test_dependency_change_refused(self):
        with patch.object(p,'trusted_binary',side_effect=[{'sha256':'a'},{'sha256':'b'}]), patch.object(p.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=p.MARKER,stderr='')):
            with self.assertRaisesRegex(p.PrerequisiteError,'dependency_changed'):p.check()

    def test_target_refusal(self):
        with patch.object(p.platform,'system',return_value='Darwin'):
            with self.assertRaisesRegex(p.PrerequisiteError,'unsupported_target'):p.trusted_binary()

    def binary_check(self,mode=stat.S_IFREG|0o755,uid=0,data=None):
        data=data if data is not None else b'\x7fELF\x02\x01'+b'\0'*12+b'\x3e\x00'
        with patch.object(p.platform,'system',return_value='Linux'), patch.object(p.platform,'machine',return_value='x86_64'), patch.object(Path,'lstat',return_value=SimpleNamespace(st_uid=uid,st_mode=mode)), patch.object(Path,'read_bytes',return_value=data):
            return p.trusted_binary()

    def test_trusted_native_binary(self):self.assertEqual(self.binary_check()['mode'],0o755)

    def test_untrusted_modes_and_owner(self):
        for mode,uid in ((stat.S_IFLNK|0o777,0),(stat.S_IFREG|0o775,0),(stat.S_IFREG|0o4755,0),(stat.S_IFREG|0o755,1000),(stat.S_IFREG|0o644,0)):
            with self.subTest(mode=mode,uid=uid),self.assertRaisesRegex(p.PrerequisiteError,'untrusted_dependency'):self.binary_check(mode,uid)

    def test_architecture_refusal(self):
        with self.assertRaisesRegex(p.PrerequisiteError,'architecture_mismatch'):self.binary_check(data=b'not ELF')

    def test_missing_dependency(self):
        with patch.object(p.platform,'system',return_value='Linux'),patch.object(p.platform,'machine',return_value='x86_64'),patch.object(Path,'lstat',side_effect=FileNotFoundError()):
            with self.assertRaisesRegex(p.PrerequisiteError,'missing_dependency'):p.trusted_binary()

    def test_persistent_cli_refuses_before_gate_or_server(self):
        import persistent
        argv=['persistent.py','--plan','/private/plan','start','--validator','/validator','--evidence','/evidence','--scope','/scope','--artifact-root','/artifacts','--max-latency-ms','1000','--max-rss-bytes','1000000']
        with patch.object(sys,'argv',argv),patch.object(persistent,'load',return_value={'candidate':'/candidate','home':'/home'}),patch.object(p,'check',side_effect=p.PrerequisiteError('namespace_unavailable','denied')),patch.object(persistent,'candidate_gate') as gate,patch.object(persistent,'serve') as serve:
            with self.assertRaisesRegex(p.PrerequisiteError,'namespace_unavailable'):persistent.main()
        gate.assert_not_called();serve.assert_not_called()

    def test_persistent_cli_binds_inventory(self):
        import persistent
        argv=['persistent.py','--plan','/private/plan','start','--validator','/validator','--evidence','/evidence','--scope','/scope','--artifact-root','/artifacts','--max-latency-ms','1000','--max-rss-bytes','1000000']
        inventory={'bwrap':{'sha256':'a'*64}}
        with patch.object(sys,'argv',argv),patch.object(persistent,'load',return_value={'candidate':'/candidate','home':'/home'}),patch.object(p,'check',return_value=inventory),patch.object(persistent,'candidate_gate',return_value={}),patch.object(persistent,'serve') as serve:
            persistent.main()
        self.assertEqual(serve.call_args.args[1]['execution_dependencies'],inventory)

    def test_unreadable_dependency_typed(self):
        with patch.object(p.platform,'system',return_value='Linux'),patch.object(p.platform,'machine',return_value='x86_64'),patch.object(Path,'lstat',return_value=SimpleNamespace(st_uid=0,st_mode=stat.S_IFREG|0o755)),patch.object(Path,'read_bytes',side_effect=PermissionError('denied')):
            with self.assertRaisesRegex(p.PrerequisiteError,'unreadable_dependency'):p.trusted_binary()

    def test_native_doctor_explicit_check(self):
        import launcher
        from contextlib import ExitStack
        with ExitStack() as stack:
            stack.enter_context(patch.object(launcher,'private_home',return_value=Path('/synthetic')))
            stack.enter_context(patch.object(launcher,'identity',return_value={}))
            stack.enter_context(patch.object(launcher,'config',return_value={'release':'fixture','port':19842}))
            stack.enter_context(patch.object(launcher,'child_environment'))
            stack.enter_context(patch.object(launcher,'control_path'))
            stack.enter_context(patch.object(launcher,'locked'))
            probe=stack.enter_context(patch.object(p,'check',return_value={'scope':'synthetic'}))
            self.assertIn('unexecuted',launcher.doctor(Path('/synthetic'))['execution_prerequisites'])
            probe.assert_not_called()
            self.assertEqual(launcher.doctor(Path('/synthetic'),execution_prerequisites=True)['execution_prerequisites'],{'scope':'synthetic'})
            probe.assert_called_once_with()
