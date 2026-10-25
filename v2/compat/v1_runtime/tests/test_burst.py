"""A WhatsApp burst (text, then photos one by one) becomes one Rust input and one reply."""
import contextlib
import hashlib
import io
from pathlib import Path
import tempfile
import time
import unittest

from v2.compat.v1_runtime import registry as registry_module
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.tests.test_worker import Peer
from v2.compat.v1_runtime.worker import BURST_MAX_WAIT_S, BURST_NOTE, DEFAULT_BURST_QUIET_S, Worker


def body(public_id, text, **extra):
    return dict(dict(publicMessageId=public_id, publicThreadId="thread", chatId="chat", accountId="account", text=text), **extra)


class BurstTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", {"test_scope": "one"})
        self.peer = Peer()

    def intakes(self):
        return [b["text"] for route, b in self.peer.mutations if route == "/messages"]

    def finals(self):
        return [m for m in self.ledger.messages() if m["role"] == "assistant" and m.get("phase") == "final_answer"]

    def age(self, public_id, seconds):
        with self.ledger.connect() as db:
            db.execute("UPDATE inputs SET data=json_set(data,'$.queued_at',?) WHERE public_id=?",
                       (time.time() - seconds, public_id))

    def test_queued_inputs_become_one_intake_with_one_reply_and_settle_together(self):
        for public_id, text in (("a", "merhaba, bi eksik fark ettim"), ("b", "en önemlisi bu"), ("c", "eski versiyonunda böyle")):
            self.ledger.enqueue(body(public_id, text))
        worker = Worker(self.peer, self.ledger)
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            worker.step(self.ledger.next_input())

        self.assertIn("burst_merged", log.getvalue())
        self.assertIn("absorbed=2", log.getvalue())
        self.assertNotIn("merhaba", log.getvalue(), "the log carries identifiers only")
        self.assertEqual(self.intakes(), ["\n\n".join([BURST_NOTE % 3, "merhaba, bi eksik fark ettim", "en önemlisi bu",
                                                       "eski versiyonunda böyle"])])
        finals = self.finals()
        self.assertEqual(len(finals), 1)
        self.assertIsNone(self.ledger.next_input(), "absorbed inputs never run again")
        # Absorbed inputs stay listed for V1 until the one reply is acknowledged.
        self.assertEqual(len([m for m in self.ledger.messages() if m["role"] == "user"]), 3)
        ack = self.ledger.acknowledge(finals[0]["id"], {"outcome": "delivered", "outboxJobId": "job",
                                                        "parentPublicMessageId": "a"})
        self.assertTrue(ack["settled"])
        self.assertEqual(self.ledger.messages(), [])
        self.assertEqual(self.ledger.health()["outstandingInputs"], 0)

    def test_a_fresh_input_waits_for_the_burst_to_go_quiet(self):
        worker = Worker(self.peer, self.ledger, burst_quiet_s=3)
        self.ledger.enqueue(body("a", "one"))
        self.ledger.enqueue(body("b", "two"))
        self.age("a", 2)
        worker.step(self.ledger.next_input())
        self.assertEqual(self.intakes(), [], "still inside the quiet period")
        self.ledger.enqueue(body("c", "three"))
        self.age("a", 5)
        self.age("b", 4)
        worker.step(self.ledger.next_input())
        self.assertEqual(self.intakes(), [], "a newer input restarts the quiet period")
        self.age("c", 3.5)
        worker.step(self.ledger.next_input())
        self.assertEqual(self.intakes(), ["\n\n".join([BURST_NOTE % 3, "one", "two", "three"])])

    def test_a_continuous_stream_cannot_hold_the_first_input_past_the_max_wait(self):
        worker = Worker(self.peer, self.ledger, burst_quiet_s=3)
        self.ledger.enqueue(body("a", "one"))
        self.ledger.enqueue(body("b", "two"))
        self.age("a", BURST_MAX_WAIT_S + 1)
        worker.step(self.ledger.next_input())
        self.assertEqual(self.intakes(), ["\n\n".join([BURST_NOTE % 2, "one", "two"])])

    def test_a_single_input_is_sent_unchanged(self):
        self.ledger.enqueue(body("a", "only one"))
        Worker(self.peer, self.ledger, burst_quiet_s=3).step(self.ledger.next_input())
        self.assertEqual(self.intakes(), ["only one"])

    def test_inputs_from_another_chat_or_author_or_already_sent_never_join(self):
        self.ledger.enqueue(body("a", "owner one"))
        self.ledger.enqueue(body("b", "other chat", chatId="chat-2"))
        self.ledger.enqueue(body("c", "owner two"))
        worker = Worker(self.peer, self.ledger)
        worker.step(self.ledger.next_input())
        self.assertEqual(self.intakes(), ["owner one"], "the run stops at the first incompatible input")
        member = {"role": "member", "id": "member@lid", "label": "Ayse", "labelled": True}
        self.ledger.enqueue(body("d", "from a member"), author=member)
        worker.step(self.ledger.next_input())
        worker.step(self.ledger.next_input())
        self.assertEqual(self.intakes()[1:], ["other chat", "owner two"])

    def test_attachments_of_every_absorbed_input_are_imported_and_named(self):
        imports = []
        def import_attachments(request):
            imports.append(request)
            return {"import_id": "import-%d" % len(imports), "manifest": request["target_manifest"],
                    "mapping": request["mapping"], "source_manifest_id": request["source"]["manifest"]["manifest_id"]}
        self.peer.import_attachments = import_attachments
        self.ledger.enqueue(body("a", "look at these"))
        for public_id in ("p1", "p2"):
            content = ("photo " + public_id).encode()
            digest = hashlib.sha256(content).hexdigest()
            upload, _ = self.ledger.stage_upload(public_id, public_id + ".jpg", "image/jpeg", content, digest)
            self.ledger.enqueue(body(public_id, "", attachments=[{"uploadId": upload, "sha256": digest}]))
        Worker(self.peer, self.ledger).step(self.ledger.next_input())
        self.assertEqual(len(imports), 2)
        [intake] = self.intakes()
        self.assertTrue(intake.startswith(BURST_NOTE % 3))
        for request in imports:
            self.assertIn(request["target_manifest"]["manifest_id"], intake)
        self.assertEqual(len(self.finals()), 1)

    def test_a_refused_burst_settles_every_absorbed_input_with_its_notice(self):
        self.ledger.enqueue(body("a", "one"))
        self.ledger.enqueue(body("b", "two"))
        head = self.ledger.next_input()
        worker = Worker(self.peer, self.ledger)
        self.assertTrue(worker.gather_burst(head))
        notice = self.ledger.refuse(head, "window_refused")
        self.assertIsNone(self.ledger.next_input())
        self.ledger.acknowledge(notice["id"], {"outcome": "delivered", "outboxJobId": "job", "parentPublicMessageId": "a"})
        self.assertEqual(self.ledger.health()["outstandingInputs"], 0)

    def test_the_registry_enables_the_quiet_period(self):
        self.assertEqual(registry_module.DEFAULT_BURST_QUIET_S, DEFAULT_BURST_QUIET_S)
        self.assertGreater(DEFAULT_BURST_QUIET_S, 0)


if __name__ == "__main__":
    unittest.main()
