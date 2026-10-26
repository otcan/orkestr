"""Durable conservative egress reservations, independent from Core authority.

The manager is the sole writer. Restart never reopens an unfinished window.
SQLite FULL commits precede any admission/forwarding; lost credits are spent.
"""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
import time
import uuid

from .contract import (MAX_LIFETIME_SECONDS, CREDIT_BYTES, DRAIN_ATTEMPTS, DRAIN_BYTES, DRAIN_SECONDS,
                       LIFETIME_SECONDS, MAX_ATTEMPTS, MAX_BYTES, MAX_LIVE_WINDOWS,
                       RECONCILED_OUTCOMES, Refused, canonical, generation, identifier, require)


class ClockPoison(Refused):
    """Commit the loss of authority, then propagate refusal; never a write grant."""


class Clock:
    def __init__(self):
        self.boot = identifier(Path("/proc/sys/kernel/random/boot_id").read_text().strip())

    def sample(self):
        return self.boot, time.time_ns(), time.monotonic_ns()


WINDOWS = ("CREATE TABLE IF NOT EXISTS windows (id TEXT PRIMARY KEY, conversation TEXT NOT NULL, generation INTEGER NOT NULL, request_id TEXT NOT NULL, input_id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','draining','expired','retired','reconciliation')), boot TEXT NOT NULL, created_wall_ns INTEGER NOT NULL, deadline_wall_ns INTEGER NOT NULL, deadline_mono_ns INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, reserved_bytes INTEGER NOT NULL DEFAULT 0, reason TEXT, outcome TEXT, run_id TEXT, terminal_event_id TEXT, UNIQUE(conversation,generation), UNIQUE(conversation,request_id))")
RESERVATIONS = "CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, window_id TEXT NOT NULL REFERENCES windows(id), kind TEXT NOT NULL CHECK(kind IN ('attempt','bytes')), amount INTEGER NOT NULL CHECK(amount>0))"
# An input may be admitted again only after every earlier window holding it
# retired as a runless failed open (Ledger.admit); never twice into one window.
ADMISSIONS = "CREATE TABLE IF NOT EXISTS admissions (conversation TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, window_id TEXT NOT NULL REFERENCES windows(id), input_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(conversation,request_id), UNIQUE(window_id,input_id), UNIQUE(window_id,event_id))"
INDEXES = ("CREATE INDEX IF NOT EXISTS windows_input ON windows(input_id)",
           "CREATE INDEX IF NOT EXISTS admissions_input ON admissions(input_id)",
           "CREATE INDEX IF NOT EXISTS admissions_event ON admissions(event_id)")
WINDOW_COLUMNS = "id,generation,request_id,input_id,fingerprint,state,boot,created_wall_ns,deadline_wall_ns,deadline_mono_ns,attempts,reserved_bytes,reason,outcome,run_id,terminal_event_id"


def _single_unique(db, table, column):
    """Whether `table` still carries a one-column UNIQUE constraint on `column`."""
    for index in db.execute(f"PRAGMA index_list({table})").fetchall():
        if index[2] and [info[2] for info in db.execute(f"PRAGMA index_info({index[1]})")] == [column]:
            return True
    return False


def schema(db, owner, conversation):
    """Atomic closed-row migration. Existing IDs, counters and failures survive.

    Version 2 is kept for the widened shape (no single-column input/event
    uniqueness) so a rolled-back manager still opens the ledger; its own
    `input_reused` check then keeps refusing re-admission exactly as before.
    """
    db.execute("CREATE TABLE IF NOT EXISTS service_scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, owner TEXT NOT NULL, conversation TEXT NOT NULL)")
    db.execute("INSERT OR IGNORE INTO service_scope VALUES(1,2,?,?)", (owner, conversation))
    scope = db.execute("SELECT * FROM service_scope").fetchone()
    require(tuple(scope) in ((1, 1, owner, conversation), (1, 2, owner, conversation)), "ledger_scope")
    exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='windows'").fetchone()
    legacy = "v1" if scope[1] == 1 else "v2" if exists and (
        _single_unique(db, "windows", "input_id") or _single_unique(db, "admissions", "input_id")
        or _single_unique(db, "admissions", "event_id")) else None
    if legacy:
        # Rename the old dependents first. SQLite retargets their FKs when the
        # parent is renamed; none of these records are discarded or refunded.
        for name in ("reservations", "admissions", "windows"):
            db.execute(f"ALTER TABLE {name} RENAME TO legacy_{name}_{legacy}")
    for statement in (WINDOWS, RESERVATIONS, ADMISSIONS, *INDEXES):
        db.execute(statement)
    if legacy == "v1":
        db.execute(f"INSERT INTO windows(conversation,{WINDOW_COLUMNS}) SELECT ?,{WINDOW_COLUMNS} FROM legacy_windows_v1 ORDER BY generation", (conversation,))
        db.execute("INSERT INTO reservations SELECT * FROM legacy_reservations_v1")
        db.execute("INSERT INTO admissions SELECT ?,request_id,fingerprint,window_id,input_id,event_id FROM legacy_admissions_v1", (conversation,))
    elif legacy == "v2":
        # Same columns; rowid order kept so the physical history is unchanged.
        db.execute(f"INSERT INTO windows(conversation,{WINDOW_COLUMNS}) SELECT conversation,{WINDOW_COLUMNS} FROM legacy_windows_v2 ORDER BY rowid")
        db.execute("INSERT INTO reservations SELECT id,window_id,kind,amount FROM legacy_reservations_v2 ORDER BY rowid")
        db.execute("INSERT INTO admissions SELECT conversation,request_id,fingerprint,window_id,input_id,event_id FROM legacy_admissions_v2 ORDER BY rowid")
    if legacy:
        for name in ("reservations", "admissions", "windows"):
            db.execute(f"DROP TABLE legacy_{name}_{legacy}")
        db.execute("UPDATE service_scope SET version=2 WHERE singleton=1")
    require(not db.execute("PRAGMA foreign_key_check").fetchall(), "ledger_foreign_keys")


class Ledger:
    """Storage logic; production custody and singleton lock belong to Manager."""
    def __init__(self, path, owner, conversation, *, clock=None, live_windows=MAX_LIVE_WINDOWS):
        self.owner, self.conversation = identifier(owner), identifier(conversation)
        require(type(live_windows) is int and 0 < live_windows <= MAX_LIVE_WINDOWS, "live_window_bound")
        self.live_windows = live_windows
        self.clock = clock or Clock()
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, isolation_level=None, timeout=0.5, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA foreign_keys=ON")
        with self.transaction():
            schema(self.db, owner, conversation)
            self.db.execute("CREATE TABLE IF NOT EXISTS endpoints (name TEXT PRIMARY KEY, device INTEGER NOT NULL, inode INTEGER NOT NULL)")
            # A durable reservation without an independently retained process owner
            # is spent/uncertain even when no forwarding happened before the crash.
            self.db.execute("UPDATE windows SET state='reconciliation',reason='manager_restarted' WHERE state IN ('active','draining','expired')")
        self.last_clocks = {}

    @contextmanager
    def transaction(self):
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield
            except ClockPoison:
                # Clock rejection is irrevocable. Rolling this transition back
                # would let a subsequent clock correction resurrect authority.
                self.db.execute("COMMIT")
                raise
            except BaseException:
                self.db.execute("ROLLBACK")
                raise
            else:
                self.db.execute("COMMIT")

    def close(self):
        with self.lock:
            self.db.close()

    def endpoint(self, name):
        require(name in ("control", "egress"), "endpoint_name")
        with self.lock:
            row = self.db.execute("SELECT device,inode FROM endpoints WHERE name=?", (name,)).fetchone()
            return tuple(row) if row else None

    def set_endpoint(self, name, identity):
        self.endpoint(name)
        with self.transaction():
            self.db.execute("INSERT INTO endpoints VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET device=excluded.device,inode=excluded.inode", (name, *identity))

    def clear_endpoint(self, name, identity):
        self.endpoint(name)
        with self.transaction():
            self.db.execute("DELETE FROM endpoints WHERE name=? AND device=? AND inode=?", (name, *identity))

    def _latest(self, conversation=None):
        if conversation is None:
            return self.db.execute("SELECT * FROM windows ORDER BY rowid DESC LIMIT 1").fetchone()
        return self.db.execute("SELECT * FROM windows WHERE conversation=? ORDER BY generation DESC LIMIT 1", (identifier(conversation),)).fetchone()

    def _exact(self, window, selected_generation):
        identifier(window)
        generation(selected_generation)
        row = self.db.execute("SELECT * FROM windows WHERE id=?", (window,)).fetchone()
        require(row is not None and row["generation"] == selected_generation
                and self._latest(row["conversation"])["id"] == window,
                "window_generation")
        return row

    def _scope(self, request):
        require(request["owner_id"] == self.owner, "scope")
        identifier(request["conversation_id"])

    def _receipt(self, row, conversation=None):
        scope = {"owner_id": self.owner, "conversation_id": row["conversation"] if row else conversation or self.conversation}
        if row is None:
            return {**scope, "generation": 0, "state": "idle", "window_id": None}
        return {**scope, "generation": row["generation"], "window_id": row["id"], "state": row["state"],
                "attempts": row["attempts"], "reserved_bytes": row["reserved_bytes"],
                "boot_id": row["boot"], "opened_at_ms": row["created_wall_ns"] // 1_000_000,
                "work_deadline_ms": row["deadline_wall_ns"] // 1_000_000 - DRAIN_SECONDS * 1000,
                "expires_at_ms": row["deadline_wall_ns"] // 1_000_000,
                "limits": {"duration_ms": LIFETIME_SECONDS * 1000, "attempts": MAX_ATTEMPTS,
                           "bytes": MAX_BYTES, "cleanup_ms": DRAIN_SECONDS * 1000,
                           "cleanup_attempts": DRAIN_ATTEMPTS, "cleanup_bytes": DRAIN_BYTES},
                "reason": row["reason"], "outcome": row["outcome"],
                "run_id": row["run_id"], "terminal_event_id": row["terminal_event_id"]}

    def status(self, conversation=None):
        with self.lock:
            return self._receipt(self._latest(conversation), conversation)

    def unfinished(self):
        """Every window that still owns live custody, oldest first."""
        with self.lock:
            return [self._receipt(row) for row in self.db.execute(
                "SELECT * FROM windows WHERE state IN ('active','draining','expired') ORDER BY rowid")]

    def details(self, window, selected_generation):
        with self.lock:
            return dict(self._exact(window, selected_generation))

    def _clock(self, row):
        boot, wall, mono = self.clock.sample()
        # Monotonic opening = deadline_mono minus the (possibly extended) lifetime.
        previous = self.last_clocks.get(row["id"], (row["created_wall_ns"],
            row["deadline_mono_ns"] - (row["deadline_wall_ns"] - row["created_wall_ns"])))
        # Wall and monotonic clocks share a captured offset. Small scheduling/
        # clock-slew differences never extend either hard deadline. Discontinuity
        # or reversal loses authority permanently, including during late retire.
        skew = (wall - mono) - (row["deadline_wall_ns"] - row["deadline_mono_ns"])
        if not (boot == row["boot"] and wall >= previous[0] and mono >= previous[1]
                and abs(skew) <= 1_000_000_000):
            self.db.execute("UPDATE windows SET state='reconciliation',reason='clock_changed' WHERE id=?", (row["id"],))
            raise ClockPoison("window_clock")
        self.last_clocks[row["id"]] = (wall, mono)
        return boot, wall, mono

    def _live_clock(self, row):
        boot, wall, mono = self._clock(row)
        if wall >= row["deadline_wall_ns"] or mono >= row["deadline_mono_ns"]:
            self.db.execute("UPDATE windows SET state='expired',reason='hard_deadline' WHERE id=?", (row["id"],))
            raise ClockPoison("window_clock")
        return boot, wall, mono

    def admit(self, request):
        self._scope(request)
        # Only the authenticated fixed server may reach this method. The input is
        # already linked to its durable Core admission; this creates no dispatch.
        fingerprint = hashlib.sha256(canonical(request)).hexdigest()
        with self.transaction():
            boot, wall, mono = self.clock.sample()
            conversation = request["conversation_id"]
            old = self.db.execute("SELECT a.fingerprint,w.* FROM admissions a JOIN windows w ON w.id=a.window_id WHERE a.conversation=? AND a.request_id=?", (conversation, request["request_id"])).fetchone()
            if old is not None:
                require(old["fingerprint"] == fingerprint, "idempotency_conflict")
                # Historical replay is evidence only: Manager must never reopen it.
                return self._receipt(old), False
            latest = self._latest(conversation)
            previous = latest["generation"] if latest else 0
            # Core may have closed later generations that never reached this
            # manager (an opening refused before admission, closed by Core as
            # a failed open). Their successor names a predecessor unknown here.
            gap = request["expected_generation"] > previous
            require(request["expected_generation"] == previous or gap, "window_generation")
            self._require_fresh_input(request)
            if not gap and latest is not None and latest["id"] == request["window_id"]:
                require(latest["state"] == "active", "window_not_accepting_inputs")
                boot, wall, mono = self._live_clock(latest)
                require(request["generation"] == previous and latest["state"] == "active" and
                        request["predecessor_window_id"] is None and
                        request["opened_at_ms"] * 1_000_000 == latest["created_wall_ns"] and
                        request["expires_at_ms"] * 1_000_000 == latest["deadline_wall_ns"] and
                        wall < latest["deadline_wall_ns"] - DRAIN_SECONDS * 1_000_000_000 and
                        mono < latest["deadline_mono_ns"] - DRAIN_SECONDS * 1_000_000_000 and
                        latest["attempts"] < MAX_ATTEMPTS - DRAIN_ATTEMPTS and
                        latest["reserved_bytes"] < MAX_BYTES - DRAIN_BYTES,
                        "window_not_accepting_inputs")
                self._record_admission(request, fingerprint)
                return self._receipt(latest), False
            require(request["generation"] == request["expected_generation"] + 1, "window_generation")
            require(latest is None or latest["state"] == "retired", "previous_window_unretired")
            # Each window owns its own child set, relay pool and durable budget.
            # An uncertain/unfinished scope still blocks its own conversation
            # above; live custody across conversations is bounded here.
            # An expired window's custody was terminated at its hard deadline;
            # one stuck awaiting retirement never holds a live slot.
            live = self.db.execute("SELECT count(*) FROM windows WHERE state IN ('active','draining')").fetchone()[0]
            require(live < self.live_windows, "window_capacity")
            if gap:
                predecessor = request["predecessor_window_id"]
                require(predecessor is not None and self.db.execute(
                    "SELECT 1 FROM windows WHERE id=?", (predecessor,)).fetchone() is None,
                    "window_predecessor")
            else:
                require(request["predecessor_window_id"] == (latest["id"] if latest else None), "window_predecessor")
            require(self.db.execute("SELECT 1 FROM windows WHERE id=?", (request["window_id"],)).fetchone() is None,
                    "window_reused")
            opened = request["opened_at_ms"] * 1_000_000
            deadline = request["expires_at_ms"] * 1_000_000
            require(opened <= wall < deadline - DRAIN_SECONDS * 1_000_000_000 and
                    deadline - opened == LIFETIME_SECONDS * 1_000_000_000 and
                    request["work_deadline_ms"] == request["expires_at_ms"] - DRAIN_SECONDS * 1000,
                    "window_deadlines")
            self.db.execute("INSERT INTO windows(id,conversation,generation,request_id,input_id,fingerprint,state,boot,created_wall_ns,deadline_wall_ns,deadline_mono_ns) VALUES(?,?,?,?,?,?,'active',?,?,?,?)",
                (request["window_id"], conversation, request["generation"], request["request_id"], request["input_message_id"],
                 fingerprint, boot, opened, deadline, mono + deadline - wall))
            self._record_admission(request, fingerprint)
            return self._receipt(self._latest(conversation)), True

    def _require_fresh_input(self, request):
        """An input is admitted once, unless every earlier window holding it
        retired as a failed open that ran nothing (no run, no terminal event).
        Core then re-queues a timer occurrence under a new request key."""
        earlier = self.db.execute(
            "SELECT a.conversation,a.input_id,a.event_id,w.state,w.outcome,w.run_id,w.terminal_event_id FROM admissions a JOIN windows w ON w.id=a.window_id WHERE a.input_id=? OR a.event_id=?",
            (request["input_message_id"], request["input_event_id"])).fetchall()
        require(all(row["conversation"] == request["conversation_id"] and
                    row["input_id"] == request["input_message_id"] and
                    row["event_id"] == request["input_event_id"] and
                    row["state"] == "retired" and row["outcome"] == "failed" and
                    row["run_id"] is None and row["terminal_event_id"] is None
                    for row in earlier), "input_reused")

    def _record_admission(self, request, fingerprint):
        self.db.execute("INSERT INTO admissions VALUES(?,?,?,?,?,?)", (request["conversation_id"], request["request_id"], fingerprint,
            request["window_id"], request["input_message_id"], request["input_event_id"]))

    def tick(self, window, selected_generation):
        with self.transaction():
            row = self._exact(window, selected_generation)
            if row["state"] in ("retired", "reconciliation"):
                return self._receipt(row)
            _boot, wall, mono = self._clock(row)
            if row["state"] == "expired":
                return self._receipt(row)
            if wall >= row["deadline_wall_ns"] or mono >= row["deadline_mono_ns"]:
                self.db.execute("UPDATE windows SET state='expired',reason='hard_deadline' WHERE id=?", (window,))
            elif (wall >= row["deadline_wall_ns"] - DRAIN_SECONDS * 1_000_000_000 or
                  mono >= row["deadline_mono_ns"] - DRAIN_SECONDS * 1_000_000_000 or
                  row["attempts"] >= MAX_ATTEMPTS - DRAIN_ATTEMPTS or
                  row["reserved_bytes"] >= MAX_BYTES - DRAIN_BYTES):
                self.db.execute("UPDATE windows SET state='draining',reason=coalesce(reason,'shutdown_margin') WHERE id=?", (window,))
            return self._receipt(self._exact(window, selected_generation))

    def reserve(self, window, selected_generation, reservation, kind, amount):
        identifier(reservation)
        require(kind in ("attempt", "bytes"), "reservation_kind")
        require(type(amount) is int and (amount == 1 if kind == "attempt" else
                0 < amount <= CREDIT_BYTES), "reservation_amount")
        self.tick(window, selected_generation)
        with self.transaction():
            row = self._exact(window, selected_generation)
            require(row["state"] in ("active", "draining"), "window_closed")
            self._live_clock(row)  # Tick and lock acquisition are not one transaction.
            require(self.db.execute("SELECT 1 FROM reservations WHERE id=?", (reservation,)).fetchone() is None,
                    "reservation_replay")
            column, maximum = ("attempts", MAX_ATTEMPTS) if kind == "attempt" else ("reserved_bytes", MAX_BYTES)
            require(row[column] <= maximum - amount, "attempt_limit" if kind == "attempt" else "byte_limit")
            self.db.execute("INSERT INTO reservations VALUES(?,?,?,?)", (reservation, window, kind, amount))
            self.db.execute(f"UPDATE windows SET {column}={column}+? WHERE id=?", (amount, window))
            return row[column] + amount

    def extend(self, request):
        """The opener moves an active window's hard deadline later, keeping the
        captured wall/monotonic offset. Never shorter, never past the total
        lifetime ceiling, never once draining or expired. Equal is a replay."""
        self._scope(request)
        with self.transaction():
            row = self._exact(request["window_id"], request["generation"])
            require(row["conversation"] == request["conversation_id"], "scope")
            require(row["state"] == "active", "window_not_extendable")
            self._live_clock(row)
            target = request["expires_at_ms"] * 1_000_000
            current = row["deadline_wall_ns"]
            require(target >= current and
                    target - row["created_wall_ns"] <= MAX_LIFETIME_SECONDS * 1_000_000_000,
                    "window_extension")
            if target > current:
                delta = target - current
                self.db.execute("UPDATE windows SET deadline_wall_ns=?,deadline_mono_ns=deadline_mono_ns+? WHERE id=? AND deadline_wall_ns=?",
                                (target, delta, row["id"], current))
            return self._receipt(self._exact(request["window_id"], request["generation"]))

    def drain(self, window, selected_generation):
        with self.transaction():
            row = self._exact(window, selected_generation)
            require(row["state"] in ("active", "draining"), "window_closed")
            self.db.execute("UPDATE windows SET state='draining',reason=coalesce(reason,'runtime_drain') WHERE id=?", (window,))
            return self._receipt(self._exact(window, selected_generation))

    def uncertain(self, window, selected_generation, reason):
        require(reason in ("runtime_refused", "auth_revoked", "cleanup_unknown", "server_lost", "manager_stopped", "clock_changed"), "reason")
        with self.transaction():
            row = self._exact(window, selected_generation)
            require(row["state"] != "retired", "window_retired")
            self.db.execute("UPDATE windows SET reason=CASE WHEN state='reconciliation' THEN coalesce(reason,?) ELSE ? END,state='reconciliation' WHERE id=?", (reason, reason, window))
            return self._receipt(self._exact(window, selected_generation))

    def retire(self, request):
        self._scope(request)
        with self.transaction():
            row = self._exact(request["window_id"], request["generation"])
            require(row["conversation"] == request["conversation_id"], "scope")
            desired = (request["outcome"], request["run_id"], request["terminal_event_id"])
            if row["state"] == "retired":
                require(tuple(row[key] for key in ("outcome", "run_id", "terminal_event_id")) == desired,
                        "retirement_conflict")
                return self._receipt(row)
            require(row["state"] in ("active", "draining", "expired"), "window_reconciliation_required")
            self._clock(row)
            # Manager calls this only after its own relay/child checks AND the
            # exact trusted Runtime's committed Core terminal+retirement proof.
            self.db.execute("UPDATE windows SET state='retired',outcome=?,run_id=?,terminal_event_id=? WHERE id=?",
                            (*desired, request["window_id"]))
            return self._receipt(self._exact(request["window_id"], request["generation"]))

    def reconcile(self, request):
        """Retire a stranded window after Core committed its audited decision.

        Only for a window whose budget authority is already gone (expired or
        reconciliation). No clock is sampled: a reboot or clock change must not
        keep a dead window blocking every later admission. Original reason is
        kept; state only moves to retired, so no budget is ever re-granted.
        """
        self._scope(request)
        require(request["outcome"] in RECONCILED_OUTCOMES, "terminal_outcome")
        # Only a failed open names no run; every other outcome names exactly one.
        # A failed window may also name its lapsed last Deep turn.
        runless = request["run_id"] is None
        require((request["terminal_event_id"] is None) == runless, "terminal_run")
        require(not runless or request["outcome"] == "failed", "terminal_run")
        with self.transaction():
            row = self._exact(request["window_id"], request["generation"])
            require(row["conversation"] == request["conversation_id"], "scope")
            desired = (request["outcome"], request["run_id"], request["terminal_event_id"])
            if row["state"] == "retired":
                require(tuple(row[key] for key in ("outcome", "run_id", "terminal_event_id")) == desired,
                        "retirement_conflict")
                return self._receipt(row)
            require(row["state"] in ("reconciliation", "expired"), "window_not_stranded")
            self.db.execute("UPDATE windows SET state='retired',outcome=?,run_id=?,terminal_event_id=? WHERE id=?",
                            (*desired, request["window_id"]))
            return self._receipt(self._exact(request["window_id"], request["generation"]))
