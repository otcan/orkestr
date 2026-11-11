"""Managed request journal index, poll load and retention. Synthetic claims only.

No Root, socket, provider or live manager state: claims are written to a
temporary directory and the Ingress is assembled from its parts.
"""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from codex_bounded.trust import metadata, process
from codex_service.contract import Refused
import codex_service.managed_ingress as ingress_module
from codex_service.managed_ingress import Ingress
from codex_service import managed_journal
from codex_service.managed_journal import Journal
from codex_service.manager import MANAGED_REPLY_SECONDS

# 2026-11-10: 857 claims on disk; this test uses more, sized like the live ones.
CLAIMS = 2000
POLLERS = 8
SUMMARY = 'x' * 3500


def source(window, generation=1):
    return {'owner_id': str(uuid.UUID(int=1)), 'conversation_id': str(uuid.UUID(int=2)),
            'session_id': str(uuid.UUID(int=3)), 'generation': 1, 'incarnation': 'synthetic',
            'provider': 'codex', 'window_id': window, 'window_generation': generation,
            'broker_pid': 10, 'broker_start': 20, 'caller_pid': 30, 'caller_start': 40,
            'caller_uid': 65534, 'run_id': str(uuid.UUID(int=4))}


def claim(request, window, state):
    return {'request_id': request, 'source': source(window), 'payload_sha256': '0' * 64,
            'request': {'version': 1, 'request_key': 'synthetic', 'operation': 'root_request_submit',
                        'arguments': {'action': 'read', 'resource': 'example.invalid', 'summary': SUMMARY}},
            'created_at_ms': 1, 'state': state, 'result': {'kind': 'protected_root_intake'}}


class Fixture:
    def __init__(self, test, closed_claims=0, live_windows=0):
        temp = tempfile.TemporaryDirectory(prefix='synthetic-managed-journal-')
        test.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        for _ in range(closed_claims):
            self.write(str(uuid.uuid4()), str(uuid.uuid4()), 'completed')
        self.journal = Journal.open(self.directory, custody=lambda path: path)
        self.windows, self.peers = [], []
        me = process(os.getpid())
        for _ in range(live_windows):
            # Each live window's caller has one pending claim of this manager life.
            window, request = str(uuid.uuid4()), str(uuid.uuid4())
            self.journal.add(request, window)
            path = self.write(request, window, 'pending')
            self.windows.append(window)
            self.peers.append(SimpleNamespace(source=source(window), request=request, path=path,
                                              proof=SimpleNamespace(identity=me, exited=lambda: False),
                                              deadline=time.monotonic() + 3600))
        ingress = Ingress.__new__(Ingress)
        ingress.manager = SimpleNamespace(_desk_window_active=lambda *_: True,
                                          windows={window: None for window in self.windows})
        ingress.directory, ingress.peers, ingress.journal = self.directory, self.peers, self.journal
        ingress.runs = SimpleNamespace(attach=lambda peer: None)
        self.ingress = ingress

    def write(self, request, window, state, age_s=0):
        path = self.directory / (request + '.json')
        path.write_text(json.dumps(claim(request, window, state)))
        if age_s:
            then = time.time() - age_s
            os.utime(path, (then, then))
        return path


class CountedReads:
    """Counts claim reads by the Ingress (the old pending() read them all)."""
    def __init__(self, test):
        self.reads = 0
        patcher = patch.object(ingress_module, 'metadata', side_effect=self.read)
        patcher.start()
        test.addCleanup(patcher.stop)

    def read(self, path, maximum=32768):
        self.reads += 1
        return metadata(path, maximum)


class PendingLoad(unittest.TestCase):
    def test_pending_reads_only_the_live_callers_claims(self):
        f = Fixture(self, closed_claims=CLAIMS, live_windows=POLLERS)
        counted = CountedReads(self)
        for window in f.windows:
            found = f.ingress.pending(window, 1)
            self.assertEqual([record['source']['window_id'] for record in found], [window])
        # One live caller per window: one claim read per poll, whatever lies on disk.
        self.assertEqual(counted.reads, POLLERS, 'pending read %d claims for %d polls of %d on disk'
                         % (counted.reads, POLLERS, CLAIMS + POLLERS))

    def test_eight_concurrent_pollers_stay_far_under_the_deadline(self):
        f = Fixture(self, closed_claims=CLAIMS, live_windows=POLLERS)
        manager = threading.Lock()  # The manager answers one control request at a time.
        latencies, stop = [], time.monotonic() + 2

        def poller(window):
            while time.monotonic() < stop:
                asked = time.monotonic()
                with manager:
                    found = f.ingress.pending(window, 1)
                latencies.append(time.monotonic() - asked)
                assert len(found) == 1
                time.sleep(0.01)  # The Deep loop's previous pace: the worst case.
        threads = [threading.Thread(target=poller, args=(window,)) for window in f.windows]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        worst = max(latencies)
        # 20x headroom inside the 5 s deadline for a loaded, swapping host.
        self.assertLess(worst, MANAGED_REPLY_SECONDS / 20,
                        '%d polls, worst %.0f ms' % (len(latencies), worst * 1000))
        self.assertGreater(len(latencies), POLLERS * 20)

    def test_a_restarted_manager_marks_unfinished_claims_unknown_and_keeps_them(self):
        f = Fixture(self, live_windows=2)
        restarted = Journal.open(f.directory, custody=lambda path: path)
        for peer in f.peers:
            self.assertEqual(json.loads(peer.path.read_text())['state'], 'unknown')
            self.assertEqual(restarted.count(peer.source['window_id']), 1)
        self.assertFalse(restarted.unsettled)
        f.ingress.journal = restarted
        self.assertEqual(f.ingress.pending(f.windows[0], 1), [])


class Index(unittest.TestCase):
    def test_window_bound_counts_from_the_index_without_reading_claims(self):
        f = Fixture(self, closed_claims=50, live_windows=1)
        window = f.windows[0]
        f.write(str(uuid.uuid4()), window, 'completed')
        f.ingress.journal = f.journal = Journal.open(f.directory, custody=lambda path: path)
        counted = CountedReads(self)
        caller = SimpleNamespace(source=source(window))
        with patch.object(ingress_module, 'MAX_WINDOW_REQUESTS', 3):
            f.ingress._record(caller, {'version': 1, 'request_key': 'third', 'operation': 'worker_status',
                                       'arguments': {}})
            self.assertEqual(f.journal.count(window), 3)
            self.assertIn(caller.request, f.journal.unsettled)
            with self.assertRaisesRegex(Refused, 'managed_window_bound'):
                f.ingress._record(SimpleNamespace(source=source(window)),
                                  {'version': 1, 'request_key': 'fourth', 'operation': 'worker_status',
                                   'arguments': {}})
            other = SimpleNamespace(source=source(str(uuid.uuid4())))
            f.ingress._record(other, {'version': 1, 'request_key': 'third', 'operation': 'worker_status',
                                      'arguments': {}})
        self.assertEqual(counted.reads, 0)
        self.assertIn(caller.path, f.journal.window_paths(window))
        self.assertEqual(f.journal.window_paths(other.source['window_id']), [other.path])

    def test_unsettled_claims_are_an_exact_superset_of_changeable_ones(self):
        f = Fixture(self, closed_claims=20)
        changing = [str(uuid.uuid4()) for _ in range(3)]
        window = str(uuid.uuid4())
        for request, state in zip(changing, ('pending', 'consumed', 'worker_waiting')):
            f.journal.add(request, window)
            f.write(request, window, state)
        f.journal.add(str(uuid.uuid4()), window)  # Indexed, never written: skipped.
        self.assertEqual(sorted(path.stem for path, _ in f.journal.unsettled_records()), sorted(changing))
        done = json.loads(f.journal.path(changing[1]).read_text())
        done['state'] = 'completed'
        f.journal.path(changing[1]).write_text(json.dumps(done))
        self.assertEqual(sorted(path.stem for path, _ in f.journal.unsettled_records()),
                         sorted([changing[0], changing[2]]))
        self.assertEqual(f.journal.unsettled, {changing[0], changing[2]})


class Retention(unittest.TestCase):
    OLD = managed_journal.RETENTION_S + 60

    def test_only_expired_terminal_claims_of_windows_no_longer_held_are_removed(self):
        f = Fixture(self, live_windows=1)
        held, closed = f.windows[0], str(uuid.uuid4())
        names = {}
        for name, window, state, age in (('expired', closed, 'completed', self.OLD),
                                         ('expired_unknown', closed, 'unknown', self.OLD),
                                         ('expired_cancelled', closed, 'cancelled', self.OLD),
                                         ('recent', closed, 'completed', 60),
                                         ('held', held, 'completed', self.OLD),
                                         ('live_caller', closed, 'completed', self.OLD)):
            names[name] = str(uuid.uuid4())
            f.write(names[name], window, state, age)
        journal = Journal.open(f.directory, custody=lambda path: path)
        unsettled = str(uuid.uuid4())
        journal.add(unsettled, closed)
        f.write(unsettled, closed, 'consumed', self.OLD)
        removed = journal.prune({held}, {names['live_caller']}, now=10)
        self.assertEqual(removed, 3)
        present = {path.stem for path in f.directory.glob('*.json')}
        self.assertEqual(present, {names['recent'], names['held'], names['live_caller'], unsettled,
                                   f.peers[0].request})
        self.assertEqual(set(journal.claims), present)
        self.assertEqual(journal.count(closed), 3)
        # A prune is due once per PRUNE_EVERY_S.
        os.utime(journal.path(names['recent']), (0, 0))
        self.assertEqual(journal.prune({held}, set(), now=11), 0)
        self.assertEqual(journal.prune({held}, set(), now=10 + managed_journal.PRUNE_EVERY_S), 2)

    def test_a_backlog_is_removed_in_bounded_batches(self):
        f = Fixture(self)
        for _ in range(managed_journal.PRUNE_BATCH + 44):
            f.write(str(uuid.uuid4()), str(uuid.uuid4()), 'completed', self.OLD)
        journal = Journal.open(f.directory, custody=lambda path: path)
        self.assertEqual(journal.prune(set(), set(), now=100), managed_journal.PRUNE_BATCH)
        self.assertEqual(journal.prune(set(), set(), now=100 + managed_journal.PRUNE_RETRY_S / 2), 0)
        self.assertEqual(journal.prune(set(), set(), now=100 + managed_journal.PRUNE_RETRY_S), 44)
        self.assertFalse(list(f.directory.glob('*.json')))
        self.assertEqual((journal.claims, journal.windows), ({}, {}))
        self.assertEqual(journal.next_prune, 100 + managed_journal.PRUNE_RETRY_S + managed_journal.PRUNE_EVERY_S)


if __name__ == '__main__':
    unittest.main()
