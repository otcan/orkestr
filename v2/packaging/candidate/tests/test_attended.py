"""Bounded supervisor validation; no server/build/Docker."""
import os
import json
from pathlib import Path
import sys
import unittest
import tempfile
from unittest.mock import MagicMock
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import attended

class AttendedTests(unittest.TestCase):
    def test_bounds_fail_before_package_or_launch(self):
        for args in [(1,1,100,1024),(601,0,100,1024),(600,5,100,1024),(2,1,float('nan'),1024),(2,1,100,0)]:
            with patch.object(attended.package_candidate,'verify') as verify:
                with self.assertRaises(RuntimeError):attended.exercise(Path('/missing'),Path('/missing'),19842,*args)
                verify.assert_not_called()

    def test_owned_group_resources_are_observed_read_only(self):
        value=attended.resources(os.getpgrp())
        self.assertGreaterEqual(value['processes'],1)
        self.assertGreater(value['rss_bytes'],0)

    def test_threshold_failure_stops_exact_owned_process_and_retains_diagnostic(self):
        with tempfile.TemporaryDirectory(prefix='v2-attended-test-') as directory:
            parent=Path(directory);owned=parent/'owned';owned.mkdir()
            (owned/'home/control').mkdir(parents=True)
            (owned/'home/control/bootstrap.token').write_text('synthetic')
            process=MagicMock();process.poll.return_value=None;process.pid=os.getpgrp()
            with patch.object(attended.package_candidate,'verify',return_value={'source_commit':'a'*40}), \
                 patch.object(attended.tempfile,'mkdtemp',return_value=str(owned)), \
                 patch.object(attended,'invoke'), patch.object(attended,'launch',return_value=process), \
                 patch.object(attended,'smoke',return_value=('/synthetic',{},{})), \
                 patch.object(attended.soak,'measure',return_value={'successes':0,'latency_threshold_passed':False}), \
                 patch.object(attended,'resources',return_value={'rss_bytes':1}), \
                 patch.object(attended,'stop_owned') as stop:
                with self.assertRaisesRegex(RuntimeError,'threshold failed'):
                    attended.exercise(parent/'candidate',parent,19842,2,0,100,1024)
            stop.assert_called_once_with(process)
            self.assertTrue((owned/'private.log').exists())

    def test_home_removal_failure_persists_invalidated_window(self):
        with tempfile.TemporaryDirectory(prefix='v2-attended-cleanup-test-') as directory:
            parent=Path(directory);owned=parent/'owned';owned.mkdir()
            identity=dict(zip(attended.segments.KEYS,('a'*40,'b'*64,'c'*64)))
            journal=attended.segments.Journal(parent/'journal',identity)
            with patch.object(attended.shutil,'rmtree',side_effect=OSError('synthetic removal failure')):
                with self.assertRaisesRegex(OSError,'synthetic removal failure'):
                    attended.finish_home(owned,True,journal)
            state=json.loads((parent/'journal/window.json').read_text())
            self.assertEqual(state['status'],'invalidated')
            self.assertEqual(state['events'][-1]['kind'],'owned_cleanup_failed')
            self.assertTrue(state['events'][-1]['requires_new_window'])
            self.assertTrue(owned.exists())
            with self.assertRaises(RuntimeError):attended.segments.validate(state)

    def test_success_finalizes_only_after_home_removal(self):
        with tempfile.TemporaryDirectory(prefix='v2-attended-cleanup-test-') as directory:
            owned=Path(directory)/'owned';owned.mkdir()
            journal=MagicMock()
            journal.finish.side_effect=lambda passed:self.assertFalse(owned.exists())
            attended.finish_home(owned,True,journal)
            journal.finish.assert_called_once_with(True)

    def test_valid_bounded_parameters(self):
        attended.bounds(2,0,1000,1024**3)

if __name__=='__main__':unittest.main()
