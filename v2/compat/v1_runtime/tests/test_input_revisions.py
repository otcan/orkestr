"""The owner's WhatsApp edits and deletions reach Core once. Synthetic data only."""
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

from v2.compat.v1_runtime import input_revisions
from v2.compat.v1_runtime.ledger import Conflict, Ledger
from v2.compat.v1_runtime.tests.test_ledger_server import Harness
from v2.compat.v1_runtime.tests.test_timer_relay import SCOPE

CORE_MESSAGE = "a0000000-0000-4000-8000-000000000001"
OWNER_AUTHOR = {"role": "owner", "id": "owner", "label": "Owner"}


class Client:
    conversation = "conversation"

    def __init__(self, answers=(), features=("message_revisions_v1",)):
        self.calls, self.answers, self.features = [], list(answers), list(features)

    def request(self, method, route, body=None, allowed=(200,)):
        self.calls.append((method, route, body))
        if self.answers:
            answer = self.answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer
        return 201, {"notice_message_id": "notice"}


def change(revision_id="wa:1", kind="edit", text="corrected", public_id="public"):
    value = {"revisionId": revision_id, "publicMessageId": public_id, "kind": kind}
    if kind == "edit":
        value["text"] = text
    return value


class DriveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", SCOPE)

    def input(self, public_id="public", author=OWNER_AUTHOR, admitted=True):
        data, _ = self.ledger.enqueue(dict(publicMessageId=public_id, publicThreadId="v1-thread", chatId="chat@g.us",
                                           accountId="account", text="original"), author)
        if admitted:
            data["intake"] = {"message_id": CORE_MESSAGE, "event_id": "event", "sequence": 3}
            self.ledger.save(data)
        return data

    def worker(self, client):
        return SimpleNamespace(client=client, ledger=self.ledger)

    def state(self):
        with self.ledger.connect() as db:
            return db.execute("SELECT state,outcome FROM input_revisions").fetchall()

    def test_a_change_is_kept_once_and_a_reused_id_with_other_text_is_refused(self):
        self.input()
        self.assertFalse(input_revisions.accept(self.ledger, change(), Conflict))
        self.assertTrue(input_revisions.accept(self.ledger, change(), Conflict))
        with self.assertRaises(Conflict):
            input_revisions.accept(self.ledger, change(text="different"), Conflict)
        self.assertEqual(len(self.state()), 1)

    def test_only_the_owners_own_input_can_change(self):
        self.input(public_id="member", author={"role": "member", "id": "someone", "label": "A member"})
        with self.assertRaises(Conflict) as caught:
            input_revisions.accept(self.ledger, change(public_id="member"), Conflict)
        self.assertEqual(str(caught.exception), "not_owner_input")
        with self.assertRaises(LookupError):
            input_revisions.accept(self.ledger, change(public_id="unknown"), Conflict)

    def test_invalid_shapes_are_refused(self):
        self.input()
        for bad in (change(kind="pin"), change(text="   "), change(revision_id="has space"),
                    dict(change(kind="delete"), text="no"), change(text="x" * 28673)):
            with self.assertRaises(ValueError, msg=bad):
                input_revisions.accept(self.ledger, bad, Conflict)

    def test_an_edit_waits_for_its_input_then_reaches_core_once(self):
        data = self.input(admitted=False)
        input_revisions.accept(self.ledger, change(), Conflict)
        client = Client()
        input_revisions.drive(self.worker(client))
        self.assertEqual(client.calls, [], "the input is not in Core yet")
        data["intake"] = {"message_id": CORE_MESSAGE, "event_id": "event", "sequence": 3}
        self.ledger.save(data)
        input_revisions.drive(self.worker(client))
        method, route, body = client.calls[0]
        self.assertEqual((method, route), ("POST", "/messages/%s/revisions" % CORE_MESSAGE))
        self.assertEqual((body["kind"], body["text"], body["source"]), ("edit", "corrected", "whatsapp"))
        self.assertTrue(body["request_key"].startswith("whatsapp-revision:"))
        input_revisions.drive(self.worker(client))
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(self.state(), [("done", "notice")])

    def test_an_ordinary_change_is_not_marked_as_a_part(self):
        self.input()
        input_revisions.accept(self.ledger, change(), Conflict)
        client = Client()
        input_revisions.drive(self.worker(client))
        self.assertNotIn("part", client.calls[0][2])

    def test_a_deletion_carries_no_text(self):
        self.input()
        input_revisions.accept(self.ledger, change(kind="delete"), Conflict)
        client = Client()
        input_revisions.drive(self.worker(client))
        self.assertNotIn("text", client.calls[0][2])
        self.assertEqual(client.calls[0][2]["kind"], "delete")

    def test_core_refusal_is_final_and_a_failure_retries_with_the_same_key(self):
        self.input()
        input_revisions.accept(self.ledger, change(), Conflict)
        failing = Client(answers=[RuntimeError("transport")])
        with self.assertRaises(RuntimeError):
            input_revisions.drive(self.worker(failing))
        self.assertEqual(self.state()[0][0], "pending")
        refused = Client(answers=[(403, {"code": "not_owner_message"})])
        input_revisions.drive(self.worker(refused))
        self.assertEqual(failing.calls[0][2]["request_key"], refused.calls[0][2]["request_key"])
        self.assertEqual(self.state(), [("refused", "not_owner_message")])
        input_revisions.drive(self.worker(refused))
        self.assertEqual(len(refused.calls), 1, "a refusal is not retried")

    def test_a_replayed_or_late_edit_is_settled_without_error(self):
        self.input()
        input_revisions.accept(self.ledger, change(), Conflict)
        client = Client(answers=[(409, {"code": "message_revision_unchanged"})])
        input_revisions.drive(self.worker(client))
        self.assertEqual(self.state(), [("done", "message_revision_unchanged")])

    def test_one_part_of_a_merged_burst_is_a_part_revision_of_its_head(self):
        head = self.input(public_id="head")
        part, _ = self.ledger.enqueue(dict(publicMessageId="part", publicThreadId="v1-thread", chatId="chat@g.us",
                                           accountId="account", text="second part"), OWNER_AUTHOR)
        part["absorbed_into"] = head["remote_id"]
        self.ledger.save(part)
        input_revisions.accept(self.ledger, change(public_id="part"), Conflict)
        client = Client()
        input_revisions.drive(self.worker(client))
        method, route, body = client.calls[0]
        self.assertEqual((method, route), ("POST", "/messages/%s/revisions" % CORE_MESSAGE))
        self.assertEqual((body["part"], body["kind"], body["text"], body["source"]), (True, "edit", "corrected", "whatsapp"))
        self.assertEqual(self.state(), [("done", "notice")])

    def test_nothing_is_sent_to_a_server_without_the_feature(self):
        self.input()
        input_revisions.accept(self.ledger, change(), Conflict)
        client = Client(features=("message_author",))
        input_revisions.drive(self.worker(client))
        self.assertEqual(client.calls, [])
        self.assertEqual(self.state()[0][0], "pending")

    def test_an_input_that_never_reached_core_stops_being_retried(self):
        self.input(admitted=False)
        input_revisions.accept(self.ledger, change(), Conflict)
        input_revisions.drive(self.worker(Client()), now=4102444800)
        self.assertEqual(self.state(), [("expired", "input_never_admitted")])


class RouteTests(Harness):
    def revision(self, n=1, **changes):
        value = dict(publicThreadId="thread-%d" % n, chatId="group-%d" % n, accountId="account", role="user",
                     connector="whatsapp", source="whatsapp_inbound", publicMessageId="message",
                     revisionId="wa:1", kind="edit", text="corrected")
        value.update(changes)
        return value

    def test_the_route_keeps_a_change_for_a_held_input_only(self):
        self.assertEqual(self.post(1)[0], 202)
        status, value = self.post(1, "input-revision", self.revision())
        self.assertEqual((status, value["duplicate"]), (202, False))
        self.assertEqual(self.post(1, "input-revision", self.revision())[0], 200)
        self.assertEqual(self.post(1, "input-revision", self.revision(publicMessageId="other", revisionId="wa:2"))[0], 404)
        self.assertEqual(self.post(1, "input-revision", self.revision(chatId="group-2"))[0], 403)
        self.assertEqual(self.post(1, "input-revision", self.revision(kind="pin", revisionId="wa:3"))[0], 422)

    def test_health_advertises_the_route(self):
        self.assertEqual(self.request("GET", "/health")[1]["inputRevisions"], {"version": 1, "path": "input-revision"})


if __name__ == "__main__":
    unittest.main()
