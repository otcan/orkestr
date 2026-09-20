"""Minimized systemd audit ledger and receipt-bound alert spool.

No service actions or network calls. Callers supply trusted journal records,
job receipts from a privileged controller, and an approved idempotent broker.
"""
import hashlib
import json
import os
import re
import sqlite3
from audit_paths import check_database_file, check_directory_chain, check_sidecars


TOKEN = re.compile(r"[A-Za-z0-9_.:@/-]{1,160}\Z")
BOOT = re.compile(r"[a-f0-9]{32}\Z")
ACTIONS = {"start", "stop", "restart", "reload", "try-restart"}


def token(value):
    return value if isinstance(value, str) and TOKEN.fullmatch(value) else None


def normalize_event(row, units):
    # UNIT/JOB_TYPE supplied by an application must never impersonate PID 1.
    if row.get("_PID") != "1" or row.get("_COMM") != "systemd":
        return None
    unit, action = row.get("UNIT"), row.get("JOB_TYPE")
    boot, job = row.get("_BOOT_ID"), row.get("JOB_ID", "")
    cursor, timestamp = row.get("__CURSOR"), row.get("__REALTIME_TIMESTAMP", "")
    if (not token(unit) or unit not in units or not isinstance(action, str) or action not in ACTIONS
            or not isinstance(boot, str) or not BOOT.fullmatch(boot)
            or not isinstance(job, str) or (job and not re.fullmatch(r"[0-9]{1,20}", job))
            or not isinstance(timestamp, str) or not re.fullmatch(r"[0-9]{1,20}", timestamp)
            or not isinstance(cursor, str) or not 0 < len(cursor) <= 1024
            or any(ord(c) < 32 for c in cursor)):
        return None
    identity = hashlib.sha256((boot + "\n" + cursor).encode()).hexdigest()
    # Never persist MESSAGE, environment, argv, descriptions, or caller extras.
    return {"event_id": identity, "boot_id": boot, "job_id": job,
            "unit": unit, "action": action, "realtime_us": int(timestamp),
            "result": row.get("JOB_RESULT") if isinstance(row.get("JOB_RESULT"), str) and row.get("JOB_RESULT") in
            {"done", "failed", "timeout", "canceled", "dependency", "skipped"} else "unknown"}


def exact_attribution(event, receipts):
    if not event.get("job_id"):
        return None  # Missing correlation evidence must alert, not disappear.
    matches = []
    for receipt in receipts:
        if (receipt.get("boot_id"), receipt.get("job_id"), receipt.get("unit")) != (
                event["boot_id"], event["job_id"], event["unit"]):
            continue
        action = receipt.get("action")
        compatible = {action} if isinstance(action, str) and action in ACTIONS else set()
        if isinstance(action, str) and action in {"restart", "try-restart"}:
            compatible |= {"start", "stop"}
        if event["action"] not in compatible or receipt.get("outcome") != "accepted":
            continue
        fields = {key: receipt.get(key) for key in ("operation_id", "principal", "change_ref", "source")}
        if all(token(value) for value in fields.values()):
            if fields not in matches:
                matches.append(fields)
    # Two controllers claiming the same exact job is ambiguous, not authorized.
    return matches[0] if len(matches) == 1 else None


class AuditStore:
    def __init__(self, directory, max_events=10000):
        self.directory = os.path.abspath(directory)
        check_directory_chain(self.directory, allow_missing=True)
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        check_directory_chain(self.directory)
        # A dedicated protected directory prevents database/WAL substitution.
        db_path = os.path.join(self.directory, "audit.sqlite3")
        fd = os.open(db_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            check_database_file(info)
        finally:
            os.close(fd)
        check_sidecars(db_path)
        self.db = sqlite3.connect(db_path, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.max_events = max_events
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL, attribution TEXT,
                created REAL NOT NULL, next_attempt REAL NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
                receipt TEXT, last_error TEXT);
            CREATE TABLE IF NOT EXISTS archived_events (
                id TEXT PRIMARY KEY, bundle_id TEXT NOT NULL);
        """)

    def close(self):
        self.db.close()

    def claim_kind(self, kind):
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO state VALUES('kind',?)", (kind,))
            actual = self.db.execute("SELECT value FROM state WHERE key='kind'").fetchone()[0]
            if actual != kind:
                raise ValueError("use separate state directories for different monitor kinds")

    def cursor(self):
        row = self.db.execute("SELECT value FROM state WHERE key='cursor'").fetchone()
        return row[0] if row else None

    def ingest(self, rows, units, now, grace_seconds=30):
        """Advance cursor and persist alert obligation together, never after send.

        Batch is bounded; caller must stop collection on any exception. Journal
        cursor loss must be reported, not silently restarted at 'now'.
        """
        if len(rows) > 2000:
            raise ValueError("journal batch exceeds bound")
        self.claim_kind("service-control")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            scope = json.dumps(sorted(units))
            self.db.execute("INSERT OR IGNORE INTO state VALUES('units',?)", (scope,))
            if self.db.execute("SELECT value FROM state WHERE key='units'").fetchone()[0] != scope:
                raise ValueError("journal scope changed; use a new reviewed state directory")
            for row in rows:
                cursor = row.get("__CURSOR")
                if (not isinstance(cursor, str) or not 0 < len(cursor) <= 1024
                        or any(ord(c) < 32 for c in cursor)):
                    raise ValueError("invalid journal cursor")
                event = normalize_event(row, units)
                if event:
                    exists = self.db.execute("SELECT 1 FROM events WHERE id=? UNION ALL SELECT 1 FROM archived_events WHERE id=?",
                                             (event["event_id"], event["event_id"])).fetchone()
                    if not exists:
                        count = self.db.execute("SELECT count(*) FROM events").fetchone()[0]
                        if count >= self.max_events:
                            raise RuntimeError("audit capacity reached; export retention evidence before pruning")
                        self.db.execute("INSERT INTO events(id,payload,created,next_attempt) VALUES(?,?,?,?)",
                                        (event["event_id"], json.dumps(event, sort_keys=True), now, now + grace_seconds))
                self.db.execute("INSERT OR REPLACE INTO state VALUES('cursor',?)", (cursor,))
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def reconcile(self, receipts):
        """Late exact job receipts can resolve prior records; timestamps cannot."""
        self.claim_kind("service-control")
        if len(receipts) > 10000:
            raise ValueError("receipt batch exceeds bound")
        with self.db:
            for row in self.db.execute("SELECT id,payload FROM events"):
                attribution = exact_attribution(json.loads(row["payload"]), receipts)
                # A caller supplies a complete retained receipt set, not deltas.
                self.db.execute("UPDATE events SET attribution=? WHERE id=?",
                                (json.dumps(attribution, sort_keys=True) if attribution else None, row["id"]))

    def dispatch(self, sender, now, limit=20):
        """sender(payload) must use event_id as a durable broker idempotency key.

        Commit the attempt before I/O. A timeout/crash retries the same identity,
        never a new message. Transport 'sent'/exit 0 is NOT a delivery receipt.
        Only an exact event-bound delivered receipt completes the obligation.
        """
        delivered = 0
        for _ in range(min(max(limit, 0), 100)):
            self.db.execute("BEGIN IMMEDIATE")
            row = self.db.execute("""SELECT * FROM events WHERE delivered=0 AND attribution IS NULL
                AND next_attempt<=? ORDER BY created,id LIMIT 1""", (now,)).fetchone()
            if not row:
                self.db.commit()
                break
            attempts = row["attempts"] + 1
            delay = min(300, 15 * (2 ** min(attempts, 5)))
            self.db.execute("UPDATE events SET attempts=?,next_attempt=?,last_error=? WHERE id=?",
                            (attempts, now + delay, "delivery_unconfirmed", row["id"]))
            self.db.commit()
            receipt = None
            error = "receipt_missing_or_mismatched"
            try:
                response = sender(json.loads(row["payload"]))
                if (isinstance(response, dict) and response.get("event_id") == row["id"]
                        and response.get("state") == "delivered" and token(response.get("receipt_id"))):
                    receipt = {"event_id": row["id"], "receipt_id": response["receipt_id"], "state": "delivered"}
            except Exception:
                # Never persist exception text, which may contain credentials.
                error = "transport_unconfirmed"
            with self.db:
                if receipt:
                    self.db.execute("UPDATE events SET delivered=1,receipt=?,last_error=NULL WHERE id=?",
                                    (json.dumps(receipt, sort_keys=True), row["id"]))
                    delivered += 1
                else:
                    self.db.execute("UPDATE events SET last_error=? WHERE id=? AND delivered=0", (error, row["id"]))
        return delivered

    def summary(self, now):
        rows = self.db.execute("""SELECT count(*) AS total,
            sum(attribution IS NOT NULL) AS attributed,
            sum(delivered=1) AS delivered,
            sum(delivered=0 AND attribution IS NULL) AS pending,
            min(CASE WHEN delivered=0 AND attribution IS NULL THEN created END) AS oldest
            FROM events""").fetchone()
        return {"total": rows["total"], "attributed": rows["attributed"] or 0,
                "delivered": rows["delivered"] or 0, "pending": rows["pending"] or 0,
                "oldest_pending_seconds": max(0, now - rows["oldest"]) if rows["oldest"] is not None else 0}
