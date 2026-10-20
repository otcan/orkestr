import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest

from v2.compat.v1_runtime.ledger import Conflict, Ledger
from v2.compat.v1_runtime.server import Server


class LedgerServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "one"})
        self.config = dict(listen_port=0, token="a" * 48, enabled=True, remote_thread_id="remote",
            public_thread_id="thread", chat_id="group", account_id="account", allowed_principals=["owner"], excluded_public_ids=["old"])
        self.body = dict(publicThreadId="thread", publicMessageId="message", chatId="group", accountId="account",
            role="user", connector="whatsapp", source="whatsapp_inbound", text="new request", externalId="event",
            senderParticipantId="owner", senderTrustLevel="owner", senderEffectiveRole="owner", **{"from": "owner"},
            externalPrincipal=dict(connector="whatsapp", accountId="account", chatId="group", threadId="thread", senderId="owner", participantId="owner"))
        self.server = Server(self.config, self.ledger)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.thread.join(3)
        self.server.server_close()

    def request(self, method, path="/threads/remote/input", body=None, token=True):
        c = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + self.config["token"]
        c.request(method, path, None if body is None else json.dumps(body), headers)
        r = c.getresponse()
        value = json.loads(r.read())
        c.close()
        return r.status, value

    def test_durable_idempotence_and_changed_content_conflict(self):
        status, first = self.request("POST", body=self.body)
        self.assertEqual(status, 202)
        reopened = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "one"})
        self.assertEqual(reopened.next_input()["remote_id"], first["message"]["id"])
        self.assertEqual(self.request("POST", body=self.body)[1]["message"]["id"], first["message"]["id"])
        changed = dict(self.body, text="different command")
        self.assertEqual(self.request("POST", body=changed)[0], 409)
        self.assertEqual(reopened.next_input()["text"], "new request")

    def test_wrong_scope_principal_and_forwarded_owner_flag_do_not_authorize(self):
        for changed in (dict(self.body, chatId="elsewhere"), dict(self.body, publicThreadId="other"),
                        dict(self.body, senderTrustLevel="unknown", originOwner=True, controlAllowed=True),
                        dict(self.body, externalPrincipal="owner"), dict(self.body, senderParticipantId="outsider")):
            self.assertEqual(self.request("POST", body=changed)[0], 403)
        self.assertIsNone(self.ledger.next_input())

    def test_requires_secret_and_never_exports_to_another_thread(self):
        self.assertEqual(self.request("POST", body=self.body, token=False)[0], 401)
        self.assertEqual(self.request("GET", "/threads/other/messages")[0], 404)
        self.assertEqual(self.request("PATCH", "/threads/remote/messages/a/whatsapp-inbound-revision", {})[0], 409)

    def test_disabled_cutoff_and_attachments_are_explicit_refusals(self):
        self.config["enabled"] = False
        self.assertEqual(self.request("POST", body=self.body)[0], 503)
        self.config["enabled"] = True
        self.assertEqual(self.request("POST", body=dict(self.body, publicMessageId="old"))[0], 409)
        self.assertEqual(self.request("POST", body=dict(self.body, attachments=[{"name": "file"}]))[0], 422)
        self.assertIsNone(self.ledger.next_input())

    def test_only_final_reply_is_exported_with_immutable_parent(self):
        data, _ = self.ledger.enqueue(self.body)
        data["reply"] = {"id": "acceptance", "role": "assistant", "state": "completed", "text": "deep", "parentMessageId": data["remote_id"]}
        data["phase"] = "completed"
        self.ledger.save(data)
        messages = self.request("GET", "/threads/remote/messages?limit=100")[1]["messages"]
        self.assertEqual([x["role"] for x in messages], ["user", "assistant"])
        self.assertEqual(messages[1]["parentMessageId"], messages[0]["id"])
        self.assertEqual(messages[0]["state"], "delivered")
        self.assertEqual(messages[0]["publicMessageId"], "message")
        self.assertEqual(messages[0]["chatId"], "group")
        self.assertEqual(messages[0]["accountId"], "account")

    def test_capacity_never_discards_unacknowledged_pilot_history(self):
        for number in range(32):
            self.ledger.enqueue(dict(self.body, publicMessageId=str(number)))
        with self.assertRaisesRegex(Conflict, "pilot_capacity_reached"):
            self.ledger.enqueue(dict(self.body, publicMessageId="overflow"))
        self.assertEqual(len(self.ledger.messages()), 32)

    def test_changed_scope_cannot_reuse_pending_or_completed_history(self):
        data, _ = self.ledger.enqueue(self.body)
        with self.assertRaisesRegex(ValueError, "ledger_scope_changed"):
            Ledger(self.ledger.path, {"test_scope": "other"})
        data["phase"] = "completed"
        self.ledger.save(data)
        with self.assertRaisesRegex(ValueError, "ledger_scope_changed"):
            Ledger(self.ledger.path, {"test_scope": "other"})
        self.assertEqual(len(self.ledger.messages()), 1)

    def test_private_ledger_permissions(self):
        os.chmod(self.ledger.path, 0o644)
        with self.assertRaisesRegex(ValueError, "ledger_permissions"):
            Ledger(self.ledger.path, {"test_scope": "one"})


if __name__ == "__main__":
    unittest.main()
