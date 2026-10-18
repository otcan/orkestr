"""Synthetic cleanup failure checked by the shared release validator; no monitor.

Integration checkout uses its v2/acceptance module. A source-only worker may set
ORKESTR_V2_RELEASE_VALIDATOR_DIR to an independently owned validator checkout.
"""
from datetime import datetime,timedelta,timezone
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(HERE))
import attended


class ReleaseCleanupTests(unittest.TestCase):
    def test_removal_failure_rejected_by_actual_release_validator(self):
        directory=Path(os.environ.get('ORKESTR_V2_RELEASE_VALIDATOR_DIR',
                                      str(HERE.parents[1]/'acceptance')))
        if not (directory/'release_readiness.py').is_file():
            self.skipTest('shared release validator unavailable; integration check unexecuted')
        sys.path.insert(0,str(directory))
        release=importlib.import_module('release_readiness')
        identity=dict(zip(attended.segments.KEYS,('a'*40,'b'*64,'c'*64)))
        start=datetime(2030,1,1,tzinfo=timezone.utc)
        iso=lambda hour:(start+timedelta(hours=hour)).isoformat().replace('+00:00','Z')
        # Entire interval is synthetic. This is validator behavior, not observed time.
        gate={**identity,'environment':'daily_use_production','status':'observing',
              'started_at':iso(0),'completed_at':iso(72),'incidents':0,'material_fixes':0,
              'events':[], 'segments':[{**identity,'started_at':iso(i),'completed_at':iso(i+1),
                                        'status':'passed'} for i in range(72)]}
        validator=object.__new__(release.Validator)
        validator.revision=identity['revision'];validator.packet={'candidate':{'built_at':iso(0)}}
        validator.soak(gate)  # Prove cleanup is the only new refusal condition.
        with tempfile.TemporaryDirectory(prefix='v2-release-cleanup-test-') as temporary:
            parent=Path(temporary);owned=parent/'owned';owned.mkdir()
            journal=attended.segments.Journal(parent/'journal',identity)
            journal.state=gate;journal.persist()
            with patch.object(attended.shutil,'rmtree',side_effect=OSError('synthetic cleanup failure')):
                with self.assertRaises(OSError):attended.finish_home(owned,True,journal)
            persisted=json.loads((parent/'journal/window.json').read_text())
            self.assertEqual(persisted['status'],'invalidated')
            self.assertEqual(persisted['events'][-1]['kind'],'owned_cleanup_failed')
            self.assertTrue(owned.exists())
            with self.assertRaisesRegex(release.EvidenceError,'incidents'):
                validator.soak(persisted)


if __name__=='__main__':unittest.main()
