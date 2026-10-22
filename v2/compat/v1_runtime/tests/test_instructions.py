"""Per-binding chat rules: a frozen leading line on intakes, never part of input identity."""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest

from v2.compat.v1_runtime import config as config_module, instructions
from v2.compat.v1_runtime.ledger import Ledger
from v2.compat.v1_runtime.tests.test_ledger_server import OWNER, Harness, binding_doc
from v2.compat.v1_runtime.tests.test_timer_relay import SCOPE, occurrence
from v2.compat.v1_runtime.tests.test_worker import Peer
from v2.compat.v1_runtime.worker import Worker


def expected(path):
    version = hashlib.sha256(Path(path).read_bytes()).hexdigest()[:12]
    return ("[Chat rules v%s: before answering, read %s (cat it) unless you already read this version "
            "in this session, and follow it.]" % (version, path))


class RulesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.rules = Path(self.temp.name) / "CHAT.md"
        self.rules.write_text("Answer in English.\n")
        self.ledger = Ledger(Path(self.temp.name) / "ledger.sqlite3", SCOPE)
        self.peer = Peer()
        self.worker = Worker(self.peer, self.ledger)
        self.worker.instructions_path = str(self.rules)

    def inbound(self, public_id, text="[WhatsApp: Owner]\n\nhello"):
        return self.ledger.enqueue({"publicThreadId": "v1-thread", "publicMessageId": public_id, "chatId": "chat@g.us",
                                    "accountId": "account", "text": text})

    def sent(self):
        return [body["text"] for route, body in self.peer.mutations if route == "/messages"]

    def test_line_comes_first_then_a_blank_line_then_the_unchanged_text(self):
        data, _ = self.inbound("wa-1")
        self.worker.step(data)
        self.assertEqual(self.sent(), [expected(self.rules) + "\n\n[WhatsApp: Owner]\n\nhello"])
        self.assertIsNone(self.worker.instructions_error)

    def test_changed_file_gets_a_new_version_but_a_retry_resends_the_frozen_text(self):
        first, _ = self.inbound("wa-1")
        original = self.peer.request
        lost = []

        def lose_intake(method, route, body=None, allowed=(200,)):
            if route == "/messages" and not lost:
                lost.append(body["text"])
                raise ConnectionError("synthetic lost response")
            return original(method, route, body, allowed)
        self.peer.request = lose_intake
        with self.assertRaises(ConnectionError):
            self.worker.step(first)
        old_line = expected(self.rules)
        self.rules.write_text("Answer in Turkish.\n")
        new_line = expected(self.rules)
        self.assertNotEqual(old_line, new_line)
        # The retry is the same frozen request (idempotent for Rust).
        retry = self.ledger.next_input()
        self.worker.step(retry)
        self.assertEqual(self.sent()[0], lost[0])
        self.assertTrue(lost[0].startswith(old_line + "\n\n"))
        # A later input reads the edited file.
        second, _ = self.inbound("wa-2")
        self.worker.step(second)
        self.assertTrue(self.sent()[-1].startswith(new_line + "\n\n"))

    def test_missing_file_sends_without_the_line_and_reports_it(self):
        os.unlink(self.rules)
        data, _ = self.inbound("wa-1")
        self.worker.step(data)
        self.assertEqual(self.sent(), ["[WhatsApp: Owner]\n\nhello"])
        self.assertEqual(self.worker.instructions_error, "instructions_unreadable")
        self.rules.write_text("back\n")
        later, _ = self.inbound("wa-2")
        self.worker.step(later)
        self.assertIsNone(self.worker.instructions_error)

    def test_not_part_of_the_identity_digest(self):
        data, duplicate = self.inbound("wa-1")
        self.worker.step(data)
        self.rules.write_text("Edited.\n")
        again, duplicate = self.inbound("wa-1")
        self.assertTrue(duplicate, "a V1 retry after a file change is still the same input")
        self.assertNotIn("Chat rules", again["text"])

    def test_timer_occurrences_and_posts_get_no_line(self):
        # A timer occurrence is already admitted in Core: no intake is sent for it.
        timer, _ = self.ledger.enqueue_timer(occurrence(2))
        self.assertIn("intake", timer)
        self.ledger.enqueue_post({"id": "a0000000-0000-4000-8000-000000000001", "author": "operator",
                                  "label": "Ops", "text": "Disk 91%"})
        self.assertEqual([m["text"] for m in self.ledger.messages() if m["role"] == "assistant"], ["Disk 91%"])
        self.assertEqual(self.sent(), [])


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def test_path_is_validated_at_load(self):
        good = Path(self.temp.name) / "rules.md"
        good.write_text("rules")
        self.assertEqual(config_module.binding(binding_doc(1, instructions_path=str(good)), OWNER)["instructions_path"],
                         str(good))
        self.assertIsNone(config_module.binding(binding_doc(1), OWNER)["instructions_path"])
        large = Path(self.temp.name) / "large.md"
        large.write_bytes(b"x" * (instructions.MAX_BYTES + 1))
        for bad in ("relative.md", str(Path(self.temp.name) / "missing.md"), self.temp.name, str(large), 7):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                config_module.binding(binding_doc(1, instructions_path=bad), OWNER)
        self.assertNotIn("instructions_path", config_module.binding(binding_doc(1, instructions_path=str(good)), OWNER)["scope"])


class HealthTests(Harness):
    def test_health_reports_the_instructions_error(self):
        self.assertIsNone(self.request("GET", "/threads/%s/health" % self.remote(1))[1]["instructionsError"])
        self.binding(1).worker.instructions_error = "instructions_unreadable"
        health = self.request("GET", "/threads/%s/health" % self.remote(1))[1]
        self.assertEqual(health["instructionsError"], "instructions_unreadable")


if __name__ == "__main__":
    unittest.main()
