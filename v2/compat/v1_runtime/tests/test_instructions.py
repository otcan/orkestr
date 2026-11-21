"""Per-binding chat rules: a frozen leading line on intakes, never part of input identity."""
import contextlib
import hashlib
import io
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

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
        self.worker = Worker(self.peer, self.ledger, legacy_companions=True)
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
        for bad in ("relative.md", str(Path(self.temp.name) / "missing.md"), self.temp.name, 7):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                config_module.binding(binding_doc(1, instructions_path=bad), OWNER)
        self.assertNotIn("instructions_path", config_module.binding(binding_doc(1, instructions_path=str(good)), OWNER)["scope"])

    def test_size_never_invalidates_the_binding(self):
        large = Path(self.temp.name) / "large.md"
        large.write_bytes(b"x" * (instructions.SOFT_BYTES * 8))
        self.assertEqual(config_module.binding(binding_doc(1, instructions_path=str(large)), OWNER)["instructions_path"],
                         str(large))


class OversizeTests(RulesTests):
    def setUp(self):
        super().setUp()
        self.rules.write_bytes(b"rule\n" * (instructions.SOFT_BYTES // 5 + 10))
        self.size = self.rules.stat().st_size
        self.assertGreater(self.size, instructions.SOFT_BYTES)

    def alerts(self, err):
        return [l for l in err.getvalue().splitlines() if l.startswith("ALERT orkestr-v2-wa-adapter instructions_oversize")]

    def test_oversize_between_reloads_still_sends_the_line_and_warns(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            data, _ = self.inbound("wa-1")
            self.worker.step(data)
        self.assertTrue(self.sent()[0].startswith(expected(self.rules) + "\n\n"))
        self.assertIsNone(self.worker.instructions_error)
        self.assertEqual(self.worker.instructions_warning, {"code": "instructions_oversize", "bytes": self.size})
        self.assertEqual(len(self.alerts(err)), 1)
        self.assertIn("bytes=%d" % self.size, self.alerts(err)[0])

    def test_one_alert_per_file_per_day(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            for number in range(3):
                data, _ = self.inbound("wa-%d" % number)
                self.worker.step(data)
            self.assertEqual(len(self.alerts(err)), 1)
            with mock.patch("time.strftime", return_value="2099-01-01"):
                data, _ = self.inbound("wa-next-day")
                self.worker.step(data)
        self.assertEqual(len(self.alerts(err)), 2)

    def test_shrinking_the_file_clears_the_warning(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.worker.check_instructions()
        self.assertIsNotNone(self.worker.instructions_warning)
        self.rules.write_text("short\n")
        self.worker.check_instructions()
        self.assertIsNone(self.worker.instructions_warning)


class CostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "CHAT.md"
        instructions._cache.clear()

    def test_stat_and_load_never_read_the_file(self):
        self.path.write_bytes(b"x" * (instructions.SOFT_BYTES * 4))
        with mock.patch("os.fdopen", side_effect=AssertionError("read")), \
                mock.patch("hashlib.sha256", side_effect=AssertionError("hash")):
            self.assertEqual(instructions.stat_size(str(self.path)), instructions.SOFT_BYTES * 4)
            self.assertEqual(instructions.check_path(str(self.path)), str(self.path))
            worker = Worker(Peer(), Ledger(Path(self.temp.name) / "l.sqlite3", SCOPE))
            worker.instructions_path = str(self.path)
            worker.check_instructions()
        self.assertEqual(worker.instructions_warning["bytes"], instructions.SOFT_BYTES * 4)

    def test_hash_is_cached_until_the_file_changes(self):
        self.path.write_text("one\n")
        with self.settled():
            first = instructions.inspect(str(self.path))
        with mock.patch("os.fdopen", side_effect=AssertionError("read")):
            self.assertEqual(instructions.inspect(str(self.path)), first)
        self.path.write_text("two!\n")
        self.assertNotEqual(instructions.inspect(str(self.path))[0], first[0])

    def settled(self):
        """The clock moves on, so the file is older than the racily-clean window."""
        return mock.patch("time.time_ns", return_value=time.time_ns() + 10 ** 10)

    def test_a_fresh_file_is_not_cached_but_an_old_one_is(self):
        self.path.write_text("one\n")
        instructions.inspect(str(self.path))
        self.assertNotIn(str(self.path), instructions._cache)
        self.path.write_text("two\n")  # Same size, same tick: must be seen.
        self.assertEqual(instructions.inspect(str(self.path))[0], hashlib.sha256(b"two\n").hexdigest())
        with self.settled():
            instructions.inspect(str(self.path))
        self.assertIn(str(self.path), instructions._cache)

    def test_hash_read_stops_at_the_size_seen_at_fstat(self):
        self.path.write_bytes(b"a" * 1000)
        real = os.fstat

        def grow(fd):
            info = real(fd)
            with open(self.path, "ab") as handle:
                handle.write(b"b" * 5000)
            return info
        with mock.patch("os.fstat", side_effect=grow):
            version, size = instructions.inspect(str(self.path))
        self.assertEqual((version, size), (hashlib.sha256(b"a" * 1000).hexdigest(), 1000))

    def test_over_the_hard_bound_is_not_read_and_the_version_follows_the_stat(self):
        with open(self.path, "wb") as handle:
            handle.truncate(instructions.HARD_BYTES + 1)
        with mock.patch("os.fdopen", side_effect=AssertionError("read")):
            version, size = instructions.inspect(str(self.path))
            self.assertEqual(size, instructions.HARD_BYTES + 1)
            self.assertTrue(instructions.line(str(self.path)).startswith("[Chat rules v" + version[:12]))
        with open(self.path, "ab") as handle:
            handle.write(b"x")
        self.assertNotEqual(instructions.inspect(str(self.path))[0], version)

    def test_fifo_is_refused_without_blocking(self):
        fifo = Path(self.temp.name) / "fifo"
        os.mkfifo(fifo)
        for call in (instructions.stat_size, instructions.inspect):
            with self.assertRaisesRegex(ValueError, "instructions_not_regular"):
                call(str(fifo))

    def test_warning_clears_when_the_file_goes_away(self):
        self.path.write_bytes(b"x" * (instructions.SOFT_BYTES + 1))
        worker = Worker(Peer(), Ledger(Path(self.temp.name) / "l.sqlite3", SCOPE))
        worker.instructions_path = str(self.path)
        with contextlib.redirect_stderr(io.StringIO()):
            worker.check_instructions()
        self.assertIsNotNone(worker.instructions_warning)
        self.path.unlink()
        worker.check_instructions()
        self.assertIsNone(worker.instructions_warning)


class ReloadTests(Harness):
    def test_oversize_file_on_reload_keeps_the_binding_valid(self):
        rules = Path(self.temp.name) / "CHAT.md"
        rules.write_bytes(b"x" * (instructions.SOFT_BYTES + 1))
        self.write(binding_doc(1, instructions_path=str(rules)))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.registry.reload()
        binding = self.binding(1)
        self.assertIsNone(binding.error)
        self.assertEqual(binding.state, "enabled")
        self.assertEqual(self.registry.file_errors, {})
        health = self.request("GET", "/threads/%s/health" % self.remote(1))[1]
        self.assertTrue(health["enabled"])
        self.assertIsNone(health["instructionsError"])
        self.assertEqual(health["instructionsWarning"], {"code": "instructions_oversize", "bytes": instructions.SOFT_BYTES + 1})
        self.assertEqual(err.getvalue().count("ALERT orkestr-v2-wa-adapter instructions_oversize"), 1)
        with contextlib.redirect_stderr(err):
            self.registry.reload()
        self.assertEqual(err.getvalue().count("ALERT orkestr-v2-wa-adapter instructions_oversize"), 1)


class HealthTests(Harness):
    def test_health_reports_the_instructions_error(self):
        self.assertIsNone(self.request("GET", "/threads/%s/health" % self.remote(1))[1]["instructionsError"])
        self.binding(1).worker.instructions_error = "instructions_unreadable"
        health = self.request("GET", "/threads/%s/health" % self.remote(1))[1]
        self.assertEqual(health["instructionsError"], "instructions_unreadable")
        self.assertIsNone(health["instructionsWarning"])


if __name__ == "__main__":
    unittest.main()
