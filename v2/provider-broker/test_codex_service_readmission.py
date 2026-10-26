"""Failed-open re-admission and Core generation gaps. Owned disposable ledgers only."""
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest

from codex_service.contract import Refused, canonical
from codex_service.ledger import Ledger
from test_codex_service_ledger import Clock, uid

# The released v2 shape: one admission per input and event, ever.
NARROW_V2 = """
CREATE TABLE service_scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, owner TEXT NOT NULL, conversation TEXT NOT NULL);
CREATE TABLE windows (id TEXT PRIMARY KEY, conversation TEXT NOT NULL, generation INTEGER NOT NULL, request_id TEXT NOT NULL, input_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','draining','expired','retired','reconciliation')), boot TEXT NOT NULL, created_wall_ns INTEGER NOT NULL, deadline_wall_ns INTEGER NOT NULL, deadline_mono_ns INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, reserved_bytes INTEGER NOT NULL DEFAULT 0, reason TEXT, outcome TEXT, run_id TEXT, terminal_event_id TEXT, UNIQUE(conversation,generation), UNIQUE(conversation,request_id));
CREATE TABLE reservations (id TEXT PRIMARY KEY, window_id TEXT NOT NULL REFERENCES windows(id), kind TEXT NOT NULL CHECK(kind IN ('attempt','bytes')), amount INTEGER NOT NULL CHECK(amount>0));
CREATE TABLE admissions (conversation TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, window_id TEXT NOT NULL REFERENCES windows(id), input_id TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL UNIQUE, PRIMARY KEY(conversation,request_id));
CREATE TABLE endpoints (name TEXT PRIMARY KEY, device INTEGER NOT NULL, inode INTEGER NOT NULL);
"""


class Readmission(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / "manager.sqlite3")
        self.owner, self.home = uid(), uid()
        self.clock = Clock()
        self.ledger = None
        self.addCleanup(lambda: self.ledger.close() if self.ledger else None)

    def open(self):
        self.ledger = Ledger(self.path, self.owner, self.home, clock=self.clock)
        return self.ledger

    def request(self, generation=1, predecessor=None, key=None, source=None, expected=None):
        now = self.clock.wall // 1_000_000
        message, event = source or (uid(), uid())
        return dict(version=1, operation="admit", owner_id=self.owner,
                    conversation_id=self.home, request_id=key or uid(), window_id=uid(),
                    generation=generation,
                    expected_generation=generation - 1 if expected is None else expected,
                    input_message_id=message, input_event_id=event, input_request_key=uid(),
                    predecessor_window_id=predecessor, opened_at_ms=now,
                    work_deadline_ms=now + 870000, expires_at_ms=now + 900000)

    def fail_open(self, request):
        """The opener lost its credential before any run: Core's failed open."""
        self.ledger.uncertain(request["window_id"], request["generation"], "runtime_refused")
        return self.ledger.reconcile({**{k: request[k] for k in ("owner_id", "conversation_id", "window_id", "generation")},
                                      "outcome": "failed", "run_id": None, "terminal_event_id": None})

    def test_failed_open_timer_input_is_admitted_again_under_its_retry_key(self):
        ledger = self.open()
        source = (uid(), uid())
        first = self.request(key="timer-window:" + source[1], source=source)
        self.assertTrue(ledger.admit(first)[1])
        self.fail_open(first)
        # The incident: the same key with a new window is an idempotency conflict.
        same_key = self.request(2, first["window_id"], first["request_id"], source)
        with self.assertRaisesRegex(Refused, "idempotency_conflict"):
            ledger.admit(same_key)
        retry = self.request(2, first["window_id"], first["request_id"] + ":retry1", source)
        receipt, fresh = ledger.admit(retry)
        self.assertTrue(fresh)
        self.assertEqual((receipt["generation"], receipt["state"]), (2, "active"))
        self.assertEqual(ledger.admit(retry), (receipt, False))
        # The input now belongs to a live window: no third copy, not even by join.
        for again in (self.request(3, retry["window_id"], uid(), source),
                      {**self.request(2, None, uid(), source, expected=2), "window_id": retry["window_id"],
                       "opened_at_ms": retry["opened_at_ms"], "work_deadline_ms": retry["work_deadline_ms"],
                       "expires_at_ms": retry["expires_at_ms"]}):
            with self.subTest(again=again["generation"]), self.assertRaisesRegex(Refused, "input_reused"):
                ledger.admit(again)
        # A second failed open leaves it admissible at the manager; Core alone
        # decides it is released and never re-queued.
        self.fail_open(retry)
        self.assertTrue(ledger.admit(self.request(3, retry["window_id"], uid(), source))[1])

    def test_only_a_runless_failed_retirement_releases_an_input(self):
        ledger = self.open()
        source = (uid(), uid())
        first = self.request(source=source)
        ledger.admit(first)
        ledger.uncertain(first["window_id"], 1, "cleanup_unknown")
        with self.assertRaisesRegex(Refused, "input_reused|previous_window_unretired"):
            ledger.admit(self.request(2, first["window_id"], source=source))
        scope = {k: first[k] for k in ("owner_id", "conversation_id", "window_id", "generation")}
        # A failed window naming its lapsed Deep turn ran something.
        ledger.reconcile({**scope, "outcome": "failed", "run_id": uid(), "terminal_event_id": uid()})
        with self.assertRaisesRegex(Refused, "input_reused"):
            ledger.admit(self.request(2, first["window_id"], source=source))
        # Mismatched pairing of a released input or event never passes either.
        other = self.request(2, first["window_id"])
        self.assertTrue(ledger.admit(other)[1])
        self.fail_open(other)
        for pair in ((other["input_message_id"], uid()), (uid(), other["input_event_id"])):
            with self.subTest(pair=pair), self.assertRaisesRegex(Refused, "input_reused"):
                ledger.admit(self.request(3, other["window_id"], source=pair))

    def test_successor_of_generations_core_closed_without_the_manager(self):
        ledger = self.open()
        first = self.request()
        ledger.admit(first)
        ledger.retire({**{k: first[k] for k in ("owner_id", "conversation_id", "window_id", "generation")},
                       "outcome": "accepted", "run_id": uid(), "terminal_event_id": uid()})
        unadmitted = uid()  # Core's generation 2, refused before manager admission.
        for bad, code in (({"predecessor_window_id": first["window_id"]}, "window_predecessor"),
                          ({"predecessor_window_id": None}, "window_predecessor"),
                          ({"generation": 4}, "window_generation")):
            with self.subTest(code=code, bad=bad), self.assertRaisesRegex(Refused, code):
                ledger.admit({**self.request(3, unadmitted, expected=2), **bad})
        receipt, fresh = ledger.admit(self.request(3, unadmitted, expected=2))
        self.assertTrue(fresh)
        self.assertEqual(receipt["generation"], 3)
        # Any gap still needs a retired latest window.
        with self.assertRaisesRegex(Refused, "previous_window_unretired"):
            ledger.admit(self.request(5, uid(), expected=4))
        with self.assertRaisesRegex(Refused, "window_generation"):
            ledger.admit(self.request(2, first["window_id"], expected=1))

    def narrow(self):
        db = sqlite3.connect(self.path)
        db.executescript(NARROW_V2)
        db.execute("INSERT INTO service_scope VALUES(1,2,?,?)", (self.owner, self.home))
        rows = []
        for generation in (1, 2):
            request = self.request(generation, rows[-1]["window_id"] if rows else None)
            fingerprint = hashlib.sha256(canonical(request)).hexdigest()
            db.execute("INSERT INTO windows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (request["window_id"], self.home, generation, request["request_id"],
                        request["input_message_id"], fingerprint, "retired", self.clock.boot,
                        self.clock.wall, self.clock.wall + 900_000_000_000,
                        self.clock.mono + 900_000_000_000, 1, 16384,
                        "runtime_refused", "failed", None, None))
            db.execute("INSERT INTO admissions VALUES(?,?,?,?,?,?)",
                       (self.home, request["request_id"], fingerprint, request["window_id"],
                        request["input_message_id"], request["input_event_id"]))
            db.execute("INSERT INTO reservations VALUES(?,?,?,?)", (uid(), request["window_id"], "bytes", 16384))
            rows.append(request)
        db.execute("INSERT INTO endpoints VALUES('control',123,456)")
        db.commit()
        before = {table: db.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
                  for table in ("windows", "admissions", "reservations", "endpoints")}
        db.close()
        return rows, before

    def test_released_v2_ledger_widens_in_place_and_stays_openable(self):
        rows, before = self.narrow()
        ledger = self.open()
        for table, old in before.items():
            self.assertEqual([tuple(r) for r in ledger.db.execute(f"SELECT * FROM {table} ORDER BY rowid")], old)
        # Version is unchanged: a rolled-back manager still opens this ledger.
        self.assertEqual(ledger.db.execute("SELECT version FROM service_scope").fetchone()[0], 2)
        self.assertFalse(ledger.db.execute("PRAGMA foreign_key_check").fetchall())
        self.assertEqual(ledger.admit(rows[1]), (ledger.status(), False))
        source = (rows[1]["input_message_id"], rows[1]["input_event_id"])
        self.assertTrue(ledger.admit(self.request(3, rows[1]["window_id"], uid(), source))[1])
        ledger.close()
        # Reopening is a no-op: no second rebuild, same rows.
        tables = ledger_tables(self.path)
        self.open()
        self.assertEqual(ledger_tables(self.path), tables)
        self.assertEqual(self.ledger.status()["generation"], 3)

    def test_rebuild_failure_rolls_back_to_the_untouched_v2_ledger(self):
        _rows, before = self.narrow()
        with sqlite3.connect(self.path) as db:
            # A dangling reservation makes the closing foreign key check refuse.
            db.execute("INSERT INTO reservations VALUES(?,?,?,?)", (uid(), uid(), "attempt", 1))
        with self.assertRaises((Refused, sqlite3.IntegrityError)):
            self.open()
        self.ledger = None
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("SELECT * FROM windows ORDER BY rowid").fetchall(), before["windows"])
            self.assertIn("input_id TEXT NOT NULL UNIQUE", db.execute(
                "SELECT sql FROM sqlite_master WHERE name='admissions'").fetchone()[0])


def ledger_tables(path):
    with sqlite3.connect(path) as db:
        return db.execute("SELECT name,sql FROM sqlite_master ORDER BY name").fetchall()


if __name__ == "__main__":
    unittest.main()
