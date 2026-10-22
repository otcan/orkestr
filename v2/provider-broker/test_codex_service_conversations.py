"""Owned disposable ledgers only: no server, native process or credentials."""
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest

from codex_service.contract import Refused, canonical
from codex_service.ledger import Ledger
from test_codex_service_ledger import Clock, uid


class Conversations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / "manager.sqlite3")
        self.owner, self.home, self.other = uid(), uid(), uid()
        self.clock = Clock()
        self.ledger = None
        self.addCleanup(lambda: self.ledger.close() if self.ledger else None)

    def open(self, **options):
        self.ledger = Ledger(self.path, self.owner, self.home, clock=self.clock, **options)
        return self.ledger

    def request(self, conversation, generation=1, predecessor=None, key="same-key"):
        now = self.clock.wall // 1_000_000
        return dict(version=1, operation="admit", owner_id=self.owner,
                    conversation_id=conversation, request_id=key, window_id=uid(),
                    generation=generation, expected_generation=generation - 1,
                    input_message_id=uid(), input_event_id=uid(), input_request_key=uid(),
                    predecessor_window_id=predecessor, opened_at_ms=now,
                    work_deadline_ms=now + 870000, expires_at_ms=now + 900000)

    def terminal(self, request):
        return {**request, "outcome": "accepted", "run_id": uid(), "terminal_event_id": uid()}

    def test_switch_preserves_scoped_lineage_spent_credits_and_replays(self):
        ledger = self.open(live_windows=1)
        a, b = self.request(self.home), self.request(self.other)
        ledger.admit(a)
        ledger.reserve(a["window_id"], 1, uid(), "bytes", 16384)
        with self.assertRaisesRegex(Refused, "window_capacity"):
            ledger.admit(b)
        terminal = self.terminal(a)
        old = ledger.retire(terminal)
        self.assertTrue(ledger.admit(b)[1])
        self.assertEqual(ledger.status(self.home), old)
        self.assertEqual(ledger.status(self.other)["generation"], 1)
        self.assertEqual(ledger.admit(a), (old, False))
        ledger.retire(self.terminal(b))
        successor = self.request(self.home, 2, a["window_id"], "home-second")
        ledger.admit(successor)
        self.assertEqual(ledger.status()["window_id"], successor["window_id"])
        self.assertEqual(ledger.db.execute("SELECT reserved_bytes FROM windows WHERE id=?",
                                          (a["window_id"],)).fetchone()[0], 16384)
        with self.assertRaisesRegex(Refused, "window_generation"):
            ledger.retire(terminal)

    def test_unreaped_window_blocks_only_its_own_conversation(self):
        ledger = self.open(live_windows=1)
        a = self.request(self.home)
        ledger.admit(a)
        ledger.uncertain(a["window_id"], 1, "cleanup_unknown")
        for request in (self.request(self.home), self.request(self.home, 2, a["window_id"], "next")):
            with self.assertRaises(Refused):
                ledger.admit(request)
        self.assertEqual(ledger.status(self.home)["reason"], "cleanup_unknown")
        # Its custody was terminated; it no longer holds a live slot.
        self.assertTrue(ledger.admit(self.request(self.other))[1])
        self.assertEqual(ledger.status(self.other)["state"], "active")
        self.assertEqual(ledger.status(self.home)["state"], "reconciliation")

    def test_concurrent_windows_keep_separate_budgets_up_to_capacity(self):
        third = uid()
        ledger = self.open(live_windows=2)
        a, b, c = self.request(self.home), self.request(self.other), self.request(third)
        self.assertTrue(ledger.admit(a)[1])
        self.assertTrue(ledger.admit(b)[1])
        with self.assertRaisesRegex(Refused, "window_capacity"):
            ledger.admit(c)
        ledger.reserve(a["window_id"], 1, uid(), "bytes", 16384)
        ledger.reserve(b["window_id"], 1, uid(), "attempt", 1)
        self.assertEqual((ledger.status(self.home)["reserved_bytes"], ledger.status(self.home)["attempts"]), (16384, 0))
        self.assertEqual((ledger.status(self.other)["reserved_bytes"], ledger.status(self.other)["attempts"]), (0, 1))
        self.assertEqual([row["window_id"] for row in ledger.unfinished()], [a["window_id"], b["window_id"]])
        # Follow-up admission into a live window never needs another slot.
        follow = {**a, "request_id": "follow", "input_message_id": uid(), "input_event_id": uid(),
                  "expected_generation": 1}
        self.assertFalse(ledger.admit(follow)[1])
        with self.assertRaisesRegex(Refused, "scope"):
            ledger.retire({**self.terminal(a), "conversation_id": self.other})
        ledger.retire(self.terminal(a))
        self.assertTrue(ledger.admit(c)[1])
        self.assertEqual(ledger.status(third)["state"], "active")

    def test_restart_reconciles_every_live_window_independently(self):
        ledger = self.open(live_windows=2)
        a, b = self.request(self.home), self.request(self.other)
        ledger.admit(a)
        ledger.admit(b)
        ledger.close()
        ledger = self.open(live_windows=2)
        for conversation in (self.home, self.other):
            receipt = ledger.status(conversation)
            self.assertEqual((receipt["state"], receipt["reason"]), ("reconciliation", "manager_restarted"))
        self.assertEqual(ledger.unfinished(), [])
        with self.assertRaisesRegex(Refused, "previous_window_unretired"):
            ledger.admit(self.request(self.other, 2, b["window_id"], "after-restart"))
        self.assertTrue(ledger.admit(self.request(uid()))[1])

    def test_expired_window_awaiting_retirement_holds_no_slot(self):
        ledger = self.open(live_windows=1)
        a = self.request(self.home)
        ledger.admit(a)
        self.clock.advance(901)
        self.assertEqual(ledger.tick(a["window_id"], 1)["state"], "expired")
        # Still unretired for its own conversation, but no longer live custody.
        with self.assertRaisesRegex(Refused, "previous_window_unretired"):
            ledger.admit(self.request(self.home, 2, a["window_id"], "next"))
        self.assertTrue(ledger.admit(self.request(self.other))[1])

    def test_live_window_bound_is_closed(self):
        for value in (0, 73, True, "2", None):
            with self.subTest(value=value), self.assertRaisesRegex(Refused, "live_window_bound"):
                Ledger(self.path, self.owner, self.home, clock=self.clock, live_windows=value)

    def test_foreign_retirement_and_cross_conversation_input_reuse_refuse(self):
        ledger = self.open()
        a = self.request(self.home)
        ledger.admit(a)
        terminal = self.terminal(a)
        with self.assertRaisesRegex(Refused, "scope"):
            ledger.retire({**terminal, "conversation_id": self.other})
        ledger.retire(terminal)
        b = self.request(self.other)
        for key in ("input_message_id", "input_event_id"):
            with self.assertRaisesRegex(Refused, "input_reused"):
                ledger.admit({**b, key: a[key]})

    def legacy(self, state="retired"):
        # Exact v1 storage shape retained from the released manager, not a v2
        # ledger relabelled as legacy. Synthetic IDs, clocks and digests only.
        db = sqlite3.connect(self.path)
        db.executescript("""
        CREATE TABLE service_scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, owner TEXT NOT NULL, conversation TEXT NOT NULL);
        CREATE TABLE windows (id TEXT PRIMARY KEY, generation INTEGER NOT NULL UNIQUE, request_id TEXT NOT NULL UNIQUE, input_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','draining','expired','retired','reconciliation')), boot TEXT NOT NULL, created_wall_ns INTEGER NOT NULL, deadline_wall_ns INTEGER NOT NULL, deadline_mono_ns INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, reserved_bytes INTEGER NOT NULL DEFAULT 0, reason TEXT, outcome TEXT, run_id TEXT, terminal_event_id TEXT);
        CREATE TABLE reservations (id TEXT PRIMARY KEY, window_id TEXT NOT NULL REFERENCES windows(id), kind TEXT NOT NULL CHECK(kind IN ('attempt','bytes')), amount INTEGER NOT NULL CHECK(amount>0));
        CREATE TABLE admissions (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, window_id TEXT NOT NULL REFERENCES windows(id), input_id TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL UNIQUE);
        CREATE TABLE endpoints (name TEXT PRIMARY KEY, device INTEGER NOT NULL, inode INTEGER NOT NULL);
        """)
        request = self.request(self.home)
        fingerprint = hashlib.sha256(canonical(request)).hexdigest()
        terminal = self.terminal(request)
        db.execute("INSERT INTO service_scope VALUES(1,1,?,?)", (self.owner, self.home))
        db.execute("INSERT INTO windows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (request["window_id"], 1, request["request_id"], request["input_message_id"],
                    fingerprint, state, self.clock.boot, self.clock.wall,
                    self.clock.wall + 900_000_000_000, self.clock.mono + 900_000_000_000,
                    1, 16384, "cleanup_unknown" if state == "reconciliation" else None,
                    "accepted" if state == "retired" else None,
                    terminal["run_id"] if state == "retired" else None,
                    terminal["terminal_event_id"] if state == "retired" else None))
        db.execute("INSERT INTO admissions VALUES(?,?,?,?,?)", (request["request_id"], fingerprint,
                   request["window_id"], request["input_message_id"], request["input_event_id"]))
        db.executemany("INSERT INTO reservations VALUES(?,?,?,?)", [
            (uid(), request["window_id"], "attempt", 1),
            (uid(), request["window_id"], "bytes", 16384)])
        db.execute("INSERT INTO endpoints VALUES('control',123,456)")
        db.commit()
        before = {table: db.execute(f"SELECT * FROM {table}").fetchall()
                  for table in ("windows", "admissions", "reservations", "endpoints")}
        db.close()
        return request, before

    def test_actual_v1_rows_upgrade_once_without_identity_or_budget_reset(self):
        request, before = self.legacy()
        ledger = self.open()
        self.assertEqual(ledger.db.execute("SELECT version FROM service_scope").fetchone()[0], 2)
        windows = [tuple(row)[0:1] + tuple(row)[2:] for row in ledger.db.execute("SELECT * FROM windows")]
        self.assertEqual(windows, before["windows"])
        self.assertEqual([tuple(row)[1:] for row in ledger.db.execute("SELECT * FROM admissions")], before["admissions"])
        for table in ("reservations", "endpoints"):
            self.assertEqual([tuple(row) for row in ledger.db.execute(f"SELECT * FROM {table}")], before[table])
        self.assertEqual(ledger.admit(request)[1], False)
        ledger.close()
        self.open()
        self.assertEqual(self.ledger.status(self.home)["reserved_bytes"], 16384)
        self.assertTrue(self.ledger.admit(self.request(self.other))[1])
        self.assertFalse(self.ledger.db.execute("PRAGMA foreign_key_check").fetchall())

    def test_legacy_unfinished_and_uncertain_rows_never_reopen_on_upgrade(self):
        for state in ("active", "draining", "expired", "reconciliation"):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as directory:
                self.path = str(Path(directory) / "legacy.sqlite3")
                self.legacy(state)
                ledger = self.open()
                try:
                    receipt = ledger.status(self.home)
                    self.assertEqual(receipt["state"], "reconciliation")
                    self.assertEqual(receipt["reason"], "cleanup_unknown" if state == "reconciliation" else "manager_restarted")
                    self.assertEqual((receipt["attempts"], receipt["reserved_bytes"]), (1, 16384))
                    with self.assertRaisesRegex(Refused, "previous_window_unretired"):
                        ledger.admit(self.request(self.home, 2, receipt["window_id"], "next"))
                    # The upgraded uncertain row holds no live custody elsewhere.
                    self.assertTrue(ledger.admit(self.request(self.other))[1])
                finally:
                    ledger.close()
                    self.ledger = None

    def test_wrong_default_scope_refuses_without_migrating_legacy(self):
        self.legacy()
        with self.assertRaisesRegex(Refused, "ledger_scope"):
            Ledger(self.path, self.owner, self.other, clock=self.clock)
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("SELECT version FROM service_scope").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM windows").fetchone()[0], 1)

    def test_legacy_physical_order_does_not_change_latest_generation(self):
        self.legacy()
        with sqlite3.connect(self.path) as db:
            first = list(db.execute("SELECT * FROM windows").fetchone())
            second = first.copy()
            second[0:4] = [uid(), 2, "later-generation", uid()]
            db.execute("DELETE FROM windows")
            # Deliberately opposite physical order to the v1 generation order.
            db.executemany("INSERT INTO windows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                           [second, first])
        ledger = self.open()
        self.assertEqual(ledger.status()["window_id"], second[0])
        self.assertEqual(ledger.status()["generation"], 2)
        self.assertFalse(ledger.db.execute("PRAGMA foreign_key_check").fetchall())


if __name__ == "__main__":
    unittest.main()
