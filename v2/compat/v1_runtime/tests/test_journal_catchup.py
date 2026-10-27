"""Journal catch-up after a burst (moteks, 2026-10-27).

Core accepted the last two Deep answers of a 10-message burst at 16:36Z, but
WhatsApp got them 20 and 29 minutes later: every pass read one short page of
the journal, each input from its own cursor, so later inputs re-read the
hundreds of events earlier ones had read. All IDs and peers are synthetic.
"""
import contextlib
import io
import time
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime import journal as journal_module
from v2.compat.v1_runtime import recovery
from v2.compat.v1_runtime.journal import Journal
from v2.compat.v1_runtime.tests import intake_fixture as fixture
from v2.compat.v1_runtime.tests import test_p0_recovery as p0_recovery
from v2.compat.v1_runtime.tests.test_p0_recovery import ParallelFastPeer


def quiet():
    return contextlib.redirect_stderr(io.StringIO())


class Counting:
    """Wraps a peer's journal read: how many envelopes left Core."""

    def __init__(self, peer, limit=None):
        self.read, self.limit, self.returned, self.calls = peer.read_events, limit, 0, 0
        peer.read_events = self

    def __call__(self, after, maximum, timeout_s=None):
        events = self.read(after, maximum if self.limit is None else min(maximum, self.limit), timeout_s)
        self.calls += 1
        self.returned += len(events)
        return events


def noise(peer, count):
    """Unrelated journal traffic (other runs' progress, other messages)."""
    for _ in range(count):
        sequence = max(event["sequence"] for event in peer.events) + 1
        peer.events.append(dict(sequence=sequence, owner_id=peer.owner, aggregate_id=peer.conversation))


def finals(test, burst):
    parents = {row["remote_id"] for row in burst}
    return [m for m in test.ledger.messages(1000)
            if m.get("role") == "assistant" and m.get("phase") == "final_answer" and not m.get("firstResponse")
            and m.get("parentMessageId") in parents]


class BurstCatchUpTests(fixture.IntakeBase):
    def setUp(self):
        super().setUp()
        self.peer = ParallelFastPeer()
        self.worker = self.new_worker()
        self.ledger.max_outstanding = 16

    ack_fast = p0_recovery.MoteksBurstTests.ack_fast

    def notices(self):
        return [m for m in self.ledger.messages(1000) if m.get("kind") == "notice"]

    def test_ten_late_deep_finals_are_each_delivered_within_a_few_passes(self):
        burst = [self.enqueue("m%d" % index) for index in range(10)]
        with quiet():
            self.worker.run_once(fixture.Stop())
        self.assertEqual(len(self.fast()), 10)
        self.ack_fast()
        reads = Counting(self.peer)
        passes = []
        for index in range(10):
            # Core streams 300 unrelated events before Deep i finishes; its
            # own run started only after Deep i-1 was accepted, far after
            # input i's own cursor.
            noise(self.peer, 300)
            self.peer.runs[index, "deep"]["phase"] = "awaiting_acceptance"
            for count in range(1, 6):
                with quiet():
                    self.worker.run_once(fixture.Stop())
                if len(finals(self, burst)) == index + 1:
                    break
            passes.append(count)
        self.assertEqual([m["parentMessageId"] for m in finals(self, burst)], [r["remote_id"] for r in burst])
        self.assertLessEqual(max(passes), 2, "each final within two passes of Core's proposal: %s" % passes)
        self.assertEqual(self.notices(), [])
        self.assertEqual(self.ledger.health()["refusedInputs"], 0)
        # Read once: the later inputs reuse what earlier ones read (before:
        # each input re-read every event after its own intake).
        self.assertLess(reads.returned, len(self.peer.events) * 1.1)

    def test_no_false_setup_failure_while_the_journal_is_500_events_behind(self):
        """A window that already ended, an input whose runs lie 600 events
        past its cursor and a stream that yields one event per read: the
        adapter keeps reading and never starts the close countdown."""
        peer = self.peer
        start = peer.start

        def late_start(role):
            if not peer.runs:
                # Core's journal moved on before the input's first run event
                # (neither its Fast nor its Deep is matched early).
                noise(peer, 600)
            start(role)
        peer.start = late_start
        type(peer).head = property(lambda p: max(e["sequence"] for e in p.events))
        self.addCleanup(delattr, type(peer), "head")
        Counting(peer, limit=1)
        data = self.enqueue("late")
        clock = [time.time()]
        with patch("time.time", lambda: clock[0]), quiet() as log:
            for _ in range(60):
                self.worker.run_once(fixture.Stop())
                clock[0] += 60  # A minute per pass: far beyond RETIRE_WAIT_S.
                row = self.row("late")
                self.assertNotIn("retry_wait_since", row)
                self.assertNotIn("refused", row)
                if row["matched_runs"] and (0, "deep") in peer.runs:
                    peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
                if finals(self, [data]):
                    break
        self.assertEqual(len(finals(self, [data])), 1)
        self.assertEqual(self.notices(), [])
        self.assertGreater(len(peer.events), 600)

    def test_a_caught_up_input_without_runs_still_settles(self):
        """Only once caught up to Core's head with no matching run does the
        unstarted input go through the usual retirement or notice."""
        type(self.peer).head = property(lambda p: max(e["sequence"] for e in p.events))
        self.addCleanup(delattr, type(self.peer), "head")
        self.peer.start = lambda role: None  # Core never runs it.
        data = self.enqueue("orphan")
        clock = [time.time()]
        with patch("time.time", lambda: clock[0]), quiet():
            for _ in range(20):
                self.worker.run_once(fixture.Stop())
                clock[0] += 61
                if "refused" in self.row("orphan") or self.row("orphan").get("phase") == "completed":
                    break
        row = self.row("orphan")
        self.assertEqual(row["refused"]["reason"], "window_setup_failed")
        self.assertEqual(len(self.notices()), 1)


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.peer = fixture.IntakePeer()
        self.peer.events = [dict(sequence=s, owner_id=self.peer.owner, aggregate_id=self.peer.conversation)
                            for s in range(1, 401) if s % 7]  # Sequences with gaps.
        self.reads = Counting(self.peer)
        self.journal = Journal()

    def test_events_read_once_serve_every_reader(self):
        first, caught = self.journal.page(self.peer, 0, 20, 5)
        self.assertTrue(caught)
        self.assertEqual([e["sequence"] for e in first], [e["sequence"] for e in self.peer.events])
        served = self.reads.returned
        second, caught = self.journal.page(self.peer, 150, 20, 5)
        self.assertTrue(caught)
        self.assertEqual([e["sequence"] for e in second], [s for s in range(151, 401) if s % 7])
        self.assertEqual(self.reads.returned, served, "a later reader reads from memory only")

    def test_a_read_at_the_end_of_memory_reads_on_from_core(self):
        self.journal.page(self.peer, 0, 20, 5)
        noise(self.peer, 3)
        events = self.journal.read(self.peer, 395, 100)
        self.assertEqual([e["sequence"] for e in events], [396, 397, 398, 400, 401, 402, 403])

    def test_a_reader_below_the_span_is_joined_and_the_span_is_bounded(self):
        self.journal.page(self.peer, 200, 20, 5)
        events, caught = self.journal.page(self.peer, 0, 20, 5)
        self.assertTrue(caught)
        self.assertLess(self.journal.base, 200)
        self.assertEqual([e["sequence"] for e in events], [e["sequence"] for e in self.peer.events])
        small = Journal(max_events=50)
        small.page(self.peer, 0, 20, 5)
        self.assertEqual(len(small.events), 50)
        self.assertLess(small.base, small.sequences[0])
        before = self.reads.returned
        self.assertEqual([e["sequence"] for e in small.read(self.peer, 0, 5)], [1, 2, 3, 4, 5])
        self.assertEqual(self.reads.returned, before + 5, "trimmed history comes from Core again")

    def test_another_client_never_sees_this_bindings_events(self):
        self.journal.page(self.peer, 0, 20, 5)
        other = fixture.IntakePeer()
        self.assertEqual(self.journal.read(other, 0, 100), [])

    def test_shared_belongs_to_the_worker_and_its_fast_copy(self):
        import copy
        worker = type("W", (), {})()
        journal = journal_module.shared(worker)
        self.assertIs(journal_module.shared(copy.copy(worker)), journal)


class HeadCheckTests(fixture.IntakeBase):
    def test_head_check_reads_on_and_never_moves_the_input_cursor(self):
        data = self.enqueue("x")
        message, event = fixture.identity(5), fixture.identity(6)
        data.update(intake=dict(message_id=message, event_id=event, sequence=1), cursor=1)
        self.peer.events = [dict(sequence=s, owner_id=self.peer.owner, aggregate_id=self.peer.conversation)
                            for s in range(1, 700)]
        type(self.peer).head = property(lambda p: max(e["sequence"] for e in p.events))
        self.addCleanup(delattr, type(self.peer), "head")
        self.assertIs(recovery.journal_caught_up(self.worker, data), True)
        self.assertEqual(data["cursor"], 1)
        self.peer.events.append(dict(sequence=700, owner_id=self.peer.owner, aggregate_id=self.peer.conversation,
                                     source_message_id=message, source_event_id=event, schema_version=5,
                                     payload_ref_or_safe_payload=dict(kind="provider_observed",
                                                                      run_id=fixture.identity(9))))
        self.assertIs(recovery.journal_caught_up(self.worker, data), False, "its own run is unread")
        self.peer.events = self.peer.events[:1]
        type(self.peer).head = property(lambda p: 900)
        fresh = self.new_worker()
        self.assertEqual(recovery.journal_caught_up(fresh, data), "unreadable")


if __name__ == "__main__":
    unittest.main()
