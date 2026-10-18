"""Synthetic wall-clock records; no running service, clock change or soak window."""
import copy
from datetime import datetime,timedelta,timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import segments

IDENTITY=dict(zip(segments.KEYS,('a'*40,'b'*64,'c'*64)))
START=datetime(2030,1,1,tzinfo=timezone.utc)
def iso(seconds):return (START+timedelta(seconds=seconds)).isoformat().replace('+00:00','Z')

class SegmentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.directory=Path(self.temp.name)/'journal'

    def valid(self):
        return {**IDENTITY,'status':'passed','incidents':0,'material_fixes':0,
                'started_at':iso(0),'completed_at':iso(2),
                'segments':[{**IDENTITY,'status':'passed','started_at':iso(i),'completed_at':iso(i+1)} for i in range(2)]}

    def test_validator_accepts_contiguous_real_timestamps(self):
        segments.validate(self.valid())

    def test_gaps_overlap_identity_incident_and_oversize_rejected(self):
        for change in (lambda v:v['segments'][1].update(started_at=iso(1.1)),
                       lambda v:v['segments'][1].update(started_at=iso(.9)),
                       lambda v:v['segments'][1].update(configuration_sha256='d'*64),
                       lambda v:v.update(incidents=1),lambda v:v.update(material_fixes=1),
                       lambda v:v['segments'][0].update(completed_at=iso(3601))):
            value=self.valid();change(value)
            with self.assertRaises(RuntimeError):segments.validate(value)

    def test_restart_persists_reset_and_cannot_resume(self):
        journal=segments.Journal(self.directory,IDENTITY)
        journal.restart()
        state=json.loads((self.directory/'window.json').read_text())
        self.assertEqual(state['status'],'invalidated')
        self.assertEqual(state['events'][0]['kind'],'graceful_restart')
        self.assertTrue(state['events'][0]['requires_new_window'])
        with self.assertRaises(FileExistsError):segments.Journal(self.directory,IDENTITY)
        with self.assertRaises(RuntimeError):journal.observe({},IDENTITY)

    def test_identity_change_is_material_incident_before_sample(self):
        journal=segments.Journal(self.directory,IDENTITY)
        with self.assertRaisesRegex(RuntimeError,'identity changed'):
            journal.observe({},dict(IDENTITY,revision='e'*40))
        self.assertEqual(journal.state['material_fixes'],1)
        self.assertFalse((self.directory/'samples.jsonl').exists())

    def test_actual_sample_times_define_no_gap_segments(self):
        with patch.object(segments,'utc',side_effect=[iso(0),iso(1),iso(2),iso(2.5)]), \
             patch.object(segments.time,'monotonic',side_effect=[0,1,2,2.5]):
            journal=segments.Journal(self.directory,IDENTITY,1,10)
            journal.observe({'health':True},IDENTITY)
            journal.observe({'health':True},IDENTITY)
            value=journal.finish(True)
        segments.validate(value)
        self.assertEqual(value['completed_at'],iso(2))
        self.assertEqual(len((self.directory/'samples.jsonl').read_text().splitlines()),2)

    def test_observation_gap_and_clock_jump_invalidate(self):
        for wall,mono in ((11,11),(20,1)):
            directory=self.directory/str(mono);directory.parent.mkdir(exist_ok=True)
            with patch.object(segments,'utc',side_effect=[iso(0),iso(wall),iso(wall)]), \
                 patch.object(segments.time,'monotonic',side_effect=[0,mono]):
                journal=segments.Journal(directory,IDENTITY,1,10)
                with self.assertRaisesRegex(RuntimeError,'discontinuity'):journal.observe({},IDENTITY)
            self.assertEqual(journal.state['status'],'invalidated')

    def test_cleanup_failure_invalidates_even_good_samples(self):
        journal=segments.Journal(self.directory,IDENTITY)
        value=journal.finish(False)
        self.assertEqual(value['events'][-1]['kind'],'owned_cleanup_failed')
        with self.assertRaises(RuntimeError):segments.validate(value)

if __name__=='__main__':unittest.main()
