"""Give-up uses a committed Deep final, never proposal time or native guesses."""
import contextlib
import copy
import io
from unittest.mock import patch

from v2.compat.v1_runtime.tests import intake_fixture as fixture
from v2.compat.v1_runtime.tests import test_fast_watch as scenario


class FastWatchGiveupTests(fixture.IntakeBase):
    watches = scenario.FastWatchTests.watches
    finals = scenario.FastWatchTests.finals
    once = scenario.FastWatchTests.once
    fault = scenario.FastWatchTests.fault

    def completed(self, kind="status", silent=True):
        self.enqueue()
        self.restore = self.fault(kind, deep_text="NO_REPLY" if silent else None)
        self.once(100)
        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
        self.once(101)
        if kind.startswith("accept"):
            self.once(116)
        return copy.deepcopy(self.row("first")["deep_final_completion"])

    def poll(self, at, restart=True):
        if restart:
            self.worker = self.new_worker()
        output = io.StringIO()
        with patch("time.time", return_value=at), contextlib.redirect_stderr(output):
            busy = self.worker.run_once(fixture.Stop())
        return busy, output.getvalue()

    def test_boundary_restart_and_backward_clock_keep_original_completion_time(self):
        proof = self.completed()
        self.assertEqual(proof["at_ms"], 101000)
        for at in (100, 101, 700.999):
            busy, output = self.poll(at)
            self.assertTrue(busy)
            self.assertNotIn("fast_watch_gave_up", output)
            self.assertFalse(self.watches()[0].get("closed", False))
            self.assertEqual(self.row("first")["deep_final_completion"], proof)
        busy, output = self.poll(701)
        self.assertFalse(busy)
        self.assertEqual(output.count("fast_watch_gave_up"), 1)
        self.assertTrue(self.watches()[0]["closed"])
        self.assertEqual(self.watches()[0]["diagnostic"]["deep_final_completion"], proof)
        for at in (702, 9999):
            self.assertNotIn("fast_watch_gave_up", self.poll(at)[1])
        self.assertEqual(self.peer.runs[0, "fast"]["phase"], "awaiting_acceptance")
        self.assertNotIn("fast", self.row("first").get("accepted", {}))

    def test_clock_starts_only_when_the_accepted_final_export_transaction_commits(self):
        self.enqueue()
        self.fault("status")
        self.once(100)
        with self.ledger.connect() as db:
            db.execute("CREATE TRIGGER reject_deep_final BEFORE INSERT ON exports "
                       "WHEN json_extract(NEW.message,'$.source')='rust-v2-pilot' "
                       "BEGIN SELECT RAISE(ABORT,'synthetic export failure'); END")
        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
        self.once(101)
        self.assertEqual(self.row("first")["accepted"]["deep"]["outcome"], "succeeded")
        self.assertEqual(self.row("first")["phase"], "running")
        self.assertNotIn("deep_final_completion", self.row("first"))
        with self.ledger.connect() as db:
            db.execute("DROP TRIGGER reject_deep_final")
        self.once(110, restart=True)
        self.assertEqual(self.row("first")["deep_final_completion"]["at_ms"], 110000)
        self.assertNotIn("fast_watch_gave_up", self.poll(709.999)[1])
        self.assertEqual(self.poll(710)[1].count("fast_watch_gave_up"), 1)

    def test_silent_final_ack_keeps_proof_and_does_not_suppress_a_recovered_fast(self):
        proof = self.completed()
        final = self.finals()[0]
        self.assertTrue(final["noReply"])
        self.ledger.acknowledge(final["id"], dict(outcome="no_reply", parentPublicMessageId="first", connectorMessageIds=[]))
        self.assertNotIn("text", self.row("first"))
        self.assertEqual(self.row("first")["deep_final_completion"], proof)
        self.poll(700.999)
        self.peer.request = self.restore
        # Age alone never gives up or suppresses a now-valid observation.
        _, output = self.poll(702)
        self.assertNotIn("fast_watch_gave_up", output)
        self.assertEqual(len(self.fast()), 1)
        self.assertEqual(self.watches()[0]["accepted"]["fast"]["outcome"], "succeeded")

    def test_unknown_acceptance_and_export_history_survive_giveup_and_late_ack(self):
        self.enqueue()
        self.fault("accept_unknown", deep_text="NO_REPLY")
        self.once(100)
        fast = self.fast()[0]
        pseudo = next(message for message in self.ledger.messages() if message["id"] == fast["parentMessageId"])
        self.ledger.acknowledge(fast["id"], dict(outcome="uncertain", outboxJobId="unknown-fast-job",
            parentPublicMessageId=pseudo["publicMessageId"], connectorMessageIds=[]))
        frozen = copy.deepcopy(self.watches()[0]["fast_accept_request"])
        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
        self.once(101)
        self.assertNotIn("deep_final_completion", self.row("first"), "a pending delivery fence is not completion")
        self.once(116)
        proof = self.row("first")["deep_final_completion"]
        self.assertEqual(proof["at_ms"], 116000)
        with self.ledger.connect() as db:
            exports = db.execute("SELECT export_id,outcome,ack,message FROM exports ORDER BY seq").fetchall()
        self.poll(715.999)
        self.assertEqual(self.watches()[0]["fast_accept_request"], frozen)
        _, output = self.poll(716)
        self.assertEqual(output.count("fast_watch_gave_up"), 1)
        self.assertEqual(self.watches()[0]["fast_accept_request"], frozen)
        with self.ledger.connect() as db:
            self.assertEqual(db.execute("SELECT export_id,outcome,ack,message FROM exports ORDER BY seq").fetchall(), exports)
        self.ledger.acknowledge(fast["id"], dict(outcome="delivered", outboxJobId="late-fast-job",
            parentPublicMessageId=pseudo["publicMessageId"], connectorMessageIds=["late-fast-receipt"],
            deliveredAt="2026-01-01T00:00:00Z"))
        with self.ledger.connect() as db:
            outcome, ack = db.execute("SELECT outcome,ack FROM exports WHERE export_id=?", (fast["id"],)).fetchone()
        self.assertEqual(outcome, "superseded")
        self.assertIn("late-fast-receipt", ack)
        self.assertNotIn("fast_watch_gave_up", self.poll(717)[1])
        self.assertEqual(len(self.mutations("/messages")), 1)
        self.assertEqual(self.peer.runs[0, "fast"]["phase"], "awaiting_acceptance")

    def test_running_refused_unaccepted_and_unstamped_deep_never_start_giveup_clock(self):
        for state in ("running", "refused", "unaccepted", "unstamped"):
            with self.subTest(state=state):
                self.setUp()
                if state == "unstamped":
                    self.completed()
                    original = self.row("first")
                    original.pop("deep_final_completion")
                    self.ledger.save(original)
                else:
                    self.enqueue()
                    self.fault("status")
                    self.once(100)
                    if state == "refused":
                        self.ledger.refuse(self.row("first"), "synthetic-refusal")
                    elif state == "unaccepted":
                        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
                        from v2.compat.v1_runtime.rust_client import ClientError
                        self.peer.before_accept = lambda body: (_ for _ in ()).throw(ClientError("transport_outcome_unknown"))
                _, output = self.poll(10000)
                self.assertNotIn("fast_watch_gave_up", output)
                self.assertFalse(self.watches()[0].get("closed", False))
                self.assertNotIn("deep_final_completion", self.row("first"))
