"""Large owned trees remain observable; no provider process or account is used."""
from pathlib import Path
import io
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from codex_service.contract import Refused
from codex_service.ownership import Adopted, Children


class Original:
    def __init__(self, identity, **unused):
        self.identity = identity

    def gone(self):
        return False

    def close(self):
        pass


class OwnershipScaleTests(unittest.TestCase):
    def tracker(self, host=False):
        beta = {'host_full_access': {'providers': True}} if host else {}
        return Children(SimpleNamespace(uid=1000, beta=beta), {'pid': 1, 'start': 1})

    def test_more_than_both_old_limits_keep_every_live_original(self):
        for host in (False, True):
            with self.subTest(host=host), patch('codex_service.ownership.Process', Original):
                tracker = self.tracker(host)
                self.addCleanup(tracker.close)
                for pid in range(10, 1035):
                    tracker.remember({'pid': pid, 'start': pid, 'uid': 1000})
                self.assertEqual(len(tracker.records), 1025)
                self.assertFalse(tracker.uncertain)

    def test_large_live_family_is_walked_completely(self):
        tracker = self.tracker()
        self.addCleanup(tracker.close)
        parent = {'pid': 10, 'start': 10, 'uid': 1000, 'ppid': 1}
        children = {pid: {'pid': pid, 'start': pid, 'uid': 1000, 'ppid': 10}
                    for pid in range(20, 1045)}
        root = (parent['pid'], parent['start'])
        tracker.records[root] = Original(parent)
        tracker.brokers.add(root)
        with patch('codex_service.ownership.Process', Original), \
                patch('codex_service.ownership.same', return_value=True), \
                patch('codex_service.ownership.process', side_effect=children.get), \
                patch.object(tracker, '_children', side_effect=lambda p: set(children) if p['pid'] == 10 else set()):
            tracker.observe()
        self.assertEqual(len(tracker.records), 1026)
        self.assertTrue(all(tracker.families[(pid, pid)] == {root} for pid in children))
        self.assertFalse(tracker.uncertain)

    def test_large_adopted_family_keeps_originals_and_uid_checks(self):
        adopted = Adopted.__new__(Adopted)
        adopted.records = {}
        adopted.allowed_uids = {1000, 1001}
        adopted.allow_uid_change = False
        self.addCleanup(lambda: [record.close() for record in adopted.records.values()])
        with patch('codex_service.ownership.Process', Original), \
                patch('codex_service.ownership.sys.stderr', io.StringIO()):
            for pid in range(10, 1035):
                self.assertTrue(adopted._remember({'pid': pid, 'start': pid, 'uid': 1000, 'ppid': 1}))
            self.assertEqual(len(adopted.records), 1025)
            with self.assertRaisesRegex(Refused, 'adopted_executor_identity'):
                adopted._remember({'pid': 2000, 'start': 2000, 'uid': 0, 'ppid': 1})

    def test_all_tasks_of_a_large_thread_group_are_examined(self):
        tracker = self.tracker()
        with tempfile.TemporaryDirectory(prefix='owned-task-metadata-') as directory:
            task_root = Path(directory)
            for tid in range(1025):
                task = task_root / str(tid)
                task.mkdir()
                (task / 'children').write_text(str(tid + 10000))
            with patch('codex_service.ownership.Path', return_value=task_root), \
                    patch('codex_service.ownership.exists', return_value=True):
                for read in (tracker._children, Adopted.children):
                    self.assertEqual(read({'pid': 1}), set(range(10000, 11025)))

    def test_long_kernel_child_list_is_not_truncated(self):
        tracker = self.tracker()
        with tempfile.TemporaryDirectory(prefix='owned-child-metadata-') as directory:
            task_root = Path(directory)
            task = task_root / '1'
            task.mkdir()
            (task / 'children').write_text(' '.join(str(pid) for pid in range(10000, 15000)))
            with patch('codex_service.ownership.Path', return_value=task_root), \
                    patch('codex_service.ownership.exists', return_value=True):
                for read in (tracker._children, Adopted.children):
                    self.assertEqual(read({'pid': 1}), set(range(10000, 15000)))
            (task / 'children').write_text('10000 invalid-pid')
            with patch('codex_service.ownership.Path', return_value=task_root), \
                    patch('codex_service.ownership.exists', return_value=True):
                for read in (tracker._children, Adopted.children):
                    with self.assertRaisesRegex(Refused, 'child_metadata'):
                        read({'pid': 1})


if __name__ == '__main__':
    unittest.main()
