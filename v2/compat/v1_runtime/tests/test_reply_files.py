"""Reply attachments (ORK-779): a Deep reply that attached a workspace file is
exported once with that file, and a fake V1 bridge sends it exactly once.
Synthetic bindings, bytes and identities only; no Rust, V1 or WhatsApp peer."""
import copy
import hashlib
import http.client
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

from v2.compat.v1_runtime import reply_files
from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.tests import intake_fixture as fixture
from v2.compat.v1_runtime.tests.test_ledger_server import Harness
from v2.compat.v1_runtime.tests.test_single_agent import SingleIntakePeer
from v2.compat.v1_runtime.worker import Worker

CONVERSATION = fixture.IntakePeer.conversation
MANIFEST = "00000000-0000-4000-8000-0000000000f1"
REFERENCE = "00000000-0000-4000-8000-0000000000f2"
ZIP = b"PK\x03\x04synthetic October package"
SHA = hashlib.sha256(ZIP).hexdigest()
MARKER = '[orkestr-attachment manifest=%s reference=%s name="October package.zip"]' % (MANIFEST, REFERENCE)


def manifest(conversation=CONVERSATION, **changes):
    reference = dict(reference_id=REFERENCE, message_id=None, filename="October package.zip",
                     media_type="application/zip", byte_length=len(ZIP), sha256=SHA, state="available")
    reference.update(changes)
    return dict(schema_version=1, manifest_id=MANIFEST, owner_id=fixture.IntakePeer.owner,
                conversation_id=conversation, references=[reference])


class AttachmentPeer(SingleIntakePeer):
    """Core with one agent attachment of the conversation."""

    def __init__(self):
        super().__init__()
        self.manifest, self.manifest_reads = manifest(), 0

    def request(self, method, route, body=None, allowed=(200,)):
        if method == "GET" and route.startswith("/agent-attachments/"):
            self.manifest_reads += 1
            if self.manifest is None or route != "/agent-attachments/" + MANIFEST:
                raise ClientError("unexpected_status", 404)
            return 200, copy.deepcopy(self.manifest)
        return super().request(method, route, body, allowed)


class ExportDir:
    """Core's delivery copy, `<dir>/<conversation>/<sha256>.zip`."""

    def setUp(self):
        super().setUp()
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.exports = Path(temporary.name) / "core-exports"
        (self.exports / CONVERSATION).mkdir(parents=True)
        (self.exports / CONVERSATION / (SHA + ".zip")).write_bytes(ZIP)
        patcher = mock.patch.dict(os.environ, {reply_files.EXPORT_DIR_ENV: str(self.exports),
                                               reply_files.SWITCH_ENV: "on"})
        patcher.start()
        self.addCleanup(patcher.stop)


class Fake:
    """The worker surface `prepare` uses."""

    def __init__(self, peer, attachments=True):
        self.client, self.attachments = peer, attachments

    def call(self, method, route, body=None, allowed=(200,)):
        return self.client.request(method, route, body, allowed)[1]


class PrepareTests(ExportDir, unittest.TestCase):
    def test_markers_become_one_verified_descriptor_and_leave_the_text(self):
        peer = AttachmentPeer()
        text, files = reply_files.prepare(Fake(peer), "The October package is ready.\n\n%s\n%s\n" % (MARKER, MARKER))
        self.assertEqual(text, "The October package is ready.")
        self.assertEqual(files, [dict(id=REFERENCE, filename="October package.zip", mimetype="application/zip",
                                      size=len(ZIP), sha256=SHA)])
        self.assertEqual(peer.manifest_reads, 1)
        self.assertEqual(reply_files.prepare(Fake(peer), "No files here."), ("No files here.", []))

    def test_unverifiable_files_are_named_not_attached_and_never_sent(self):
        cases = {
            "owner upload or unknown manifest": dict(manifest=None),
            "another conversation": dict(manifest=manifest(conversation=fixture.identity(9))),
            "type WhatsApp is not sent": dict(manifest=manifest(media_type="text/html")),
            "removed": dict(manifest=manifest(state="removed")),
            "digest changed": dict(manifest=manifest(sha256="0" * 64)),
        }
        for label, change in cases.items():
            peer = AttachmentPeer()
            peer.manifest = change["manifest"]
            text, files = reply_files.prepare(Fake(peer), "Done.\n" + MARKER)
            self.assertEqual(files, [], label)
            self.assertEqual(text, "Done.\n\nOctober package.zip (not attached)", label)
        # A binding without attachments never sends files either.
        text, files = reply_files.prepare(Fake(AttachmentPeer(), attachments=False), MARKER)
        self.assertEqual((text, files), ("October package.zip (not attached)", []))
        # Without Core's delivery copy nothing is attached.
        (self.exports / CONVERSATION / (SHA + ".zip")).unlink()
        self.assertEqual(reply_files.prepare(Fake(AttachmentPeer()), MARKER)[1], [])

    def test_switched_off_the_file_is_named_for_the_web_app_and_core_is_not_asked(self):
        peer = AttachmentPeer()
        with mock.patch.dict(os.environ, {reply_files.SWITCH_ENV: ""}):
            text, files = reply_files.prepare(Fake(peer), "Done.\n" + MARKER)
        self.assertEqual((text, files), ("Done.\n\nOctober package.zip (attached in the Orkestr app)", []))
        self.assertEqual(peer.manifest_reads, 0)

    def test_a_transient_core_failure_retries_the_reply_instead_of_dropping_the_file(self):
        peer = AttachmentPeer()
        original = peer.request

        def down(method, route, body=None, allowed=(200,)):
            if route.startswith("/agent-attachments/"):
                raise ClientError("transport_failed")
            return original(method, route, body, allowed)
        peer.request = down
        with self.assertRaises(ClientError):
            reply_files.prepare(Fake(peer), MARKER)

    def test_only_exact_marker_lines_count(self):
        quoted = "Use %s later" % MARKER
        self.assertEqual(reply_files.split(quoted), (quoted, []))
        self.assertEqual(reply_files.split("x\r\n%s\r\n" % MARKER)[1], [(MANIFEST, REFERENCE, "October package.zip")])
        nil = "[orkestr-attachment manifest=%s reference=00000000-0000-0000-0000-000000000000]" % MANIFEST
        self.assertEqual(reply_files.split(nil), (nil, []))


class FakeBridge:
    """V1's remote mirror plus the scoped relay, reduced to their send contract:
    import each listed assistant export once (by its remote ID, as V1 does),
    fetch its attachments from the adapter, send them to the reply's own chat,
    then acknowledge the transport outcome."""

    def __init__(self, harness, n):
        self.harness, self.n = harness, n
        self.imported, self.sends = set(), []

    def download(self, remote, attachment_id):
        c = http.client.HTTPConnection("127.0.0.1", self.harness.server.server_port, timeout=5)
        c.request("GET", "/threads/%s/attachments/%s/download" % (remote, attachment_id),
                  headers={"Authorization": "Bearer " + self.harness.config["token"],
                           "Accept": "application/octet-stream", "Content-Type": "application/json"})
        response = c.getresponse()
        data = response.read()
        c.close()
        return response.status, response.getheader("Content-Type"), data

    def poll(self):
        listing = self.harness.listing(self.n)
        parents = {m["id"]: m for m in listing["messages"] if m["role"] == "user"}
        for message in listing["messages"]:
            if message["role"] != "assistant" or message["id"] in self.imported:
                continue
            self.imported.add(message["id"])
            chat = parents[message["parentMessageId"]]["chatId"]
            self.sends.append(("text", chat, message["text"]))
            for item in message.get("attachments") or []:
                status, media, data = self.download(self.harness.remote(self.n), item["id"])
                assert status == 200 and media == item["mimetype"], (status, media)
                assert hashlib.sha256(data).hexdigest() == item["sha256"]
                self.sends.append(("media", chat, item["filename"], data))
            status, value = self.harness.ack(self.n, message["id"], parent=parents[message["parentMessageId"]]["publicMessageId"])
            assert status == 200, value


class EndToEndTests(ExportDir, Harness):
    def setUp(self):
        super().setUp()
        self.ledger = self.binding(1).ledger
        self.peer = AttachmentPeer()

    def write(self, value):
        # Binding 1 is the peer's conversation and takes attachments.
        if value["remote_thread_id"] == self.remote(1):
            value = dict(value, conversation_id=CONVERSATION, attachments=True)
        super().write(value)

    def new_worker(self):
        worker = Worker(self.peer, self.ledger)
        worker.fast_reply_policy, worker.web_mirror, worker.attachments = "disabled", False, True
        worker._timers_checked = worker._posts_checked = worker._digest_checked = time.monotonic()
        return worker

    def test_a_reply_with_an_attachment_is_one_whatsapp_media_send(self):
        self.ledger.enqueue(dict(publicMessageId="message", publicThreadId="thread-1", chatId="group-1",
                                 accountId="account", text="Send me the October package"),
                            author=dict(role="owner", id="owner", label="owner"))
        worker = self.new_worker()
        worker.run_once(fixture.Stop())
        run = self.peer.runs[0, "deep"]
        self.peer.texts[run["run_id"]] = "Here is the October package.\n\n" + MARKER
        run["phase"] = "awaiting_acceptance"
        self.peer.request("POST", "/accept", body={
            "run_id": run["run_id"], "completion_event_id": run["acceptance_candidate"]["completion_event_id"],
            "expected_revision": self.peer.revision, "request_key": "synthetic-core-auto-accept"})
        worker.run_once(fixture.Stop())
        # A retried pass and a restarted worker export nothing new.
        worker.run_once(fixture.Stop())
        self.new_worker().run_once(fixture.Stop())
        finals = [m for m in self.ledger.messages() if m["role"] == "assistant"]
        self.assertEqual(len(finals), 1)
        self.assertEqual(finals[0]["text"], "Here is the October package.")
        self.assertEqual([a["id"] for a in finals[0]["attachments"]], [REFERENCE])
        # Another binding's route never serves this binding's file.
        bridge = FakeBridge(self, 1)
        self.assertEqual(bridge.download(self.remote(2), REFERENCE)[0], 404)
        # The bridge polls repeatedly (and V1 retries); the file goes out once,
        # to this reply's own chat.
        for _ in range(3):
            bridge.poll()
        media = [s for s in bridge.sends if s[0] == "media"]
        self.assertEqual(media, [("media", "group-1", "October package.zip", ZIP)])
        self.assertEqual([s for s in bridge.sends if s[0] == "text"], [("text", "group-1", "Here is the October package.")])
        # Once delivered, the file is no longer served: a bridge that lost its
        # state cannot send it again.
        fresh = FakeBridge(self, 1)
        fresh.poll()
        self.assertEqual(fresh.sends, [])
        self.assertEqual(fresh.download(self.remote(1), REFERENCE)[0], 404)

    def test_marker_lines_never_reach_the_chat_as_text(self):
        self.finish(1, text="Progress note\n" + MARKER)
        (message,) = [m for m in self.listing(1)["messages"] if m["role"] == "assistant"]
        self.assertEqual(message["text"], "Progress note")
        self.assertNotIn("attachments", message)


if __name__ == "__main__":
    unittest.main()
