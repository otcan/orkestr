"""Synthetic bindings only: fake identities, loopback HTTP, no Rust or WhatsApp peer."""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import uuid

from v2.compat.v1_runtime import config as config_module
from v2.compat.v1_runtime.ledger import Conflict, Ledger
from v2.compat.v1_runtime.registry import Registry
from v2.compat.v1_runtime.server import Server

OWNER = "00000000-0000-4000-8000-0000000000aa"


def binding_doc(n, **changes):
    value = dict(conversation_id=str(uuid.UUID(int=0x100 + n)), remote_thread_id=str(uuid.UUID(int=0x200 + n)),
                 public_thread_id="thread-%d" % n, chat_id="group-%d" % n, account_id="account",
                 allowed_principals=["owner"], excluded_public_ids=["old"], automatic_accept_roles=["fast", "deep"],
                 outbound_role="deep", enabled=True, revoked=False, progress_updates=False, attachments=False,
                 max_outstanding_inputs=32)
    value.update(changes)
    return value


def private_write(path, value):
    path = Path(path)
    path.write_text(json.dumps(value))
    path.chmod(0o600)


class Harness(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.bindings_dir, self.ledger_dir = root / "bindings", root / "ledgers"
        for directory in (self.bindings_dir, self.ledger_dir):
            directory.mkdir(mode=0o700)
        self.config = dict(listen_port=0, token="a" * 48, expected_owner=OWNER,
                           bindings_dir=str(self.bindings_dir), ledger_dir=str(self.ledger_dir))
        self.write(binding_doc(1))
        self.write(binding_doc(2))
        self.registry = Registry(self.config, lambda conversation: None, workers=False)
        self.registry.reload()
        self.server = Server(self.config, self.registry)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def write(self, value):
        private_write(self.bindings_dir / (value["remote_thread_id"] + ".json"), value)

    def close(self):
        self.server.shutdown()
        self.thread.join(3)
        self.server.server_close()

    def remote(self, n):
        return str(uuid.UUID(int=0x200 + n))

    def binding(self, n):
        return self.registry.get(self.remote(n))

    def body(self, n=1, **changes):
        value = dict(publicThreadId="thread-%d" % n, publicMessageId="message", chatId="group-%d" % n, accountId="account",
                     role="user", connector="whatsapp", source="whatsapp_inbound", text="new request", externalId="event",
                     senderParticipantId="owner", senderTrustLevel="owner", senderEffectiveRole="owner", **{"from": "owner"},
                     externalPrincipal=dict(connector="whatsapp", accountId="account", chatId="group-%d" % n,
                                            threadId="thread-%d" % n, senderId="owner", participantId="owner"))
        value.update(changes)
        return value

    def request(self, method, path, body=None, token=True):
        c = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + self.config["token"]
        c.request(method, path, None if body is None else json.dumps(body), headers)
        r = c.getresponse()
        value = json.loads(r.read())
        c.close()
        return r.status, value

    def post(self, n, action="input", body=None):
        return self.request("POST", "/threads/%s/%s" % (self.remote(n), action), self.body(n) if body is None else body)

    def listing(self, n, limit=100):
        return self.request("GET", "/threads/%s/messages?limit=%d" % (self.remote(n), limit))[1]

    def finish(self, n, public_id="message", text="deep", **reply):
        ledger = self.binding(n).ledger
        data, _ = ledger.enqueue(self.body(n, publicMessageId=public_id))
        ledger.complete(data, dict({"id": "acceptance-" + public_id, "role": "assistant", "state": "completed",
                                    "text": text, "parentMessageId": data["remote_id"]}, **reply))
        return data

    def ack(self, n, export_id, parent="message", **fields):
        body = dict(remoteMessageId=export_id, parentPublicMessageId=parent, localMessageId="local-" + export_id,
                    publicThreadId="thread-%d" % n, outcome="delivered", outboxJobId="job-1",
                    connectorMessageIds=["wa-1"])
        body.update(fields)
        return self.post(n, "mirror-acks", {k: v for k, v in body.items() if v is not None})


class PilotPropertyTests(Harness):
    def test_durable_idempotence_and_changed_content_conflict(self):
        status, first = self.post(1)
        self.assertEqual(status, 202)
        reopened = Ledger(self.binding(1).ledger.path, self.binding(1).config["scope"])
        self.assertEqual(reopened.next_input()["remote_id"], first["message"]["id"])
        self.assertEqual(self.post(1)[1]["message"]["id"], first["message"]["id"])
        self.assertEqual(self.post(1, body=self.body(1, text="different command"))[0], 409)
        self.assertEqual(reopened.next_input()["text"], "new request")

    def test_quoted_reply_context_is_kept_bounded_and_not_part_of_identity(self):
        quoted = dict(messageId="true_chat_ABC", author="orkestr", sentAt="2026-01-02T21:50:00Z", text="x" * 900, isOwnReply=True, junk=1)
        status, first = self.post(1, body=self.body(1, replyTo=quoted))
        self.assertEqual(status, 202)
        stored = self.binding(1).ledger.next_input()["reply_to"]
        self.assertEqual(stored, dict(message_id="true_chat_ABC", author="orkestr", sent_at="2026-01-02T21:50:00Z",
                                      text="x" * 500, is_own_reply=True, unavailable=False))
        # A retry (with or without the context) is the same input.
        self.assertEqual(self.post(1, body=self.body(1, replyTo=quoted))[1]["message"]["id"], first["message"]["id"])
        self.assertEqual(self.post(1)[1]["message"]["id"], first["message"]["id"])
        status, _ = self.post(1, body=self.body(1, publicMessageId="m2", replyTo=dict(unavailable=True, messageId=None, text="")))
        self.assertEqual(status, 202)
        self.assertEqual(self.binding(1).ledger.next_input()["remote_id"], first["message"]["id"])
        self.assertIsNone(Ledger.reply_to("nope"))
        self.assertIsNone(Ledger.reply_to(dict(author="someone")))

    def test_wrong_scope_principal_and_forwarded_owner_flag_do_not_authorize(self):
        for changed in (self.body(1, chatId="elsewhere"), self.body(1, publicThreadId="other"),
                        self.body(1, senderTrustLevel="unknown", originOwner=True, controlAllowed=True),
                        self.body(1, externalPrincipal="owner"), self.body(1, senderParticipantId="outsider"),
                        self.body(2)):
            self.assertEqual(self.post(1, body=changed)[0], 403)
        self.assertIsNone(self.binding(1).ledger.next_input())

    def test_requires_secret_and_never_exports_to_another_thread(self):
        self.assertEqual(self.request("POST", "/threads/%s/input" % self.remote(1), self.body(1), token=False)[0], 401)
        self.assertEqual(self.request("GET", "/threads/other/messages")[0], 404)
        self.assertEqual(self.request("GET", "/threads/%s/../messages" % self.remote(1))[0], 404)
        self.assertEqual(self.request("PATCH", "/threads/%s/messages/a/whatsapp-inbound-revision" % self.remote(1), {})[0], 409)

    def test_disabled_cutoff_and_attachments_are_explicit_refusals(self):
        self.write(binding_doc(1, enabled=False))
        self.registry.reload()
        self.assertEqual(self.post(1)[0], 503)
        self.write(binding_doc(1))
        self.registry.reload()
        self.assertEqual(self.post(1, body=self.body(1, publicMessageId="old"))[0], 409)
        self.assertEqual(self.post(1, body=self.body(1, attachments=[{"name": "file"}]))[0], 422)
        self.assertIsNone(self.binding(1).ledger.next_input())

    def test_only_final_reply_is_exported_with_immutable_parent(self):
        self.finish(1)
        messages = self.listing(1)["messages"]
        self.assertEqual([x["role"] for x in messages], ["user", "assistant"])
        self.assertEqual(messages[1]["parentMessageId"], messages[0]["id"])
        self.assertEqual((messages[0]["state"], messages[0]["publicMessageId"], messages[0]["chatId"]),
                         ("delivered", "message", "group-1"))
        self.assertEqual(messages[1]["exportSequence"], 1)
        self.assertEqual(self.listing(2)["messages"], [])

    def test_changed_scope_cannot_reuse_pending_or_completed_history(self):
        ledger = self.binding(1).ledger
        ledger.enqueue(self.body(1))
        with self.assertRaisesRegex(ValueError, "ledger_scope_changed"):
            Ledger(ledger.path, {"test_scope": "other"})
        self.assertEqual(len(ledger.messages()), 1)

    def test_private_ledger_permissions(self):
        os.chmod(self.binding(1).ledger.path, 0o644)
        with self.assertRaisesRegex(ValueError, "ledger_permissions"):
            Ledger(self.binding(1).ledger.path, self.binding(1).config["scope"])


class MultiBindingTests(Harness):
    def test_bindings_have_isolated_ledgers_and_scopes(self):
        self.assertEqual(self.post(1)[0], 202)
        self.assertEqual(self.post(2)[0], 202)
        self.assertNotEqual(self.binding(1).ledger.path, self.binding(2).ledger.path)
        self.assertEqual([m["chatId"] for m in self.listing(1)["messages"]], ["group-1"])
        self.assertEqual([m["chatId"] for m in self.listing(2)["messages"]], ["group-2"])

    def test_adding_a_binding_does_not_disturb_existing_ones(self):
        first, ledger = self.binding(1), self.binding(1).ledger
        self.post(1)
        self.write(binding_doc(3))
        self.assertEqual(self.registry.reload()["enabled"], 3)
        self.assertIs(self.binding(1), first)
        self.assertIs(self.binding(1).ledger, ledger)
        self.assertEqual(self.post(3)[0], 202)
        self.assertEqual(len(self.listing(1)["messages"]), 1)

    def test_disable_and_revoke_are_independent_and_revocation_is_permanent(self):
        self.finish(1)
        self.write(binding_doc(1, enabled=False))
        self.registry.reload()
        self.assertEqual(self.post(1, body=self.body(1, publicMessageId="next"))[0], 503)
        self.assertEqual(len(self.listing(1)["messages"]), 2)  # Paused bindings still export.
        self.assertEqual(self.ack(1, "acceptance-message")[0], 200)
        self.assertEqual(self.post(2)[0], 202)
        self.write(binding_doc(1, enabled=False, revoked=True))
        self.registry.reload()
        self.assertEqual(self.post(1, body=self.body(1, publicMessageId="next"))[0], 410)
        self.assertEqual(self.request("GET", "/threads/%s/messages" % self.remote(1))[0], 410)
        self.write(binding_doc(1, enabled=True, revoked=False))
        self.registry.reload()
        self.assertEqual(self.binding(1).state, "refused")
        self.assertEqual(self.binding(1).error, "binding_revoked")
        self.assertEqual(self.post(1, body=self.body(1, publicMessageId="next"))[0], 503)
        self.assertEqual(self.binding(2).state, "enabled")

    def test_scope_change_conflict_and_damage_refuse_only_that_binding(self):
        self.write(binding_doc(1, allowed_principals=["someone-else"]))
        self.registry.reload()
        self.assertEqual(self.binding(1).error, "binding_scope_changed")
        self.assertEqual(self.post(1)[0], 503)
        self.assertEqual(self.post(2)[0], 202)
        self.write(binding_doc(1))
        self.registry.reload()
        self.assertEqual(self.binding(1).state, "enabled")
        # A newcomer that reuses another binding's chat is refused; the incumbent continues.
        self.write(binding_doc(4, chat_id="group-2"))
        status = self.registry.reload()
        self.assertIsNone(self.binding(4))
        self.assertEqual(status["refused"], 1)
        self.assertEqual(self.binding(2).state, "enabled")
        (self.bindings_dir / (self.remote(2) + ".json")).write_text("{")
        self.registry.reload()
        self.assertEqual(self.binding(2).error, "binding_file_invalid")
        self.assertEqual(self.binding(1).state, "enabled")

    def test_binding_file_name_must_match_route(self):
        private_write(self.bindings_dir / "misnamed.json", binding_doc(5))
        self.registry.reload()
        self.assertIsNone(self.binding(5))


class AcknowledgementTests(Harness):
    def test_delivery_ack_settles_prunes_and_frees_capacity(self):
        ledger = self.binding(1).ledger
        ledger.max_outstanding = 2
        self.finish(1)
        self.post(1, body=self.body(1, publicMessageId="second"))
        self.assertEqual(self.post(1, body=self.body(1, publicMessageId="third"))[1]["error"], "binding_capacity_reached")
        self.assertEqual(self.ack(1, "acceptance-message", outboxJobId=None)[1]["error"], "ack_receipt_required")
        self.assertEqual(self.ack(1, "acceptance-message", parent="second")[1]["error"], "ack_parent_mismatch")
        self.assertEqual(self.ack(1, "unknown")[0], 404)
        status, result = self.ack(1, "acceptance-message")
        self.assertEqual((status, result["settled"], result["ackedThrough"]), (200, True, 1))
        self.assertEqual(self.ack(1, "acceptance-message")[1]["duplicate"], True)
        self.assertEqual(self.ack(1, "acceptance-message", outcome="failed")[1]["error"], "ack_conflict")
        self.assertEqual([m["publicMessageId"] for m in self.listing(1)["messages"]], ["second"])
        self.assertEqual(self.post(1, body=self.body(1, publicMessageId="third"))[0], 202)
        with ledger.connect() as db:
            stored = json.loads(db.execute("SELECT data FROM inputs WHERE public_id='message'").fetchone()[0])
            export = json.loads(db.execute("SELECT message FROM exports").fetchone()[0])
        self.assertNotIn("text", stored)
        self.assertNotIn("text", export)
        # Duplicate intake of a settled input is still idempotent and never re-executed.
        self.assertEqual(self.post(1)[0], 200)

    def test_health_exposes_refused_inputs_and_their_notice_is_listed(self):
        self.assertEqual(self.post(1, body=self.body(1, publicMessageId="refused"))[0], 202)
        ledger = self.registry.get(self.remote(1)).ledger
        ledger.refuse(ledger.next_input(), "execution_requires_review")
        health = self.request("GET", "/threads/%s/health" % self.remote(1))[1]
        self.assertEqual(health["refusedInputs"], 1)
        self.assertEqual(health["recentRefusals"][0]["reason"], "execution_requires_review")
        self.assertEqual(health["phase"], "idle")
        notice = self.listing(1)["messages"][-1]
        self.assertEqual((notice["kind"], notice["refusal"]), ("notice", "execution_requires_review"))

    def test_uncertain_delivery_is_never_pruned_until_resolved(self):
        self.finish(1)
        self.assertEqual(self.ack(1, "acceptance-message", outcome="uncertain", outboxJobId=None)[1]["settled"], False)
        listing = self.listing(1)
        self.assertEqual(len(listing["messages"]), 2)
        self.assertEqual(listing["mirrorAck"]["ackedThrough"], 0)
        self.assertEqual(self.request("GET", "/threads/%s/health" % self.remote(1))[1]["uncertainDeliveries"], 1)
        self.assertEqual(self.ack(1, "acceptance-message")[1]["settled"], True)
        self.assertEqual(self.ack(1, "acceptance-message", outcome="uncertain")[1]["error"], "ack_conflict")
        self.assertEqual(self.listing(1)["messages"], [])

    def test_no_reply_is_never_acknowledged_as_transported(self):
        self.finish(1, text="NO_REPLY", noReply=True)
        self.assertEqual(self.ack(1, "acceptance-message")[1]["error"], "no_reply_transported")
        self.finish(1, public_id="visible")
        self.assertEqual(self.ack(1, "acceptance-visible", parent="visible", outcome="no_reply")[1]["error"],
                         "ack_outcome_mismatch")
        self.assertEqual(self.ack(1, "acceptance-message", outcome="no_reply", outboxJobId=None)[1]["settled"], True)

    def test_progress_is_bounded_ordered_and_retired_by_final(self):
        ledger = self.binding(1).ledger
        data, _ = ledger.enqueue(self.body(1))
        for n in range(4):
            ledger.add_progress(data, "payload-%d" % n, "step %d" % n)
        ledger.add_progress(data, "payload-0", "duplicate payload")
        rows = self.listing(1)["messages"]
        self.assertEqual([r.get("kind", r["role"]) for r in rows], ["user", "progress", "progress", "progress"])
        self.assertEqual(rows[1]["phase"], "commentary")
        progress = rows[1]["id"]
        self.assertEqual(self.ack(1, progress, outcome="suppressed", outboxJobId=None)[0], 200)
        ledger.complete(data, {"id": "final", "role": "assistant", "state": "completed", "text": "done",
                               "parentMessageId": data["remote_id"]})
        self.assertEqual([r.get("kind", r["role"]) for r in self.listing(1)["messages"]],
                         ["user", "progress", "progress", "assistant"])
        self.assertEqual(self.ack(1, "final")[1]["ackedThrough"], 4)
        self.assertEqual(self.listing(1)["messages"], [])
        self.assertEqual(self.ack(1, rows[2]["id"], outcome="delivered")[0], 200)  # Late report is recorded.

    def test_listing_is_oldest_first_and_flags_truncation(self):
        for n in range(3):
            self.finish(1, public_id="m%d" % n)
        page = self.listing(1, limit=3)
        self.assertTrue(page["truncated"])
        self.assertEqual([m["id"] for m in page["messages"]][1], "acceptance-m0")
        self.ack(1, "acceptance-m0", parent="m0")
        self.assertEqual(self.listing(1, limit=3)["messages"][0]["publicMessageId"], "m1")


class AttachmentTests(Harness):
    def setUp(self):
        super().setUp()
        self.write(binding_doc(1, attachments=True))
        self.registry.reload()

    def upload(self, content=b"synthetic image", **changes):
        body = dict(publicMessageId="message", filename="photo.jpg", mediaType="image/jpeg", size=len(content),
                    sha256=hashlib.sha256(content).hexdigest(), contentBase64=base64.b64encode(content).decode())
        body.update(changes)
        return self.post(1, "attachments", body)

    def test_upload_integrity_idempotence_and_reference(self):
        self.assertEqual(self.upload(sha256="0" * 64)[1]["error"], "upload_integrity")
        self.assertEqual(self.upload(filename="../x")[1]["error"], "invalid_upload")
        status, first = self.upload()
        self.assertEqual(status, 201)
        self.assertEqual(self.upload()[1]["upload"]["uploadId"], first["upload"]["uploadId"])
        reference = [{"uploadId": first["upload"]["uploadId"], "sha256": first["upload"]["sha256"]}]
        self.assertEqual(self.post(1, body=self.body(1, publicMessageId="other", attachments=reference))[1]["error"],
                         "attachment_upload_missing")
        self.assertEqual(self.post(1, body=self.body(1, text="", attachments=reference))[0], 202)
        data = self.binding(1).ledger.next_input()
        self.assertEqual(data["attachments"][0]["filename"], "photo.jpg")
        self.assertIn("attachments", data["keys"])

    def test_text_only_binding_refuses_uploads(self):
        self.assertEqual(self.post(2, "attachments", {})[1]["error"], "text_only_binding")


class MigrationTests(unittest.TestCase):
    def test_pilot_ledger_is_adopted_and_its_reply_reexported_unacknowledged(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "pilot.sqlite3"
            scope = {"pilot": "scope"}
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
            db = sqlite3.connect(path)
            db.execute("CREATE TABLE ledger_scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL)")
            db.execute("INSERT INTO ledger_scope VALUES (1,?)",
                       (json.dumps({"schema": 1, "scope": scope}, sort_keys=True, separators=(",", ":")),))
            db.execute("CREATE TABLE inputs (public_id TEXT PRIMARY KEY, digest TEXT NOT NULL, remote_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL)")
            reply = {"id": "accepted", "role": "assistant", "state": "completed", "text": "old", "parentMessageId": "r1"}
            for public, remote, data in (("p1", "r1", {"phase": "completed", "reply": reply}), ("p2", "r2", {"phase": "queued"})):
                data.update(remote_id=remote, public_id=public, text="t", public_thread_id="x", chat_id="c", account_id="a")
                db.execute("INSERT INTO inputs VALUES (?,?,?,?)", (public, "d", remote, json.dumps(data)))
            db.commit()
            db.close()
            ledger = Ledger(path, scope)
            rows = ledger.messages()
            self.assertEqual([r["role"] for r in rows], ["user", "assistant", "user"])
            self.assertEqual(rows[1]["exportSequence"], 1)
            self.assertEqual(ledger.next_input()["remote_id"], "r2")
            ledger.acknowledge("accepted", {"outcome": "delivered", "outboxJobId": "job", "parentPublicMessageId": "p1"})
            self.assertEqual([r["publicMessageId"] for r in Ledger(path, scope).messages()], ["p2"])

    def test_pilot_config_becomes_one_static_binding(self):
        with tempfile.TemporaryDirectory() as temp:
            token = Path(temp) / "token.json"
            private_write(token, {"token": "b" * 40})
            pilot = dict(origin="https://example.test", loopback_url="http://127.0.0.1:9", credentials_path="/x",
                         expected_owner=OWNER, expected_source="c" * 40, token_path=str(token), listen_port=4000,
                         ledger_path=str(Path(temp) / "l.sqlite3"), **{k: v for k, v in binding_doc(1).items()
                         if k in config_module.SCOPE_FIELDS}, enabled=False)
            private_write(Path(temp) / "pilot.json", pilot)
            service, static = config_module.load(Path(temp) / "pilot.json")
            self.assertEqual(len(static), 1)
            self.assertEqual(static[0]["max_outstanding_inputs"], 32)
            self.assertEqual(static[0]["scope"]["expected_owner"], OWNER)
            self.assertFalse(static[0]["progress_updates"] or static[0]["attachments"])
            registry = Registry(service, lambda c: None, static, workers=False)
            registry.reload()
            self.assertEqual(registry.get(static[0]["remote_thread_id"]).state, "disabled")


if __name__ == "__main__":
    unittest.main()
