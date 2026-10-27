"""A grouped Deep turn settles every input of its burst with one quoted final."""
import contextlib
import io
import json

from v2.compat.v1_runtime import deep_group
from v2.compat.v1_runtime.tests import intake_fixture as fixture
from v2.compat.v1_runtime.worker import Refused


class DeepGroupTests(fixture.IntakeBase):
    def ack_fast(self, public):
        original = self.row(public)["remote_id"]
        fast = next(message for message in self.fast() if message["sourceInputId"] == original)
        pseudo = next(message for message in self.ledger.messages(500) if message["id"] == fast["parentMessageId"])
        self.ledger.acknowledge(fast["id"], dict(outcome="delivered", outboxJobId="synthetic-fast-job",
            parentPublicMessageId=pseudo["publicMessageId"], connectorMessageIds=["synthetic-fast-receipt"],
            deliveredAt="2026-01-01T00:00:00Z"))

    def ack_final(self, public):
        """V1 reports the input's final (answer or notice) delivered."""
        data = self.row(public)
        with self.ledger.connect() as db:
            export = db.execute("SELECT export_id FROM exports WHERE input_id=? AND kind='final'",
                                (data["remote_id"],)).fetchone()[0]
        self.ledger.acknowledge(export, dict(outcome="delivered", outboxJobId="synthetic-final-job",
            parentPublicMessageId=public, connectorMessageIds=["synthetic-final-receipt"],
            deliveredAt="2026-01-01T00:00:00Z"))

    def finals(self):
        with self.ledger.connect() as db:
            rows = db.execute("SELECT message FROM exports ORDER BY rowid").fetchall()
        return [message for (raw,) in rows if (message := json.loads(raw)).get("source") == "rust-v2-pilot"
                and message.get("phase") == "final_answer" and not message.get("firstResponse")]

    def passes(self, passes=1):
        with contextlib.redirect_stderr(io.StringIO()):
            for _ in range(passes):
                self.worker.run_once(fixture.Stop())

    def burst_behind_busy_deep(self, names=("a", "b", "c")):
        """Head Deep runs; a burst arrives (Fast each); Core then groups it."""
        self.enqueue("head")
        self.passes()
        rows = [self.enqueue(name) for name in names]
        self.passes(2)
        self.assertEqual(len(self.fast()), 1 + len(names), "Fast stays per message")
        self.ack_fast("head")
        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
        self.passes()
        self.assertEqual(self.row("head")["phase"], "completed")
        # Core's next Deep turn consumed the whole burst (deep_groups.rs).
        group = self.peer.runs[1, "deep"]
        group["grouped_inputs"] = [dict(message_id=intake["message_id"], event_id=intake["event_id"],
                                        request_key=intake["key"]) for intake in self.peer.inputs[1:]]
        for index in range(2, 1 + len(names)):
            self.peer.runs[index, "deep"] = group
        return rows, group

    def test_one_final_answers_the_burst_and_quotes_its_last_message(self):
        (a, b, c), group = self.burst_behind_busy_deep()
        self.passes()
        for name in ("b", "c"):
            row = self.row(name)
            self.assertEqual((row["phase"], row["absorbed_into"]), ("completed", a["remote_id"]))
            self.assertEqual(row["deep_group_of"]["run_id"], group["run_id"])
        self.assertEqual(self.row("a")["deep_group"]["inputs"], [b["remote_id"], c["remote_id"]])
        self.assertEqual(self.row("a")["phase"], "running")
        self.ack_fast("a")
        group["phase"] = "awaiting_acceptance"
        self.passes()
        finals = self.finals()
        self.assertEqual(len(finals), 2, "head turn + one grouped final, never one per message")
        final = finals[-1]
        self.assertEqual(final["parentMessageId"], a["remote_id"])
        self.assertIs(final["quoteSource"], True)
        self.assertEqual(final["sourceInputId"], c["remote_id"], "quotes the LAST message of the group")
        self.assertNotIn("quoteSource", finals[0], "a single-input final stays unquoted")
        self.ack_final("a")
        for name in ("a", "b", "c"):
            self.assertIn("settled", self.row(name))
        self.assertEqual([body["run_id"] for body in self.mutations("/accept")].count(group["run_id"]), 1)
        with self.ledger.connect() as db:
            sources = [json.loads(raw).get("sourceInputId") for (raw,) in
                       db.execute("SELECT message FROM exports WHERE json_extract(message,'$.firstResponse')")]
        self.assertEqual(sources[1:], [a["remote_id"], b["remote_id"], c["remote_id"]],
                         "each message kept its own Fast reply")
        self.passes(2)
        self.assertEqual(len(self.finals()), 2, "nothing is exported twice")

    def test_a_failed_grouped_turn_settles_every_input_with_one_outcome(self):
        (a, b, c), group = self.burst_behind_busy_deep()
        self.passes()
        group["phase"] = "failed"
        self.passes(2)
        self.assertEqual(self.row("a")["refused"]["reason"], "deep_run_failed")
        self.ack_final("a")  # The one notice.
        for name in ("a", "b", "c"):
            self.assertEqual(self.row(name)["phase"], "completed")
            self.assertIn("settled", self.row(name))
        self.assertEqual(len(self.finals()), 1, "no Deep final for a failed turn")
        self.assertEqual(len(self.mutations("/messages")), 4, "a grouped input is never admitted again")

    def test_a_single_input_run_folds_nothing(self):
        self.enqueue("head")
        self.passes()
        self.enqueue("a")
        self.passes(2)
        self.ack_fast("head")
        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
        self.passes()
        self.passes()
        self.assertNotIn("deep_group", self.row("a"))
        self.ack_fast("a")
        self.peer.runs[1, "deep"]["phase"] = "awaiting_acceptance"
        self.passes()
        self.assertEqual(len(self.finals()), 2)
        self.assertTrue(all("quoteSource" not in final for final in self.finals()))

    def test_a_group_of_another_head_is_refused(self):
        data = dict(remote_id="r", intake=dict(message_id="m-head", event_id="e-head"))
        group = [dict(message_id="m-other", event_id="e-other", request_key="k1"),
                 dict(message_id="m-2", event_id="e-2", request_key="k2")]
        with self.assertRaises(Refused):
            deep_group.members(data, dict(run_id="run", grouped_inputs=group), {"run"})
        with self.assertRaises(Refused):
            deep_group.members(data, dict(run_id="run", grouped_inputs=[group[0]]), {"run"})
        self.assertEqual(deep_group.members(data, dict(run_id="run"), {"run"}), [])
        self.assertEqual(deep_group.members(data, dict(run_id="other", grouped_inputs=group), {"run"}), [])

    def test_a_deadline_continuation_carries_every_grouped_message_numbered(self):
        head, b, c = self.enqueue("head"), self.enqueue("b"), self.enqueue("c")
        self.assertEqual(deep_group.carry(self.ledger, head, "Request head"), "Request head")
        head["deep_group"] = dict(run_id="run", inputs=[b["remote_id"], c["remote_id"]], pending=[],
                                  last=c["remote_id"])
        text = deep_group.carry(self.ledger, head, "Request head")
        self.assertTrue(text.startswith("[3 owner messages were answered together"), text)
        self.assertLess(text.index("\n\n1. Request head"), text.index("\n\n2. Request b"))
        self.assertLess(text.index("\n\n2. Request b"), text.index("\n\n3. Request c"))
        reply = {}
        deep_group.quote(head, reply)
        self.assertEqual(reply, dict(quoteSource=True, sourceInputId=c["remote_id"]))
