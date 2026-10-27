"""Durable per-binding input, export and delivery-acknowledgement ledger.

One SQLite file belongs to exactly one binding scope. Exported replies stay
visible to V1 until V1 acknowledges their transport outcome; only then is the
input settled and its text pruned. Nothing here sends or replays a message.
"""
import hashlib
import json
import os
from pathlib import Path
from .layer_identity import IDENTITY_FIELDS, attach_scope, post_identity
import sqlite3
import sys
import time
import uuid

from .export_changes import ExportConnection
from .outbound_text import scrub_local_paths
from . import notices

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
# Deterministic IDs for timer digests (one pseudo timer input and one reply each).
DIGEST_NAMESPACE = uuid.UUID("9b1e6a44-3c2d-4f8a-8d57-0a6c1e4b7f32")
# Deterministic IDs for conversation posts (one pseudo timer input and one reply each).
POST_NAMESPACE = uuid.UUID("3e8a1d5c-7b24-4f69-8c0e-5a9d2b6f4c17")
POST_SOURCE_ID = "post"
# Deterministic IDs for web-UI owner messages mirrored to the group: one pseudo
# timer input for the message itself, one for its answer, one per progress note.
WEB_NAMESPACE = uuid.UUID("7c2e9b14-6d3a-4f8e-a1b5-9e0d4c7f2a68")
WEB_SOURCE_ID = "web"
WEB_LABEL = "\U0001f5a5\ufe0f (web)"


def watch_label(watch, kind):
    """Parent label of a web-watch export. A returned thread-ask answer's turn
    reads "↩ from <thread name>"; a web message keeps its web labels."""
    source = watch.get("thread_name")
    if watch.get("thread_ask") and source:
        return "\u21a9 from %s%s" % (source, " (progress)" if kind == "progress" else "")
    if kind == "progress":
        return "%s progress: %s" % (WEB_LABEL, watch["excerpt"])
    return "%s \u21a9 %s" % (WEB_LABEL, watch["excerpt"])
WEB_TEXT_LIMIT = 3500
WEB_EXCERPT_CHARS = 60
# Deterministic IDs for the owner notice that closes a refused input.
NOTICE_NAMESPACE = uuid.UUID("5d0c3f7e-8a41-4c2b-9e6d-1b7f2a9c4e83")
# Phases in which no Rust execution window was opened for the input yet.
NOT_STARTED = ("queued", "admitted", "waiting_for_window")
DEFAULT_MAX_INPUT_AGE_S = 30 * 60
# On owner-only bindings `max_outstanding_inputs` no longer refuses: an owner
# burst above it is accepted and queued (each message is admitted at once and
# still gets its own Fast reply; Deep runs in ledger order). Only this many
# unsettled chat inputs (Fast/timer/post pseudo rows excluded) refuse there,
# against real abuse or a V1 that never acknowledges. Other bindings keep the
# configured limit unchanged.
HARD_MAX_OUTSTANDING = 64
# Refusals that are never retried because the run may have acted already.
WITHHELD_REASONS = ("execution_requires_review", "continuation_admission_requires_review",
                    "continuation_lineage_unknown", "continuation_provider_changed")
RECENT_REFUSALS = 10
# V1-local input (see local_inputs.py); listed with its own source and connector.
LOCAL_KIND = "v1_local"
LOCAL_CONNECTOR = "orkestr-v1"
LOCAL_ROLES = ("v1_owner", "v1_agent", "v1_external")


def burst_compatible(head, row):
    """Whether `row` may join `head`'s turn: a plain chat input from the same
    chat, account and author that has not been sent to Rust or batched yet.
    Timer, digest and post rows, refused or re-sent inputs never join."""
    def author(value):
        value = value.get("author") or {}
        return value.get("role"), value.get("id")
    return (row.get("phase") == "queued" and "intake" not in row and "burst" not in row and
            not row.get("origin") and not row.get("digest") and not row.get("blocked") and
            not row.get("requeued") and not row.get("continued") and
            all(row.get(k) == head.get(k) for k in ("chat_id", "account_id", "public_thread_id")) and
            author(row) == author(head))


def refusal_notice(reason, lang="en", technical=True):
    return notices.refusal(lang, reason, technical)


# Appended to a refused turn's notice when owner messages were steered into it.
STEERED_REFUSAL_NOTE = notices.TEMPLATES["steered"]["en"].replace("%(count)d", "%d")


class Conflict(ValueError):
    pass


def arrived(data, default=None):
    """When an input arrived: queued for a WhatsApp input, admitted for a V2
    timer occurrence (which is never queued here)."""
    since = data.get("queued_at", data.get("admitted_at"))
    return since if isinstance(since, (int, float)) else default


def no_reply(text):
    return isinstance(text, str) and text.strip() == "NO_REPLY"


class Ledger:
    def __init__(self, path, scope, max_outstanding=32, on_export=None):
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
        self.on_export = on_export
        self.scope = dict(scope)
        self.max_outstanding = max_outstanding
        # Set by the registry from `fast_reply_policy`: the verified owner of an
        # owner-only chat gets technical notices, everyone else plain ones.
        self.owner_only = False
        # Set by the registry for every chat that is not owner-only: it never
        # sees server-local paths. The owner alone works with paths on this host.
        self.scrub_paths = False
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
            # Web-UI messages whose answer is still awaited; never listed to V1
            # and never in the serial input queue (see Worker.drive_web).
            db.execute("CREATE TABLE IF NOT EXISTS web_watch (message_id TEXT PRIMARY KEY, data TEXT NOT NULL)")
            from .fast_watch import initialize as initialize_fast_watch
            initialize_fast_watch(db)
            from .recovery import initialize as initialize_recovery
            initialize_recovery(db)
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
        db = sqlite3.connect(self.path, timeout=5, factory=ExportConnection)
        db.on_export = self.on_export
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
    @staticmethod
    def reply_to(value):
        """The quoted message V1 relayed with an input, as Rust's `reply_to`, or None.

        Bounded and shape-checked; anything else is dropped rather than guessed."""
        if not isinstance(value, dict):
            return None
        def text(key, size):
            item = value.get(key)
            return item.strip()[:size] if isinstance(item, str) and item.strip() else None
        result = {"message_id": text("messageId", 300), "author": text("author", 200), "sent_at": text("sentAt", 40),
                  "text": (value.get("text") or "").strip()[:500] if isinstance(value.get("text"), str) else "",
                  "is_own_reply": value.get("isOwnReply") is True, "unavailable": value.get("unavailable") is True}
        return result if result["message_id"] or result["text"] or result["unavailable"] else None

    def enqueue(self, body, author=None):
        """Record one verified input. `author` is the verified sender
        ({role, id, label, labelled, phone?}); it is kept with the input and
        shown to Rust and V1 as the message's author."""
        # Hash only immutable input identity/content; transport delivery metadata may vary.
        content = {k: body.get(k) for k in ("publicThreadId", "publicMessageId", "chatId", "accountId", "text", "externalId", "sourceEventId")}
        if body.get("attachments"):
            content["attachments"] = body["attachments"]
        if author and author.get("role") != "owner":
            # Owner rows keep their pre-participant digest; a participant row
            # also pins who wrote it, so another author cannot reuse its ID.
            content["author"] = author["id"]
        digest = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT digest,data FROM inputs WHERE public_id=?", (body["publicMessageId"],)).fetchone()
            if row:
                if row[0] != digest:
                    raise Conflict("input_identity_changed")
                return json.loads(row[1]), True
            outstanding = db.execute("SELECT count(*) FROM inputs WHERE json_extract(data,'$.settled') IS NULL").fetchone()[0]
            if not self.owner_only:
                # Serial (legacy) bindings keep the configured limit: queueing
                # past it there would only expire inputs after 30 minutes.
                if outstanding >= self.max_outstanding:
                    raise Conflict("binding_capacity_reached")
            else:
                chat = db.execute("SELECT count(*) FROM inputs WHERE json_extract(data,'$.settled') IS NULL "
                                  "AND json_extract(data,'$.origin') IS NULL").fetchone()[0]
                if chat >= max(HARD_MAX_OUTSTANDING, self.max_outstanding):
                    raise Conflict("binding_capacity_reached")
            attachments = self._attachments(db, body["publicMessageId"], body.get("attachments") or [])
            remote_id = str(uuid.uuid4())
            keys = ("message", "window", "fast", "deep") + (("attachments",) if attachments else ())
            data = {"remote_id": remote_id, "public_id": body["publicMessageId"], "text": body["text"],
                    "public_thread_id": body.get("publicThreadId"), "chat_id": body.get("chatId"), "account_id": body.get("accountId"),
                    "phase": "queued", "queued_at": time.time(), "keys": {k: str(uuid.uuid4()) for k in keys}}
            # Original arrival; never reset by a continuation or re-admission.
            data["arrived_at"] = data["queued_at"]
            if outstanding >= self.max_outstanding:
                # Over the soft capacity: accepted and queued, never refused.
                data["capacity_queued"] = {"outstanding": outstanding, "limit": self.max_outstanding}
            if attachments:
                data["attachments"] = attachments
            quoted = self.reply_to(body.get("replyTo"))
            if quoted:  # Not part of the digest: it is transport context, not identity.
                data["reply_to"] = quoted
            if author:
                data["author"] = {k: author[k] for k in ("role", "id", "label", "labelled", "phone", "source") if author.get(k) is not None}
            notices.remember(db, body.get("text"), (author or {}).get("role"))
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

    def enqueue_digest(self, record):
        """Adopt one digest Rust created: a pseudo timer input that is answered by
        the digest text itself, so it is exported and acknowledged like any reply.
        Idempotent by digest id."""
        digest_id = record["id"]
        digest = hashlib.sha256(json.dumps({k: record.get(k) for k in ("id", "namespace", "text")},
                                           sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        remote_id = str(uuid.uuid5(TIMER_NAMESPACE, "digest:" + digest_id))
        public_id = TIMER_PREFIX + remote_id
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT digest,data FROM inputs WHERE public_id=?", (public_id,)).fetchone()
            if row:
                if row[0] != digest:
                    raise Conflict("digest_identity_changed")
                return json.loads(row[1]), True
            data = {"remote_id": remote_id, "public_id": public_id, "origin": "timer", "text": "Scheduled digest",
                    "public_thread_id": self.scope.get("public_thread_id"), "chat_id": self.scope.get("chat_id"),
                    "account_id": self.scope.get("account_id"),
                    "timer": {"namespace": record["namespace"], "claim_id": None, "source_timer_id": "digest",
                              "label": "Digest", "due_ms": record.get("slot_ms")},
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "digest": {"id": digest_id, "text": record["text"]},
                    "phase": "digest_ready", "admitted_at": time.time(), "keys": {}}
            db.execute("INSERT INTO inputs VALUES (?,?,?,?)", (public_id, digest, remote_id, json.dumps(data)))
            return data, False

    def enqueue_post(self, record, identity=None):
        """Adopt one conversation post and export it at once as its own final reply.

        V1 accepts a listed parent only in the timer shape, so a post is a pseudo
        timer input (`origin: "timer"`, `v2timer-<uuid5>`) whose text is the
        post's label; the reply text is exactly the post text. Input and export
        are written in one transaction, so the post never waits behind a running
        input and a replay after a lost acknowledgement adopts nothing new.
        External posts preserve their own provider/model. Native questions may
        supply exact-run `identity`; neither path borrows conversation settings. Returns (reply, existed).
        """
        post_id = record["id"]
        if self.scrub_paths and isinstance(record.get("text"), str):
            record = dict(record, text=scrub_local_paths(record["text"]))
        digest = hashlib.sha256(json.dumps({k: record.get(k) for k in ("id", "author", "label", "text", "provider", "model")},
                                           sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        remote_id = str(uuid.uuid5(POST_NAMESPACE, "post:" + post_id))
        public_id = TIMER_PREFIX + remote_id
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT digest,data FROM inputs WHERE public_id=?", (public_id,)).fetchone()
            if row:
                if row[0] != digest:
                    raise Conflict("post_identity_changed")
                return json.loads(row[1]).get("reply"), True
            label = (record.get("label") or "Coordinator")[:TIMER_TEXT_LIMIT]
            reply = {"id": str(uuid.uuid5(POST_NAMESPACE, "reply:" + post_id)), "role": "assistant", "state": "completed",
                     "phase": "final_answer", "source": "rust-v2-pilot", "parentMessageId": remote_id, "text": record["text"]}
            reply.update(post_identity(db, record, identity))
            data = {"remote_id": remote_id, "public_id": public_id, "origin": "timer", "text": label,
                    "public_thread_id": self.scope.get("public_thread_id"), "chat_id": self.scope.get("chat_id"),
                    "account_id": self.scope.get("account_id"),
                    "timer": {"namespace": None, "claim_id": None, "source_timer_id": POST_SOURCE_ID,
                              "label": label, "due_ms": record.get("created_ms")},
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "post": {"id": post_id, "author": record.get("author")},
                    "phase": "completed", "admitted_at": time.time(), "keys": {}, "reply": reply}
            db.execute("INSERT INTO inputs VALUES (?,?,?,?)", (public_id, digest, remote_id, json.dumps(data)))
            self._export(db, data, "final", "final:" + remote_id, reply)
            return reply, False

    # Web-UI owner messages -------------------------------------------------
    def web_cursor(self):
        with self.connect() as db:
            row = db.execute("SELECT value FROM ledger_meta WHERE key='web_cursor'").fetchone()
        return int(row[0]) if row else None

    def set_web_cursor(self, sequence):
        with self.connect() as db:
            db.execute("INSERT INTO ledger_meta VALUES ('web_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (str(int(sequence)),))

    def own_message_ids(self):
        """Core message IDs this adapter itself admitted (every attempt of every
        input), so a WhatsApp or V1-local input is never mirrored back."""
        own = set()
        with self.connect() as db:
            for (raw,) in db.execute("SELECT data FROM inputs").fetchall():
                data = json.loads(raw)
                own.update(m for m in data.get("own_messages", []) if isinstance(m, str))
                for item in (data.get("intake"), data.get("requeued"), data.get("continued")):
                    if isinstance(item, dict):
                        own.update(v for k, v in item.items() if k in ("message_id", "previous_message_id") and isinstance(v, str))
        return own

    def _pseudo_timer(self, db, remote_id, label, created_ms, extra, reply, source_id=WEB_SOURCE_ID):
        """One completed pseudo timer input (V1's only parent shape for a reply
        without a WhatsApp input) and its final export, in the caller's transaction."""
        self.scrub(reply)
        data = {"remote_id": remote_id, "public_id": TIMER_PREFIX + remote_id, "origin": "timer", "text": label[:TIMER_TEXT_LIMIT],
                "public_thread_id": self.scope.get("public_thread_id"), "chat_id": self.scope.get("chat_id"),
                "account_id": self.scope.get("account_id"),
                "timer": {"namespace": None, "claim_id": None, "source_timer_id": source_id,
                          "label": label[:TIMER_TEXT_LIMIT], "due_ms": created_ms},
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "phase": "completed", "admitted_at": time.time(), "keys": {}, "reply": reply}
        data.update(extra)
        digest = hashlib.sha256(json.dumps({"web": remote_id}, sort_keys=True).encode()).hexdigest()
        if db.execute("INSERT OR IGNORE INTO inputs VALUES (?,?,?,?)",
                      (data["public_id"], digest, remote_id, json.dumps(data))).rowcount != 1:
            return False
        self._export(db, data, "final", "final:" + remote_id, reply)
        return True

    def enqueue_web(self, message, text, identity=None):
        """Mirror one web-UI owner message at once and start awaiting its answer.

        Written in one transaction and keyed by the Core message ID, so a replay
        after a restart adopts nothing new. Returns True when newly adopted."""
        message_id = message["message_id"]
        remote_id = str(uuid.uuid5(WEB_NAMESPACE, "mirror:" + message_id))
        reply = {"id": str(uuid.uuid5(WEB_NAMESPACE, "mirror-reply:" + message_id)), "role": "assistant",
                 "state": "completed", "phase": "final_answer", "source": "rust-v2-web-mirror",
                 "parentMessageId": remote_id, "text": text}
        reply.update({k: v for k, v in (identity or {}).items() if k in IDENTITY_FIELDS and v})
        excerpt = " ".join(text.split())
        excerpt = excerpt if len(excerpt) <= WEB_EXCERPT_CHARS else excerpt[:WEB_EXCERPT_CHARS].rstrip() + "\u2026"
        watch = {"message_id": message_id, "sequence": message["sequence"], "excerpt": excerpt,
                 "since": time.time(), "cursor": message["sequence"] - 1, "runs": [], "progress": []}
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            created = self._pseudo_timer(db, remote_id, WEB_LABEL, int(time.time() * 1000),
                                         {"web": {"message_id": message_id, "kind": "message"}}, reply)
            if created:
                db.execute("INSERT OR IGNORE INTO web_watch VALUES (?,?)", (message_id, json.dumps(watch)))
            return created

    def web_watches(self, limit=8):
        with self.connect() as db:
            rows = db.execute("SELECT data FROM web_watch ORDER BY rowid LIMIT ?", (limit,)).fetchall()
        return [json.loads(raw) for (raw,) in rows]

    def save_web_watch(self, watch):
        with self.connect() as db:
            db.execute("UPDATE web_watch SET data=? WHERE message_id=?", (json.dumps(watch), watch["message_id"]))

    def drop_web_watch(self, message_id):
        with self.connect() as db:
            db.execute("DELETE FROM web_watch WHERE message_id=?", (message_id,))

    def web_progress(self, watch, payload_id, text, identity=None):
        """One intermediate note of a web message's Deep run, as its own message."""
        message_id = watch["message_id"]
        remote_id = str(uuid.uuid5(WEB_NAMESPACE, "progress:%s:%s" % (message_id, payload_id)))
        reply = {"id": str(uuid.uuid5(WEB_NAMESPACE, "progress-reply:%s:%s" % (message_id, payload_id))),
                 "role": "assistant", "state": "completed", "phase": "final_answer", "source": "rust-v2-web-mirror",
                 "parentMessageId": remote_id, "text": text}
        reply.update({k: v for k, v in (identity or {}).items() if k in IDENTITY_FIELDS and v})
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._pseudo_timer(db, remote_id, watch_label(watch, "progress"), int(time.time() * 1000),
                               {"web": {"message_id": message_id, "kind": "progress"}}, reply)
            watch.setdefault("progress", []).append(payload_id)
            db.execute("UPDATE web_watch SET data=? WHERE message_id=?", (json.dumps(watch), message_id))

    def complete_web(self, watch, text, identity=None):
        """Export the accepted answer to a web message and stop awaiting it."""
        message_id = watch["message_id"]
        remote_id = str(uuid.uuid5(WEB_NAMESPACE, "answer:" + message_id))
        reply = {"id": str(uuid.uuid5(WEB_NAMESPACE, "answer-reply:" + message_id)), "role": "assistant",
                 "state": "completed", "phase": "final_answer", "source": "rust-v2-pilot",
                 "parentMessageId": remote_id, "text": text}
        reply.update({k: v for k, v in (identity or {}).items() if k in IDENTITY_FIELDS and v})
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._pseudo_timer(db, remote_id, watch_label(watch, "answer"), int(time.time() * 1000),
                               {"web": {"message_id": message_id, "kind": "answer"}}, reply)
            db.execute("DELETE FROM web_watch WHERE message_id=?", (message_id,))

    def finish_silently(self, data, outcome):
        """A timer occurrence that will never run (held/withdrawn by Core): nothing to export."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            data["phase"] = "completed"
            self._settle(db, data, outcome)

    def refuse(self, data, reason, alert=False, notice=None):
        """Close an input that will not get a reply, with a visible owner notice.

        The notice is exported as the input's final reply, so V1 delivers it
        like any other and its acknowledgement settles the input. Later inputs
        are no longer held behind it. Nothing is resent to Rust. With `alert`
        the input also keeps a terminal `stalled` marker (`failed` set), which
        the operator stall watch reports once although the input is completed.
        """
        reason = str(reason)[:200] or "refused"
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM inputs WHERE remote_id=?", (data["remote_id"],)).fetchone()
            if not row or json.loads(row[0]).get("phase") == "completed":
                return None
            lang = notices.language_for(db, data)
            # Never retried: the run may have acted, it needs human review, or
            # Core could not prove a deadline continuation resumes the same
            # native session.
            withheld = (bool(data.get("retry_withheld")) or bool(data.get("continued")) or
                        reason in WITHHELD_REASONS)
            message = {"id": str(uuid.uuid5(NOTICE_NAMESPACE, data["remote_id"])), "role": "assistant", "state": "completed",
                       "phase": "final_answer", "kind": "notice", "source": "rust-v2-adapter",
                       "parentMessageId": data["remote_id"], "refusal": reason,
                       "text": (notices.render(lang, "interrupted_owner", reason=reason)
                                if withheld and self.technical_audience(data) else
                                refusal_notice(reason, lang, self.technical_audience(data)))}
            if notice is not None:
                message.update({k: v for k, v in notice.items() if k in ("text", "provider", "model")})
                if notice.get("template") in notices.TEMPLATES:
                    message["text"] = notices.render(lang, notice["template"], **(notice.get("values") or {}))
                else:
                    message["text"] = notices.localize(lang, message["text"])
            elif data.get("origin") == "timer" and not data.get("post") and not data.get("digest"):
                # Nobody resends a timer: say what failed and what happens next.
                message["text"] = notices.render(lang, "timer_interrupted" if withheld else
                                                 "timer_failure", label=(data.get("timer") or {}).get("label")
                                                 or "Scheduled task", reason=reason)
            if data.get("steered"):
                # Messages steered into this turn settle with this notice; say so.
                message["text"] += notices.render(lang, "steered", count=len(data["steered"]))
            data["notice_language"] = lang  # Audit only; the export shape is unchanged.
            data.pop("blocked", None)
            if alert:
                now = time.time()
                data["stalled"] = {"at": now, "phase": data.get("phase"), "since": arrived(data, now), "failed": reason}
            data.update(phase="completed", refused={"reason": reason, "phase": data.get("phase"), "atMs": int(time.time() * 1000)})
            self.save(data, db)
            self._export(db, data, "final", "final:" + data["remote_id"], message)
        # Every visible chat failure reaches the operator, not only the chat
        # (timer refusals keep their own `input_failed` alert in the worker).
        if data.get("origin") != "timer":
            print("ALERT orkestr-v2-wa-adapter input_refused thread=%s input=%s reason=%s language=%s"
                % (self.scope.get("remote_thread_id", "?"), data["remote_id"], reason, lang), file=sys.stderr, flush=True)
        return message

    def technical_audience(self, data):
        """The owner (and timers, which are the owner's automation) get the
        technical notice; members of a shared chat get the short one."""
        if data.get("origin") == "timer":
            return True
        role = (data.get("author") or {}).get("role")
        # Rows without an author predate participants: the owner on owner-only
        # bindings, but possibly anyone in a legacy group, so the short notice.
        return role in ("owner", "v1_owner") or (role is None and self.owner_only)

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

    def burst_candidates(self, head, limit):
        """Inputs queued directly behind `head` that may join its turn, oldest first.

        The run stops at the first row that may not, so queue order is kept."""
        with self.connect() as db:
            rows = db.execute("SELECT data FROM inputs WHERE rowid > (SELECT rowid FROM inputs WHERE remote_id=?) AND "
                              "json_extract(data,'$.phase') != 'completed' ORDER BY rowid LIMIT ?",
                              (head["remote_id"], max(0, int(limit)))).fetchall()
        batch = []
        for (raw,) in rows:
            row = json.loads(raw)
            if not burst_compatible(head, row):
                break
            batch.append(row)
        return batch

    def absorb(self, head, rows):
        """Fold `rows` into `head` in one transaction: `head` carries their text
        to Rust and its one reply answers all of them. The absorbed rows leave
        the run queue now and settle together with `head`."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for row in rows:
                current = db.execute("SELECT data FROM inputs WHERE remote_id=?", (row["remote_id"],)).fetchone()
                if not current or not burst_compatible(head, json.loads(current[0])):
                    raise Conflict("burst_changed")
                row.update(phase="completed", absorbed_into=head["remote_id"])
                self.save(row, db)
            head["burst"] = [row["remote_id"] for row in rows]
            self.save(head, db)

    def input(self, remote_id):
        with self.connect() as db:
            row = db.execute("SELECT data FROM inputs WHERE remote_id=?", (remote_id,)).fetchone()
        return json.loads(row[0]) if row else None

    # Auto-steer: steer state transitions live in auto_steer_store.py.
    def begin_steer(self, row, record):
        from .auto_steer_store import begin
        return begin(self, row, record)

    def steered(self, row, head_id, audit):
        from .auto_steer_store import steered
        return steered(self, row, head_id, audit)

    def unsteer(self, row, reason, audit=None):
        from .auto_steer_store import unsteer
        return unsteer(self, row, reason, audit)

    def pending_inputs(self):
        """A bounded FIFO snapshot for independent owner intake/Fast work."""
        with self.connect() as db:
            rows = db.execute("SELECT data FROM inputs WHERE json_extract(data,'$.phase') != 'completed' "
                              "ORDER BY rowid LIMIT 64").fetchall()
        return [json.loads(row[0]) for row in rows]

    def next_input(self):
        with self.connect() as db:
            row = db.execute("SELECT data FROM inputs WHERE json_extract(data,'$.phase') != 'completed' ORDER BY rowid LIMIT 1").fetchone()
        return json.loads(row[0]) if row else None

    # Exports -----------------------------------------------------------
    def scrub(self, message):
        """Shared chats: replace server-local file references, in place, before
        the message is stored anywhere, so every replay carries the same text."""
        if self.scrub_paths and isinstance(message, dict) and isinstance(message.get("text"), str):
            message["text"] = scrub_local_paths(message["text"])
        return message

    def _export(self, db, data, kind, source_key, message):
        attach_scope(message, data)
        self.scrub(message)
        inserted = db.execute("INSERT OR IGNORE INTO exports(export_id,input_id,kind,source_key,message) VALUES (?,?,?,?,?)",
                              (message["id"], data["remote_id"], kind, source_key, json.dumps(message)))
        if inserted.rowcount:
            db.exported = True

    def complete(self, data, reply):
        """Atomically record the accepted final reply and make it visible to V1."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            from .first_response_store import final_ready
            if not final_ready(self, db, data):
                return False
            from .fast_watch_giveup import stamp_final
            self.scrub(reply)
            stamp_final(data, reply)
            data.update(reply=reply, phase="completed")
            self.save(data, db)
            self._export(db, data, "final", "final:" + data["remote_id"], reply)
            return True

    def continue_notice(self, data, text):
        """Save a re-queued input and tell the owner, in one transaction.

        Not bounded by the progress limit: an input continues at most once.
        """
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self.save(data, db)
            message = {"id": str(uuid.uuid5(NOTICE_NAMESPACE, "continued:" + data["remote_id"])),
                       "role": "assistant", "state": "completed", "phase": "commentary", "kind": "progress",
                       "source": "rust-v2-adapter", "parentMessageId": data["remote_id"],
                       "text": notices.localize(notices.language_for(db, data), text)}
            self._export(db, data, "progress", "continued:" + data["remote_id"], message)
            return message

    def add_progress(self, data, payload_id, text, identity=None):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self.save(data, db)
            count = db.execute("SELECT count(*) FROM exports WHERE input_id=? AND kind='progress' "
                               "AND source_key NOT LIKE 'stalled:%' AND source_key NOT LIKE 'heartbeat:%' "
                               "AND source_key NOT LIKE 'continued:%'", (data["remote_id"],)).fetchone()[0]
            if count >= PROGRESS_LIMIT:
                return None
            message = {"id": str(uuid.uuid4()), "role": "assistant", "state": "completed", "phase": "commentary",
                       "kind": "progress", "source": "rust-v2-adapter", "parentMessageId": data["remote_id"], "text": text}
            message.update({k: v for k, v in (identity or {}).items() if k in IDENTITY_FIELDS and v})
            self._export(db, data, "progress", "progress:%s:%s" % (data["remote_id"], payload_id), message)
            return message

    def add_first_response(self, data, payload_id, text, identity=None, quote=False):
        from .first_response_store import add
        return add(self, data, payload_id, text, identity, quote)

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
                    if (data.get("post") or {}).get("author"):
                        # V1 labels a post by its author (coordinator/operator/question), not as a timer.
                        rows[-1]["postAuthor"] = data["post"]["author"]
                    for seq, message in db.execute("SELECT seq,message FROM exports WHERE input_id=? AND (outcome IS NULL OR outcome='uncertain') "
                                                   "ORDER BY seq", (data["remote_id"],)).fetchall():
                        rows.append(dict(json.loads(message), exportSequence=seq))
                    continue
                author = data.get("author")
                local = bool(author) and author.get("role") in LOCAL_ROLES
                row = {"id": data["remote_id"], "role": "user", "text": data["text"],
                       "publicMessageId": data["public_id"], "publicThreadId": data["public_thread_id"],
                       "chatId": data["chat_id"], "accountId": data["account_id"],
                       "source": author["source"] if local else "whatsapp_inbound",
                       "connector": LOCAL_CONNECTOR if local else "whatsapp",
                       "state": "delivered", "deliveryState": "delivered", "observedVia": "rust-pilot-ledger"}
                if local:
                    row["origin"] = LOCAL_KIND
                if author:
                    row.update(authorId=author["id"], authorLabel=author["label"], authorRole=author["role"])
                rows.append(row)
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
        for key in ("text", "intake_text", "fast_payload", "deep_payload", "reply_to"):
            data.pop(key, None)
        if isinstance(data.get("reply"), dict):
            data["reply"].pop("text", None)
        if isinstance(data.get("first_response"), dict):
            data["first_response"].pop("echo", None)
        if isinstance(data.get("digest"), dict):
            data["digest"].pop("text", None)
        data["settled"] = {"outcome": outcome, "atMs": int(time.time() * 1000)}
        self.save(data, db)
        ids = [a["upload_id"] for a in data.get("attachments", [])]
        db.executemany("UPDATE uploads SET bytes=NULL WHERE upload_id=?", [(i,) for i in ids])
        # Inputs folded into this one were answered by its reply (or notice).
        for remote_id in list(data.get("burst") or ()) + list(data.get("steered") or ()):
            row = db.execute("SELECT data FROM inputs WHERE remote_id=?", (remote_id,)).fetchone()
            if row and not json.loads(row[0]).get("settled"):
                self._settle(db, json.loads(row[0]), outcome)

    def health(self):
        with self.connect() as db:
            outcomes = dict(db.execute("SELECT coalesce(outcome,'pending'),count(*) FROM exports GROUP BY 1").fetchall())
            outstanding = db.execute("SELECT count(*) FROM inputs WHERE json_extract(data,'$.settled') IS NULL").fetchone()[0]
            cursor = self._acked_through(db)
            refused = db.execute("SELECT count(*) FROM inputs WHERE json_extract(data,'$.refused') IS NOT NULL").fetchone()[0]
            stalled = db.execute("SELECT count(*) FROM inputs WHERE json_extract(data,'$.stalled') IS NOT NULL AND "
                                 "json_extract(data,'$.phase') != 'completed'").fetchone()[0]
            web = db.execute("SELECT count(*) FROM web_watch").fetchone()[0]
            recent = [json.loads(raw) for (raw,) in db.execute(
                "SELECT data FROM inputs WHERE json_extract(data,'$.refused') IS NOT NULL ORDER BY rowid DESC LIMIT ?",
                (RECENT_REFUSALS,)).fetchall()]
        current = self.next_input()
        return {"phase": current["phase"] if current else "idle", "blocked": bool(current and current.get("blocked")),
                "outstandingInputs": outstanding, "maxOutstandingInputs": self.max_outstanding, "ackedThrough": cursor,
                "pendingExports": outcomes.get("pending", 0), "uncertainDeliveries": outcomes.get("uncertain", 0),
                "failedDeliveries": outcomes.get("failed", 0), "revoked": self.revoked(),
                "refusedInputs": refused, "stalledInputs": stalled, "webAnswersAwaited": web,
                "hardMaxOutstandingInputs": max(HARD_MAX_OUTSTANDING, self.max_outstanding),
                "recentRefusals": [{"publicMessageId": d["public_id"], "reason": d["refused"]["reason"],
                                    "phase": d["refused"].get("phase"), "atMs": d["refused"]["atMs"],
                                    "settled": bool(d.get("settled"))} for d in recent]}
