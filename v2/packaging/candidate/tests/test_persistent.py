"""Disposable adapter tests; no server, provider, or monitor window is launched."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import persistent


class PersistentTests(unittest.TestCase):
    def test_gate_refuses_before_launch(self):
        result=Mock(returncode=1,stdout='{}')
        with patch.object(persistent.subprocess,'run',return_value=result), self.assertRaisesRegex(RuntimeError,'gates failed'):
            persistent.candidate_gate({'revision':'a'*40},Path('validator'),Path('evidence'),Path('scope'),Path('artifacts'))

    def test_gate_revision_mismatch(self):
        result=Mock(returncode=0,stdout=json.dumps({'ready':True,'candidate_revision':'b'*40}))
        with patch.object(persistent.subprocess,'run',return_value=result), self.assertRaisesRegex(RuntimeError,'identity mismatch'):
            persistent.candidate_gate({'revision':'a'*40},Path('validator'),Path('evidence'),Path('scope'),Path('artifacts'))

    def test_monitor_failure_stops_child_retains_home_invalidates(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);home=root/'home';(home/'logs').mkdir(parents=True)
            journal=root/'journal';process=Mock();process.poll.return_value=None
            keys={'revision':'a'*40,'candidate_artifact_sha256':'b'*64,'configuration_sha256':'c'*64}
            plan={**keys,'home':str(home),'candidate':str(root/'candidate'),'port':19842}
            with patch.object(persistent,'identity',return_value=keys), patch.object(persistent,'fresh_path',side_effect=lambda p,_:p), patch.object(persistent.attended,'launch',return_value=process), patch.object(persistent.attended,'stop_owned') as stop, patch.object(persistent.soak,'measure',side_effect=RuntimeError('injected health failure')):
                with self.assertRaisesRegex(RuntimeError,'injected'):
                    persistent.serve(plan,{},journal)
            stop.assert_called_once_with(process)
            self.assertTrue(home.is_dir())
            state=json.loads((journal/'window.json').read_text())
            self.assertEqual(state['status'],'invalidated')
            self.assertEqual(state['environment'],'controlled_project_owned')

    def test_success_keeps_home_and_finalizes_after_stop(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);home=root/'home';(home/'logs').mkdir(parents=True)
            journal=root/'journal';process=Mock();process.poll.return_value=None
            keys={'revision':'a'*40,'candidate_artifact_sha256':'b'*64,'configuration_sha256':'c'*64}
            plan={**keys,'home':str(home),'candidate':str(root/'candidate'),'port':19842}
            def stopped(child):
                self.assertEqual(json.loads((journal/'window.json').read_text())['status'],'observing')
            with patch.object(persistent,'identity',return_value=keys), patch.object(persistent,'fresh_path',side_effect=lambda p,_:p), patch.object(persistent.attended,'launch',return_value=process), patch.object(persistent.attended,'stop_owned',side_effect=stopped), patch.object(persistent.attended,'resources',return_value={'rss_bytes':1}), patch.object(persistent.soak,'measure',return_value={'latency_threshold_passed':True}):
                persistent.serve(plan,{},journal,interval=0)
            self.assertTrue(home.exists())
            self.assertEqual(json.loads((journal/'window.json').read_text())['status'],'passed')

    def test_cleanup_failure_never_passes(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);home=root/'home';(home/'logs').mkdir(parents=True)
            journal=root/'journal';process=Mock();process.poll.return_value=None
            keys={'revision':'a'*40,'candidate_artifact_sha256':'b'*64,'configuration_sha256':'c'*64}
            plan={**keys,'home':str(home),'candidate':str(root/'candidate'),'port':19842}
            with patch.object(persistent,'identity',return_value=keys), patch.object(persistent,'fresh_path',side_effect=lambda p,_:p), patch.object(persistent.attended,'launch',return_value=process), patch.object(persistent.attended,'stop_owned',side_effect=RuntimeError('owned child hung')), patch.object(persistent.attended,'resources',return_value={'rss_bytes':1}), patch.object(persistent.soak,'measure',return_value={'latency_threshold_passed':True}):
                with self.assertRaisesRegex(RuntimeError,'hung'):
                    persistent.serve(plan,{},journal,interval=0)
            self.assertEqual(json.loads((journal/'window.json').read_text())['status'],'invalidated')

    def test_private_plan_tamper_refused_before_home_access(self):
        with tempfile.TemporaryDirectory() as raw:
            path=Path(raw)/'plan.json'
            value={'format':'orkestr-v2-persistent-plan-v1','port':19842}
            value['configuration_sha256']=persistent.receipt.digest(value)
            value['port']=19843
            path.write_text(json.dumps(value));path.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError,'configuration changed'):
                persistent.load(path)

    def test_identity_checks_installed_release_inventory(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);home=root/'home';candidate=root/'candidate';installed=root/'release'
            home.mkdir();(candidate/'native').mkdir(parents=True);installed.mkdir()
            (home/'install.json').write_text('{}');(candidate/'candidate.json').write_text('{}')
            (candidate/'native/manifest.json').write_text('original')
            (installed/'manifest.json').write_text('tampered')
            plan={'home':str(home),'candidate':str(candidate),'revision':'a'*40,
                  'candidate_artifact_sha256':persistent.receipt.sha(candidate/'candidate.json'),
                  'install_sha256':persistent.receipt.sha(home/'install.json'),'configuration_sha256':'c'*64}
            with patch.object(persistent,'private_home',return_value=home), patch.object(persistent.package_candidate,'verify',return_value={'source_commit':'a'*40}), patch.object(persistent,'release',return_value=({},installed,{})):
                with self.assertRaisesRegex(RuntimeError,'release differs'):
                    persistent.identity(plan)

    def test_prepare_seals_fresh_plan_without_starting(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);candidate=root/'candidate';candidate.mkdir()
            (candidate/'candidate.json').write_text('{}');home=root/'home';plan=root/'plan.json'
            def install(*args):
                home.mkdir();(home/'install.json').write_text('{"port":19842}')
            with patch.object(persistent.package_candidate,'verify',return_value={'source_commit':'a'*40}), patch.object(persistent,'fresh_path',side_effect=lambda p,_:p), patch.object(persistent.attended,'invoke',side_effect=install) as invoke:
                value=persistent.prepare(candidate,home,plan,19842)
            self.assertEqual(invoke.call_args.args[1],'install')
            self.assertEqual(value['providers'],'none')
            self.assertEqual(plan.stat().st_mode&0o777,0o600)
            seal=value.pop('configuration_sha256')
            self.assertEqual(seal,persistent.receipt.digest(value))


    def test_fifo_and_directory_plan_refused_before_read(self):
        import os
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);fifo=root/'plan.fifo'
            os.mkfifo(fifo,0o600)
            for path in (fifo,root):
                with patch.object(Path,'read_text',side_effect=AssertionError('must not read special file')):
                    with self.assertRaisesRegex(RuntimeError,'regular private plan required'):
                        persistent.load(path)
