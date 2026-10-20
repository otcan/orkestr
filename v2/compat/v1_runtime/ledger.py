"""Durable per-binding input, export and delivery-acknowledgement ledger.

One SQLite file belongs to exactly one binding scope. Exported replies stay
visible to V1 until V1 acknowledges their transport outcome; only then is the
input settled and its text pruned. Nothing here sends or replays a message.
"""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid

SCHEMA = "2"
# Terminal outcomes settle an export. "uncertain" is recorded but keeps it listed.
TERMINAL = ("delivered", "suppressed", "no_reply", "failed")
OUTCOMES = TERMINAL + ("uncertain",)
PROGRESS_LIMIT = 3
MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024
MAX_ATTACHMENTS = 8
MAX_STAGED_BYTES = 64 * 1024 * 1024
UPLOAD_NAMESPACE = uuid.UUID("6f2b8f2e-2f0e-4d55-9c7e-6a1f3d0b9a41")
# Deterministic route IDs for V2 timer occurrences, keyed by the Core message ID.
TIMER_NAMESPACE = uuid.UUID("0c6f7a52-5d8e-4b1f-9a3c-2e7d4b8f1a60")
TIMER_PREFIX = "v2timer-"
TIMER_SOURCE = "orkestr-v2-timer"
TIMER_TEXT_LIMIT = 500
# Deterministic IDs for the owner notice that closes a refused input.
NOTICE_NAMESPACE = uuid.UUID("5d0c3f7e-8a41-4c2b-9e6d-1b7f2a9c4e83")
# Phases in which no Rust execution window was opened for the input yet.
NOT_STARTED = ("queued", "admitted", "waiting_for_window")
DEFAULT_MAX_INPUT_AGE_S = 30 * 60
RECENT_REFUSALS = 10


def refusal_notice(reason):
    return ("Not accepted: %s. Orkestr V2 did not produce a reply to this message; "
            "send it again if it is still needed." % reason)


class Conflict(ValueError):
    pass


def no_reply(text):
    return isinstance(text, str) and text.strip() == "NO_REPLY"


class Ledger:
    def __init__(self, path, scope, max_outstanding=32):
        path = Path(path)
        if path.is_symlink() or not path.parent.is_dir():
            raise ValueError("ledger_path")
        if not path.exists():
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
        if path.stat().st_mode & 0o077 or path.stat().st_uid != os.geteuid():
            raise ValueError("ledger_permissions")
        if not isinstance(scope, dict) or not scope:
            raise ValueError("ledger_scope_required")
        self.path = str(path)
        self.scope = dict(scope)
        self.max_outstanding = max_outstanding
        identity = json.dumps({"schema": 1, "scope": scope}, sort_keys=True, separators=(",", ":"))
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("CREATE TABLE IF NOT EXISTS ledger_scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL)")
            existing = db.execute("SELECT identity FROM ledger_scope WHERE singleton=1").fetchone()
            if existing and existing[0] != identity:
                raise ValueError("ledger_scope_changed")
            if not existing:
                legacy = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='inputs'").fetchone()
                if legacy and db.execute("SELECT count(*) FROM inputs").fetchone()[0]:
                    raise ValueError("ledger_scope_missing")
                db.execute("INSERT INTO ledger_scope VALUES (1,?)", (identity,))
            db.execute("CREATE TABLE IF NOT EXISTS inputs (public_id TEXT PRIMARY KEY, digest TEXT NOT NULL, remote_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS exports (seq INTEGER PRIMARY KEY AUTOINCREMENT, export_id TEXT UNIQUE NOT NULL, "
                       "input_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('progress','final')), source_key TEXT UNIQUE NOT NULL, "
                       "message TEXT NOT NULL, outcome TEXT, ack TEXT)")
            db.execute("CREATE TABLE IF NOT EXISTS uploads (upload_id TEXT PRIMARY KEY, public_id TEXT NOT NULL, sha256 TEXT NOT NULL, "
                       "filename TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB, created_ms INTEGER NOT NULL)")
            version = db.execute("SELECT value FROM ledger_meta WHERE key='schema'").fetchone()
            if version is None:
                # Pilot ledgers (schema 1) kept the accepted reply inside the input row.
                # Re-export every such reply unacknowledged; V1 acknowledges from its own
                # delivery records, and its remote-ID dedupe prevents a second import.
                for remote_id, raw in db.execute("SELECT remote_id,data FROM inputs ORDER BY rowid").fetchall():
                    reply = json.loads(raw).get("reply")
                    if reply:
                        db.execute("INSERT INTO exports(export_id,input_id,kind,source_key,message) VALUES (?,?,?,?,?)",
                                   (reply["id"], remote_id, "final", "final:" + remote_id, json.dumps(reply)))
                db.execute("INSERT INTO ledger_meta VALUES ('schema',?)", (SCHEMA,))
            elif version[0] != SCHEMA:
                raise ValueError("ledger_schema_unsupported")

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("PRAGMA synchronous=FULL")
        return db

    # Binding lifecycle -------------------------------------------------
    def revoke(self):
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO ledger_meta VALUES ('revoked_ms',?)", (str(int(time.time() * 1000)),))

    def revoked(self):
        with self.connect() as db:
            return db.execute("SELECT 1 FROM ledger_meta WHERE key='revoked_ms'").fetchone() is not None

    # Attachments -------------------------------------------------------
    def stage_upload(self, public_id, filename, media_type, content, sha256):
        upload_id = str(uuid.uuid5(UPLOAD_NAMESPACE, "\n".join((public_id, sha256, filename, media_type))))
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT size FROM uploads WHERE upload_id=?", (upload_id,)).fetchone()
            if row:
                if row[0] != len(content):
                    raise Conflict("upload_identity_changed")
                return upload_id, True
            staged = db.execute("SELECT coalesce(sum(size),0) FROM uploads WHERE bytes IS NOT NULL").fetchone()[0]
            if staged + len(content) > MAX_STAGED_BYTES:
                raise Conflict("upload_capacity_reached")
            db.execute("INSERT INTO uploads VALUES (?,?,?,?,?,?,?,?)", (upload_id, public_id, sha256, filename, media_type,
                       len(content), sqlite3.Binary(content), int(time.time() * 1000)))
        return upload_id, False

    def upload_bytes(self, upload_id):
        with self.connect() as db:
            row = db.execute("SELECT bytes FROM uploads WHERE upload_id=?", (upload_id,)).fetchone()
        return bytes(row[0]) if row and row[0] is not None else None

    def release_uploads(self, upload_ids):
        with self.connect() as db:
            db.executemany("UPDATE uploads SET bytes=NULL WHERE upload_id=?", [(i,) for i in upload_ids])

    def _attachments(self, db, public_id, references):
        if not isinstance(references, list) or len(references) > MAX_ATTACHMENTS:
            raise Conflict("attachment_reference_invalid")
        result, total = [], 0
        for item in references:
            if not isinstance(item, dict) or set(item) != {"uploadId", "sha256"}:
                raise Conflict("attachment_reference_invalid")
            row = db.execute("SELECT upload_id,sha256,filename,media_type,size FROM uploads WHERE upload_id=? AND public_id=?",
                             (item["uploadId"], public_id)).fetchone()
            if not row or row[1] != item["sha256"] or any(r["upload_id"] == row[0] for r in result):
                raise Conflict("attachment_upload_missing")
            total += row[4]
            result.append(dict(zip(("upload_id", "sha256", "filename", "media_type", "size"), row)))
        if total > MAX_ATTACHMENT_BYTES:
            raise Conflict("attachment_too_large")
        return result

    # Intake ------------------------------------------------------------
    def enqueue(self, body):
        # Hash only immutable input identity/content; transport delivery metadata may vary.
        content = {k: body.get(k) for k in ("publicThreadId", "publicMessageId", "chatId", "accountId", "text", "externalId", "sourceEventId")}
        if body.get("attachments"):
            content["attachments"] = body["attachments"]
        digest = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT digest,data FROM inputs WHERE public_id=?", (body["publicMessageId"],)).fetchone()
            if row:
                if row[0] != digest:
                    raise Conflict("input_identity_changed")
                return json.loads(row[1]), True
            outstanding = db.execute("SELECT count(*) FROM inputs WHERE json_extract(data,'$.settled') IS NULL").fetchone()[0]
            if outstanding >= self.max_outstanding:
                raise Conflict("binding_capacity_reached")
            attachments = self._attachments(db, body["publicMessageId"], body.get("attachments") or [])
            remote_id = str(uuid.uuid4())
            keys = ("message", "window", "fast", "deep") + (("attachments",) if attachments else ())
            data = {"remote_id": remote_id, "public_id": body["publicMessageId"], "text": body["text"],
                    "public_thread_id": body.get("publicThreadId"), "chat_id": body.get("chatId"), "account_id": body.get("accountId"),
                    "phase": "queued", "queued_at": time.time(), "keys": {k: str(uuid.uuid4()) for k in keys}}
            if attachments:
                data["attachments"] = attachments
            db.execute("INSERT INTO inputs VALUES (?,?,?,?)", (body["publicMessageId"], digest, remote_id, json.dumps(data)))
            return data, False

    def enqueue_timer(self, record):
        """Adopt one V2 timer occurrence already admitted in this binding's conversation.

        The input exists in Core; this only records it so its accepted Deep reply is
        exported with a V1-materializable parent. Capacity never refuses it: refusing
        would strand an admitted input without a relay.
        """
        identity = {k: record[k] for k in ("message_id", "event_id", "sequence", "request_key", "namespace", "claim_id")}
        digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        remote_id = str(uuid.uuid5(TIMER_NAMESPACE, record["message_id"]))
        public_id = TIMER_PREFIX + remote_id
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT digest,data FROM inputs WHERE public_id=?", (public_id,)).fetchone()
            if row:
                if row[0] != digest:
                    raise Conflict("timer_identity_changed")
                return json.loads(row[1]), True
            label = record.get("label") or "Scheduled task"
            text = ("Scheduled timer: " + label)[:TIMER_TEXT_LIMIT]
            data = {"remote_id": remote_id, "public_id": public_id, "origin": "timer", "text": text,
                    "public_thread_id": self.scope.get("public_thread_id"), "chat_id": self.scope.get("chat_id"),
                    "account_id": self.scope.get("account_id"),
                    "timer": {k: record.get(k) for k in ("namespace", "claim_id", "source_timer_id", "label", "due_ms")},
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "intake": {"status": "accepted", "message_id": record["message_id"], "event_id": record["event_id"],
                               "sequence": record["sequence"]},
                    "cursor": record["sequence"] - 1, "phase": "admitted", "admitted_at": time.time(),
                    "keys": {"message": record["request_key"], "window": str(uuid.uuid4()),
                             "fast": str(uuid.uuid4()), "deep": str(uuid.uuid4())}}
            db.execute("INSERT INTO inputs VALUES (?,?,?,?)", (public_id, digest, remote_id, json.dumps(data)))
            return data, False

    def finish_silently(self, data, outcome):
        """A timer occurrence that will never run (held/withdrawn by Core): nothing to export."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            data["phase"] = "completed"
            self._settle(db, data, outcome)

    def refuse(self, data, reason):
        """Close an input that will not get a reply, with a visible owner notice.

        The notice is exported as the input's final reply, so V1 delivers it
        like any other and its acknowledgement settles the input. Later inputs
        are no longer held behind it. Nothing is resent to Rust.
        """
        reason = str(reason)[:200] or "refused"
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM inputs WHERE remote_id=?", (data["remote_id"],)).fetchone()
            if not row or json.loads(row[0]).get("phase") == "completed":
                return None
            message = {"id": str(uuid.uuid5(NOTICE_NAMESPACE, data["remote_id"])), "role": "assistant", "state": "completed",
                       "phase": "final_answer", "kind": "notice", "source": "rust-v2-adapter",
                       "parentMessageId": data["remote_id"], "refusal": reason, "text": refusal_notice(reason)}
            data.pop("blocked", None)
            data.update(phase="completed", refused={"reason": reason, "phase": data.get("phase"), "atMs": int(time.time() * 1000)})
            self.save(data, db)
            self._export(db, data, "final", "final:" + data["remote_id"], message)
            return message

    def expire_stale(self, max_age_s, now=None):
        """Refuse inputs that waited longer than max_age_s without a Rust window.

        Only inputs with no window opened (or a definite busy refusal) qualify:
        a window request whose outcome is unknown may be running and is left
        alone. V2 timer occurrences follow Core's own dispatch queue and never
        expire here. Returns the refused inputs.
        """
        now = time.time() if now is None else now
        expired = []
        with self.connect() as db:
            rows = db.execute("SELECT data FROM inputs WHERE json_extract(data,'$.phase') IN (%s) ORDER BY rowid"
                              % ",".join("?" * len(NOT_STARTED)), NOT_STARTED).fetchall()
        for (raw,) in rows:
            data = json.loads(raw)
            if data.get("origin") == "timer" or "window" in data or data.get("blocked"):
                continue
            if "window_request" in data and data.get("phase") != "waiting_for_window":
                continue
            since = data.get("queued_at", data.get("admitted_at"))
            if not isinstance(since, (int, float)):
                # Inputs from older ledgers start their clock now.
                data["queued_at"] = now
                self.save(data)
                continue
            if now - since > max_age_s and self.refuse(data, "input_expired"):
                expired.append(data)
        return expired

    def timer_cursor(self):
        with self.connect() as db:
            row = db.execute("SELECT value FROM ledger_meta WHERE key='timer_cursor'").fetchone()
        return int(row[0]) if row else None

    def set_timer_cursor(self, sequence):
        with self.connect() as db:
            db.execute("INSERT INTO ledger_meta VALUES ('timer_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (str(int(sequence)),))

    def save(self, data, db=None):
        if db is None:
            with self.connect() as db:
                return self.save(data, db)
        changed = db.execute("UPDATE inputs SET data=? WHERE remote_id=?", (json.dumps(data), data["remote_id"])).rowcount
        if changed != 1:
            raise ValueError("missing_input")

    def next_input(self):
        with self.connect() as db:
            row = db.execute("SELECT data FROM inputs WHERE json_extract(data,'$.phase') != 'completed' ORDER BY rowid LIMIT 1").fetchone()
        return json.loads(row[0]) if row else None

    # Exports -----------------------------------------------------------
    def _export(self, db, data, kind, source_key, message):
        db.execute("INSERT OR IGNORE INTO exports(export_id,input_id,kind,source_key,message) VALUES (?,?,?,?,?)",
                   (message["id"], data["remote_id"], kind, source_key, json.dumps(message)))

    def complete(self, data, reply):
        """Atomically record the accepted final reply and make it visible to V1."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            data.update(reply=reply, phase="completed")
            self.save(data, db)
            self._export(db, data, "final", "final:" + data["remote_id"], reply)

    def add_progress(self, data, payload_id, text):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self.save(data, db)
            count = db.execute("SELECT count(*) FROM exports WHERE input_id=? AND kind='progress'", (data["remote_id"],)).fetchone()[0]
            if count >= PROGRESS_LIMIT:
                return None
            message = {"id": str(uuid.uuid4()), "role": "assistant", "state": "completed", "phase": "commentary",
                       "kind": "progress", "source": "rust-v2-adapter", "parentMessageId": data["remote_id"], "text": text}
            self._export(db, data, "progress", "progress:%s:%s" % (data["remote_id"], payload_id), message)
            return message

    def _acked_through(self, db):
        pending = db.execute("SELECT min(seq) FROM exports WHERE outcome IS NULL OR outcome='uncertain'").fetchone()[0]
        if pending is not None:
            return pending - 1
        return db.execute("SELECT coalesce(max(seq),0) FROM exports").fetchone()[0]

    def listing(self, limit=100):
        """Oldest unsettled rows first, so an unseen reply never leaves V1's window."""
        rows = []
        with self.connect() as db:
            inputs = db.execute("SELECT data FROM inputs WHERE json_extract(data,'$.settled') IS NULL ORDER BY rowid").fetchall()
            for (raw,) in inputs:
                data = json.loads(raw)
                if data.get("origin") == "timer":
                    # V1 materializes exactly this shape as the reply's local parent.
                    timer = data.get("timer") or {}
                    rows.append({"id": data["remote_id"], "role": "user", "text": data["text"],
                                 "publicMessageId": data["public_id"], "publicThreadId": data["public_thread_id"],
                                 "chatId": data["chat_id"], "accountId": data["account_id"],
                                 "source": TIMER_SOURCE, "connector": TIMER_SOURCE, "origin": "timer",
                                 "timerNamespace": timer.get("namespace"), "timerSourceId": timer.get("source_timer_id"),
                                 "state": "delivered", "deliveryState": "delivered", "observedVia": "rust-pilot-ledger",
                                 "createdAt": data.get("created_at")})
                    for seq, message in db.execute("SELECT seq,message FROM exports WHERE input_id=? AND (outcome IS NULL OR outcome='uncertain') "
                                                   "ORDER BY seq", (data["remote_id"],)).fetchall():
                        rows.append(dict(json.loads(message), exportSequence=seq))
                    continue
                rows.append({"id": data["remote_id"], "role": "user", "text": data["text"],
                             "publicMessageId": data["public_id"], "publicThreadId": data["public_thread_id"],
                             "chatId": data["chat_id"], "accountId": data["account_id"],
                             "source": "whatsapp_inbound", "connector": "whatsapp",
                             "state": "delivered", "deliveryState": "delivered", "observedVia": "rust-pilot-ledger"})
                for seq, message in db.execute("SELECT seq,message FROM exports WHERE input_id=? AND (outcome IS NULL OR outcome='uncertain') "
                                               "ORDER BY seq", (data["remote_id"],)).fetchall():
                    rows.append(dict(json.loads(message), exportSequence=seq))
            cursor = self._acked_through(db)
        return {"messages": rows[:limit], "truncated": len(rows) > limit,
                "mirrorAck": {"version": 1, "ackedThrough": cursor, "outstandingInputs": len(inputs)}}

    def messages(self, limit=100):
        return self.listing(limit)["messages"]

    def acknowledge(self, export_id, ack):
        """Record V1's transport outcome for one export. Never triggers a send."""
        outcome = ack["outcome"]
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT seq,input_id,kind,message,outcome,ack FROM exports WHERE export_id=?", (export_id,)).fetchone()
            if not row:
                raise LookupError("unknown_export")
            seq, input_id, kind, message, current, _ = row
            message = json.loads(message)
            data = json.loads(db.execute("SELECT data FROM inputs WHERE remote_id=?", (input_id,)).fetchone()[0])
            if ack.get("parentPublicMessageId") != data["public_id"]:
                raise Conflict("ack_parent_mismatch")
            silent = bool(message.get("noReply"))
            if outcome == "no_reply" and not silent:
                raise Conflict("ack_outcome_mismatch")
            if outcome == "delivered" and silent:
                raise Conflict("no_reply_transported")
            if outcome == "delivered" and not ack.get("outboxJobId"):
                raise Conflict("ack_receipt_required")
            if current == outcome:
                return {"duplicate": True, "sequence": seq, "ackedThrough": self._acked_through(db)}
            # Late reports for progress retired by its final are recorded, not refused.
            if current is not None and current not in ("uncertain", "superseded"):
                raise Conflict("ack_conflict")
            record = dict(ack, ackedAtMs=int(time.time() * 1000))
            if current == "superseded":
                db.execute("UPDATE exports SET ack=? WHERE seq=?", (json.dumps(record), seq))
                return {"duplicate": False, "sequence": seq, "settled": False, "ackedThrough": self._acked_through(db)}
            db.execute("UPDATE exports SET outcome=?, ack=? WHERE seq=?", (outcome, json.dumps(record), seq))
            settled = kind == "final" and outcome in TERMINAL and not data.get("settled")
            if settled:
                self._settle(db, data, outcome)
            return {"duplicate": False, "sequence": seq, "settled": settled, "ackedThrough": self._acked_through(db)}

    def _settle(self, db, data, outcome):
        # Final transport is decided: retire any progress V1 has not reported
        # (V1 itself drops progress overtaken by a final) and prune content.
        db.execute("UPDATE exports SET outcome='superseded' WHERE input_id=? AND kind='progress' AND (outcome IS NULL OR outcome='uncertain')",
                   (data["remote_id"],))
        for seq, message in db.execute("SELECT seq,message FROM exports WHERE input_id=?", (data["remote_id"],)).fetchall():
            message = json.loads(message)
            message.pop("text", None)
            db.execute("UPDATE exports SET message=? WHERE seq=?", (json.dumps(dict(message, pruned=True)), seq))
        for key in ("text", "intake_text", "fast_payload", "deep_payload"):
            data.pop(key, None)
        if isinstance(data.get("reply"), dict):
            data["reply"].pop("text", None)
        data["settled"] = {"outcome": outcome, "atMs": int(time.time() * 1000)}
        self.save(data, db)
        ids = [a["upload_id"] for a in data.get("attachments", [])]
        db.executemany("UPDATE uploads SET bytes=NULL WHERE upload_id=?", [(i,) for i in ids])

    def health(self):
        with self.connect() as db:
            outcomes = dict(db.execute("SELECT coalesce(outcome,'pending'),count(*) FROM exports GROUP BY 1").fetchall())
            outstanding = db.execute("SELECT count(*) FROM inputs WHERE json_extract(data,'$.settled') IS NULL").fetchone()[0]
            cursor = self._acked_through(db)
            refused = db.execute("SELECT count(*) FROM inputs WHERE json_extract(data,'$.refused') IS NOT NULL").fetchone()[0]
            recent = [json.loads(raw) for (raw,) in db.execute(
                "SELECT data FROM inputs WHERE json_extract(data,'$.refused') IS NOT NULL ORDER BY rowid DESC LIMIT ?",
                (RECENT_REFUSALS,)).fetchall()]
        current = self.next_input()
        return {"phase": current["phase"] if current else "idle", "blocked": bool(current and current.get("blocked")),
                "outstandingInputs": outstanding, "maxOutstandingInputs": self.max_outstanding, "ackedThrough": cursor,
                "pendingExports": outcomes.get("pending", 0), "uncertainDeliveries": outcomes.get("uncertain", 0),
                "failedDeliveries": outcomes.get("failed", 0), "revoked": self.revoked(),
                "refusedInputs": refused,
                "recentRefusals": [{"publicMessageId": d["public_id"], "reason": d["refused"]["reason"],
                                    "phase": d["refused"].get("phase"), "atMs": d["refused"]["atMs"],
                                    "settled": bool(d.get("settled"))} for d in recent]}
