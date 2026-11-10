"""A typed refusal notice cannot consume an accepted answer's export identity."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.tests import intake_fixture as fixture


def ack(ledger, export_id, public="first", outcome="delivered"):
    return ledger.acknowledge(export_id, dict(outcome=outcome, outboxJobId="synthetic-job",
        parentPublicMessageId=public, connectorMessageIds=["synthetic-receipt"],
        deliveredAt="2026-01-01T00:00:00Z"))


def exports(ledger):
    with ledger.connect() as db:
        return db.execute("SELECT export_id,input_id,kind,source_key,message,outcome,ack "
                          "FROM exports ORDER BY seq").fetchall()


def resume_fixture(ledger, data):
    # Only this synthetic fixture models an already reviewed operator resume.
    # The product fix does not reopen inputs or request any Core mutation.
    data["operator_reconciliation"] = {"previous": {
        key: copy.deepcopy(data.get(key)) for key in ("phase", "refused", "settled")}}
    for key in ("refused", "settled"):
        data.pop(key, None)
    data["phase"] = "admitted"
    ledger.save(data)
    return data


class AcceptedFinalWorkerTests(fixture.IntakeBase):
    def new_worker(self):
        worker = super().new_worker()
        worker.legacy_companions = False
        return worker

    def test_delivered_notice_then_same_frozen_operation_exports_accepted_answer(self):
        original = self.enqueue()
        request = self.peer.request
        def lost_window(method, route, **kwargs):
            if method == "POST" and route == "/window":
                raise ClientError("peer_changed_outcome_unknown", outcome="unknown")
            return request(method, route, **kwargs)
        self.peer.request = lost_window
        with contextlib.redirect_stderr(io.StringIO()):
            self.worker.run_once(fixture.Stop())
        failed = self.row("first")
        frozen = {key: copy.deepcopy(failed[key]) for key in ("keys", "intake", "window_request")}
        notice = exports(self.ledger)[0]
        ack(self.ledger, notice[0])
        old_notice = exports(self.ledger)[0]
        resume_fixture(self.ledger, self.row("first"))
        self.peer.request = request
        self.worker = self.new_worker()
        self.worker.run_once(fixture.Stop())
        self.peer.runs[0, "deep"]["phase"] = "awaiting_acceptance"
        self.worker.run_once(fixture.Stop())
        rows = exports(self.ledger)
        self.assertEqual(len(rows), 2, "the accepted answer must actually enter the export stream")
        self.assertEqual(rows[0], old_notice, "the delivered notice and its ACK are immutable")
        reply = json.loads(rows[1][4])
        self.assertEqual(reply["id"], self.row("first")["accepted"]["deep"]["acceptance_event_id"])
        self.assertEqual(reply["parentMessageId"], original["remote_id"])
        self.assertEqual(reply["source"], "rust-v2-pilot")
        self.assertTrue(rows[1][3].startswith("accepted-final:"))
        self.assertEqual(len(self.mutations("/messages")), 1)
        self.assertEqual(self.mutations("/window"), [frozen["window_request"]])
        self.assertEqual(self.row("first")["intake"], frozen["intake"])
        self.assertEqual(self.row("first")["keys"], frozen["keys"])
        listed = self.ledger.listing()["messages"]
        self.assertEqual(listed[0]["id"], original["remote_id"])
        self.assertEqual(listed[0]["text"], "")
        self.assertTrue(listed[0]["pruned"])
        self.assertEqual(listed[1]["id"], reply["id"])
        self.assertEqual(listed[1]["text"], reply["text"])
        ack(self.ledger, reply["id"])
        self.assertEqual(exports(self.ledger)[0], old_notice)


class AcceptedFinalLedgerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.ledger = Ledger(Path(temp.name) / "ledger.sqlite3", {"test_scope": "accepted-final"})
        self.data = self.ledger.enqueue(dict(publicMessageId="first", publicThreadId="thread",
            chatId="chat", accountId="account", text="Synthetic request"),
            author=dict(role="owner", id="owner", label="owner"))[0]
        self.data["execution_mode"] = "single"
        self.ledger.save(self.data)

    def notice(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.ledger.refuse(self.data, "upstream_refused:peer_changed_outcome_unknown")
        ack(self.ledger, exports(self.ledger)[0][0])
        self.data = resume_fixture(self.ledger, self.ledger.input(self.data["remote_id"]))

    def accepted(self):
        identity = lambda name: str(uuid.uuid5(uuid.NAMESPACE_URL, "synthetic:" + name))
        deep = dict(outcome="succeeded", run_id=identity("run"),
                    completion_event_id=identity("completion"), acceptance_event_id=identity("acceptance"))
        self.data.update(phase="running", intake=dict(message_id=identity("message"), event_id=identity("event")),
                         accepted={"deep": deep}, matched_runs=[deep["run_id"]])
        self.ledger.save(self.data)
        return dict(id=deep["acceptance_event_id"], role="assistant", state="completed", phase="final_answer",
                    source="rust-v2-pilot", parentMessageId=self.data["remote_id"], text="Synthetic accepted result")

    def test_restart_and_same_accepted_final_are_idempotent_including_after_ack(self):
        self.notice(); reply = self.accepted()
        self.assertTrue(self.ledger.complete(self.data, copy.deepcopy(reply)))
        before = exports(self.ledger)
        self.ledger = Ledger(self.ledger.path, {"test_scope": "accepted-final"})
        self.data = self.ledger.input(self.data["remote_id"])
        self.assertTrue(self.ledger.complete(self.data, copy.deepcopy(reply)))
        self.assertEqual(exports(self.ledger), before)
        ack(self.ledger, reply["id"])
        after = self.ledger.input(self.data["remote_id"])
        self.assertTrue(self.ledger.complete(copy.deepcopy(after), copy.deepcopy(reply)))
        self.assertEqual(self.ledger.input(self.data["remote_id"]), after, "do not unprune a settled retry")
        self.assertEqual(len(exports(self.ledger)), 2)

    def test_conflicting_business_final_holds_without_marking_completed(self):
        first = self.accepted(); self.assertTrue(self.ledger.complete(self.data, first))
        self.data["phase"] = "running"; self.ledger.save(self.data)
        before = copy.deepcopy(self.ledger.input(self.data["remote_id"])); rows = exports(self.ledger)
        changed = dict(first, id=str(uuid.uuid4()), text="Conflicting answer")
        self.assertFalse(self.ledger.complete(self.data, changed))
        self.assertEqual(self.ledger.input(self.data["remote_id"]), before)
        self.assertEqual(exports(self.ledger), rows)

    def test_uncertain_business_final_is_held_even_for_same_acceptance(self):
        reply = self.accepted(); self.ledger.complete(self.data, reply)
        ack(self.ledger, reply["id"], outcome="uncertain")
        self.data["phase"] = "running"; self.ledger.save(self.data)
        before = self.ledger.input(self.data["remote_id"])
        self.assertFalse(self.ledger.complete(self.data, copy.deepcopy(reply)))
        self.assertEqual(self.ledger.input(self.data["remote_id"]), before)
        self.assertEqual(len(exports(self.ledger)), 1)

    def test_missing_or_changed_acceptance_proof_cannot_bypass_notice(self):
        self.notice(); reply = self.accepted()
        for field in ("run_id", "completion_event_id", "acceptance_event_id"):
            with self.subTest(field=field):
                changed = copy.deepcopy(self.data); changed["accepted"]["deep"].pop(field)
                self.ledger.save(changed)
                self.assertFalse(self.ledger.complete(changed, copy.deepcopy(reply)))
                self.assertEqual(self.ledger.input(changed["remote_id"])["phase"], "running")
        self.assertEqual(len(exports(self.ledger)), 1)

    def test_typed_notice_metadata_not_language_selects_recovery(self):
        self.notice(); reply = self.accepted()
        with self.ledger.connect() as db:
            row = db.execute("SELECT message FROM exports").fetchone(); message = json.loads(row[0])
            message["kind"] = "business"; message["text"] = "Technical failure"
            db.execute("UPDATE exports SET message=?", (json.dumps(message),))
        self.assertFalse(self.ledger.complete(self.data, reply))
        self.assertEqual(self.ledger.input(self.data["remote_id"])["phase"], "running")

    def test_recovered_key_cannot_alias_another_input_export_id(self):
        self.notice(); reply = self.accepted()
        with self.ledger.connect() as db:
            db.execute("INSERT INTO exports(export_id,input_id,kind,source_key,message) VALUES (?,?,?,?,?)",
                       (reply["id"], "another-input", "final", "another-final", json.dumps(reply)))
        self.assertFalse(self.ledger.complete(self.data, reply))
        self.assertEqual(self.ledger.input(self.data["remote_id"])["phase"], "running")

    def test_changed_completion_reference_cannot_alias_an_existing_accepted_final(self):
        self.notice(); reply = self.accepted()
        self.assertTrue(self.ledger.complete(self.data, copy.deepcopy(reply)))
        self.data["accepted"]["deep"]["completion_event_id"] = str(uuid.uuid4())
        self.data["phase"] = "running"; self.ledger.save(self.data)
        self.assertFalse(self.ledger.complete(self.data, copy.deepcopy(reply)))
        self.assertEqual(self.ledger.input(self.data["remote_id"])["phase"], "running")
        self.assertEqual(len(exports(self.ledger)), 2)

    def test_occupied_source_key_does_not_silently_complete_an_unexported_answer(self):
        reply = self.accepted()
        with self.ledger.connect() as db:
            db.execute("INSERT INTO exports(export_id,input_id,kind,source_key,message) VALUES (?,?,?,?,?)",
                       ("another-export", "another-input", "final", "final:" + self.data["remote_id"], json.dumps(reply)))
        self.assertFalse(self.ledger.complete(self.data, reply))
        self.assertEqual(self.ledger.input(self.data["remote_id"])["phase"], "running")

    def test_normal_no_notice_uses_existing_legacy_key_without_new_proof_requirement(self):
        reply = dict(id="synthetic-normal-final", role="assistant", state="completed",
                     parentMessageId=self.data["remote_id"], text="Normal reply")
        self.assertTrue(self.ledger.complete(self.data, reply))
        self.assertEqual(exports(self.ledger)[0][3], "final:" + self.data["remote_id"])

    def test_missing_ordinary_body_cannot_be_listed_as_a_pruned_parent(self):
        self.data.pop("text")
        self.ledger.save(self.data)
        with self.assertRaises(KeyError):
            self.ledger.listing()

    def test_pruned_parent_requires_reconciliation_and_current_acceptance(self):
        self.notice(); reply = self.accepted()
        self.assertTrue(self.ledger.complete(self.data, reply))
        original = copy.deepcopy(self.data)
        for field in ("operator_reconciliation", "accepted", "intake", "reply"):
            with self.subTest(field=field):
                changed = copy.deepcopy(original); changed.pop(field)
                self.ledger.save(changed)
                with self.assertRaises(KeyError):
                    self.ledger.listing()
        changed = copy.deepcopy(original)
        changed["operator_reconciliation"]["previous"]["settled"]["outcome"] = "uncertain"
        self.ledger.save(changed)
        with self.assertRaises(KeyError):
            self.ledger.listing()

    def test_missing_timer_body_does_not_use_reconciled_parent_exception(self):
        self.notice(); reply = self.accepted()
        self.assertTrue(self.ledger.complete(self.data, reply))
        self.data["origin"] = "timer"
        self.ledger.save(self.data)
        with self.assertRaises(KeyError):
            self.ledger.listing()


if __name__ == "__main__":
    unittest.main()
