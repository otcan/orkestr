"""Durable, single-chat input and reply ledger for the transitional V1 adapter."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import uuid


class Conflict(ValueError):
    pass


class Ledger:
    def __init__(self, path, scope):
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

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("PRAGMA synchronous=FULL")
        return db

    def enqueue(self, body):
        # Hash only immutable input identity/content; transport delivery metadata may vary.
        content = {k: body.get(k) for k in ("publicThreadId", "publicMessageId", "chatId", "accountId", "text", "externalId", "sourceEventId")}
        digest = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT digest,data FROM inputs WHERE public_id=?", (body["publicMessageId"],)).fetchone()
            if row:
                if row[0] != digest:
                    raise Conflict("input_identity_changed")
                return json.loads(row[1]), True
            pending = db.execute("SELECT count(*) FROM inputs").fetchone()[0]
            if pending >= 32:
                raise Conflict("pilot_capacity_reached")
            remote_id = str(uuid.uuid4())
            data = {"remote_id": remote_id, "public_id": body["publicMessageId"], "text": body["text"],
                    "public_thread_id": body.get("publicThreadId"), "chat_id": body.get("chatId"), "account_id": body.get("accountId"),
                    "phase": "queued", "keys": {k: str(uuid.uuid4()) for k in ("message", "window", "fast", "deep")}}
            db.execute("INSERT INTO inputs VALUES (?,?,?,?)", (body["publicMessageId"], digest, remote_id, json.dumps(data)))
            return data, False

    def save(self, data):
        with self.connect() as db:
            changed = db.execute("UPDATE inputs SET data=? WHERE remote_id=?", (json.dumps(data), data["remote_id"])).rowcount
            if changed != 1:
                raise ValueError("missing_input")

    def next_input(self):
        with self.connect() as db:
            row = db.execute("SELECT data FROM inputs WHERE json_extract(data,'$.phase') != 'completed' ORDER BY rowid LIMIT 1").fetchone()
        return json.loads(row[0]) if row else None

    def messages(self, limit=100):
        # V1 has a recent-list API, without a delivery cursor. Bound the pilot so
        # earlier unseen replies cannot silently fall out of the mirror's window.
        with self.connect() as db:
            rows = db.execute("SELECT data FROM inputs ORDER BY rowid DESC LIMIT ?", (limit,)).fetchall()
        messages = []
        for row in reversed(rows):
            data = json.loads(row[0])
            messages.append({"id": data["remote_id"], "role": "user", "text": data["text"],
                             "publicMessageId": data["public_id"], "publicThreadId": data["public_thread_id"],
                             "chatId": data["chat_id"], "accountId": data["account_id"],
                             "source": "whatsapp_inbound", "connector": "whatsapp",
                             "state": "delivered", "deliveryState": "delivered", "observedVia": "rust-pilot-ledger"})
            if data.get("reply"):
                messages.append(data["reply"])
        return messages
