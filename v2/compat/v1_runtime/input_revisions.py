"""The owner's edits and deletions made in WhatsApp, forwarded to Core.

V1 reports each change once it has proved the owner made it. The change is
kept here durably and stepped by the binding's worker, so it never blocks input
and a Core outage only delays it. Core enforces whose message it is; this file
only refuses what it can already see is not the owner's own input.
"""
import hashlib
import json
import re
import sys
import time

from .participants import OWNER

FEATURE = "message_revisions_v1"
KINDS = ("edit", "delete")
BATCH = 8
TEXT_MAX = 28672
# A change whose input never reached Core stops being retried after this long.
MAX_AGE_S = 24 * 3600
REVISION_ID = re.compile(r"^[A-Za-z0-9:._@-]{1,300}$")
SETTLED = ("message_revision_unchanged", "message_deleted")


def initialize(db):
    db.execute("CREATE TABLE IF NOT EXISTS input_revisions (revision_id TEXT PRIMARY KEY, public_id TEXT NOT NULL, "
               "digest TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', outcome TEXT)")


def valid(body):
    """The change a body describes, or ValueError."""
    kind, text = body.get("kind"), body.get("text")
    revision_id, public_id = body.get("revisionId"), body.get("publicMessageId")
    if (not isinstance(revision_id, str) or not REVISION_ID.match(revision_id) or
            not isinstance(public_id, str) or not 1 <= len(public_id) <= 256 or kind not in KINDS):
        raise ValueError("invalid_revision")
    if kind == "edit":
        if not isinstance(text, str) or not text.strip() or len(text.encode()) > TEXT_MAX:
            raise ValueError("invalid_revision")
    elif text is not None:
        raise ValueError("invalid_revision")
    return {"revision_id": revision_id, "public_id": public_id, "kind": kind, "text": text, "received_at": time.time()}


def accept(ledger, body, conflict):
    """Keep one change durably. Returns True when it was already known."""
    record = valid(body)
    digest = hashlib.sha256(json.dumps([record["public_id"], record["kind"], record["text"]]).encode()).hexdigest()
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT data FROM inputs WHERE public_id=?", (record["public_id"],)).fetchone()
        if row is None:
            raise LookupError("unknown_input")
        if (json.loads(row[0]).get("author") or {}).get("role") != OWNER:
            raise conflict("not_owner_input")
        known = db.execute("SELECT digest FROM input_revisions WHERE revision_id=?", (record["revision_id"],)).fetchone()
        if known:
            if known[0] != digest:
                raise conflict("revision_conflict")
            return True
        db.execute("INSERT INTO input_revisions(revision_id,public_id,digest,data) VALUES (?,?,?,?)",
                   (record["revision_id"], record["public_id"], digest, json.dumps(record)))
    return False


def pending(ledger, limit=BATCH):
    with ledger.connect() as db:
        rows = db.execute("SELECT data FROM input_revisions WHERE state='pending' ORDER BY rowid LIMIT ?", (limit,)).fetchall()
    return [json.loads(raw) for (raw,) in rows]


def settle(ledger, record, state, outcome):
    with ledger.connect() as db:
        db.execute("UPDATE input_revisions SET state=?,outcome=? WHERE revision_id=? AND state='pending'",
                   (state, outcome, record["revision_id"]))


def request_key(record):
    """Stable across retries, so Core applies a change at most once."""
    return "whatsapp-revision:" + hashlib.sha256(record["revision_id"].encode()).hexdigest()[:48]


def input_for(ledger, public_id):
    with ledger.connect() as db:
        row = db.execute("SELECT data FROM inputs WHERE public_id=?", (public_id,)).fetchone()
    return json.loads(row[0]) if row else None


def merged(data):
    """A burst was admitted to Core as one message, so one part has no row of its own."""
    return bool(data.get("absorbed_into") or data.get("burst"))


def _head(ledger, data):
    """The admitted head of the burst an input was absorbed into."""
    with ledger.connect() as db:
        row = db.execute("SELECT data FROM inputs WHERE remote_id=?", (data["absorbed_into"],)).fetchone()
    return json.loads(row[0]) if row else None


def supported(client):
    features = getattr(client, "features", None)
    if features is None:
        return False
    if not features and hasattr(client, "ensure_login"):
        client.ensure_login(mutation=False)
        features = client.features
    return FEATURE in features


def _log(worker, record, outcome):
    print("orkestr-v2-wa-adapter input_revision conversation=%s kind=%s outcome=%s"
          % (getattr(worker.client, "conversation", "?"), record["kind"], outcome), file=sys.stderr, flush=True)


def drive(worker, now=None):
    """Forward waiting changes. Raises nothing for a change Core has refused."""
    if not supported(worker.client):
        return
    now = time.time() if now is None else now
    for record in pending(worker.ledger):
        data = input_for(worker.ledger, record["public_id"])
        if data is None:
            settle(worker.ledger, record, "refused", "unknown_input")
            _log(worker, record, "unknown_input")
            continue
        # The Core message this input became: its own, or the burst it joined.
        admitted = _head(worker.ledger, data) if data.get("absorbed_into") else data
        if "intake" not in (admitted or {}):
            # Not in Core yet. It applies as soon as it is, or stops being retried.
            if now - record["received_at"] > MAX_AGE_S:
                settle(worker.ledger, record, "expired", "input_never_admitted")
                _log(worker, record, "input_never_admitted")
            continue
        body = {"request_key": request_key(record), "kind": record["kind"], "source": "whatsapp"}
        if merged(data):
            body["part"] = True
        if record["kind"] == "edit":
            body["text"] = record["text"]
        status, value = worker.client.request("POST", "/messages/%s/revisions" % admitted["intake"]["message_id"],
                                              body=body, allowed=(200, 201, 403, 404, 409))
        if status in (200, 201):
            settle(worker.ledger, record, "done", value.get("notice_message_id") if isinstance(value, dict) else None)
            _log(worker, record, "applied")
            continue
        code = value.get("code") if isinstance(value, dict) else None
        settle(worker.ledger, record, "done" if code in SETTLED else "refused", code or str(status))
        _log(worker, record, code or str(status))
