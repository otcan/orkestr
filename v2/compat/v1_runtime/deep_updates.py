"""Throttled Deep progress for the chat during a long run ("Update: ...").

A long Deep turn showed nothing in the group until its final: Core kept every
progress update (the web chat shows each one, #617), but the adapter exported
at most three early progress notes per input (`progress_updates`), and a
reply to V1-local input stays in Orkestr (V1 records it `suppressed`). One
chat's run of 2026-11-19 worked 3.5 hours with 62 updates in Core, and the
group saw none of them.

While an input's own Deep run is running, the chat now gets that run's
latest progress text, prefixed "Update:" and cut to about MAX_CHARS
characters: the first once the run has run FIRST_AFTER_S, then at most one
every INTERVAL_S. A text the chat already got for this input (any run, any
progress note) is never sent again; the next new text is. Empty text,
NO_REPLY, questions (sent at once as their own posts) and a snapshot that is
still being written (outbound_text holds it) are skipped. Nothing is sent
once the input's final is exported or ready, and a final export withdraws
every update V1 has not taken yet (`withdraw`, from Ledger._export).

Every update is this input's own progress export (kind `progress`, source key
`update:<input>:<run>:<payload>`), written in one transaction with the run's
last-sent time and the text's digest, so neither a restart nor a replay sends
it twice. V1's scoped relay delivers a person's own WhatsApp input's progress
as a reply to it. For input whose progress V1 never posts to the group (a
V1-local request whose reply is mirrored to the group, see
local_reply_mirror.py, and a V2 timer run) the same transaction also writes a
group copy on a pseudo "status" parent, the shape V1 already delivers for the
Deep heartbeat; the relay sends both through the binding's bound assistant
account, never the owner's.

Binding field `deep_updates` (optional): unset means on for an owner-only
binding (no `participants`) and off for a group with participants; `true` or
`false` decides explicitly.
"""
from datetime import datetime
import hashlib
import json
import re
import sys
import time
import uuid

from .activity import HUMAN_ROLES, has_final
from .layer_identity import IDENTITY_FIELDS
from .ledger import LOCAL_ROLES, no_reply
from .outbound_text import complete_progress, progress_hold_s
from .questions import QUESTION_PREFIX, repeats_question
from .rust_client import ClientError

FIRST_AFTER_S = 15 * 60
INTERVAL_S = 30 * 60
MAX_CHARS = 600
# A cut text ends at a word when one ends this close to MAX_CHARS.
WORD_SLACK_CHARS = 120
PREFIX = "Update:"
# Never right after this input's own heartbeat line ("Still working ...").
AFTER_STATUS_S = 120
DIGEST_LIMIT = 64
RUN_LIMIT = 128
NAMESPACE = uuid.UUID("2b7d4e91-0c5a-4f36-9e18-7a3c6d2f8b04")
SOURCE_PREFIX = "update:"
# The pseudo parent of a group copy: V1 types source "status" as an update.
COPY_SOURCE_ID = "status"
COPY_LABEL = "Update"
_TIME = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$")


def enabled(config):
    """`deep_updates`: explicit true/false, else on only without participants."""
    value = config.get("deep_updates")
    if isinstance(value, bool):
        return value
    return not config.get("participants")


def route(data):
    """"input" when V1 posts this input's own progress to the group (a
    person's WhatsApp input), "copy" when only a pseudo status parent reaches
    the group (a V1-local request mirrored to the group, a V2 timer run),
    None when the group never sees this input's replies."""
    author = data.get("author") or {}
    if data.get("origin") is None:
        if author.get("role") in HUMAN_ROLES:
            return "input"
        if author.get("role") in LOCAL_ROLES and author.get("group_mirror") is True:
            return "copy"
        return None
    return "copy" if data.get("origin") == "timer" and data.get("timer") else None


def event_time(value):
    """Epoch seconds of a Core event's RFC 3339 `occurred_at`, or None."""
    match = _TIME.match(value) if isinstance(value, str) else None
    if not match:
        return None
    base, fraction, zone = match.groups()
    try:
        at = datetime.fromisoformat(base + ("+00:00" if zone == "Z" else zone)).timestamp()
    except ValueError:
        return None
    return at + (int(fraction) / 10 ** len(fraction) if fraction else 0.0)


def note_runs(data, events, ids, now=None):
    """Remember when each run of this input started: the first Core event of
    this pass naming it. Call before `matched_runs` takes the new ids.

    A run matched before this adapter tracked it (deployed while it ran) has
    no known start; the input's admission is its earliest possible start."""
    now = time.time() if now is None else now
    runs = (data.get("deep_updates") or {}).get("runs") or {}
    new = sorted(set(ids) - set(runs))
    if not new:
        return
    runs = data.setdefault("deep_updates", {}).setdefault("runs", {})
    known = set(data.get("matched_runs", []))
    admitted = data.get("admitted_at")
    admitted = admitted if isinstance(admitted, (int, float)) else None
    for run in new:
        if len(runs) >= RUN_LIMIT:
            break
        if run in known:
            runs[run] = {"started_at": min(now, admitted if admitted is not None else now)}
            continue
        times = [event_time(event.get("occurred_at")) for event in events
                 if (event.get("payload_ref_or_safe_payload") or {}).get("run_id") == run]
        started = min([at for at in times if at is not None and at <= now] + [now])
        runs[run] = {"started_at": max(started, admitted) if admitted is not None else started}


def body(text):
    """The update line for a progress text, or None when there is nothing to say."""
    if not isinstance(text, str) or no_reply(text) or not text.strip():
        return None
    text = text.strip()
    if text[:len(PREFIX)].casefold() == PREFIX.casefold():
        text = text[len(PREFIX):].strip()  # The model's own "Update:" is not doubled.
        if not text:
            return None
    if len(text) > MAX_CHARS:
        cut = text[:MAX_CHARS]
        end = max(cut.rfind(" "), cut.rfind("\n"))
        if end >= MAX_CHARS - WORD_SLACK_CHARS:
            cut = cut[:end]
        text = cut.rstrip() + " \u2026"
    return PREFIX + " " + text


def digest(line):
    return hashlib.sha256(" ".join(line.split()).casefold().encode()).hexdigest()[:32]


def _sent_before(db, data, line):
    """Whether this input already exported the same text (an update, or an
    ordinary progress note that would read the same once cut)."""
    state = data.get("deep_updates") or {}
    value = digest(line)
    if value in state.get("digests", []):
        return True
    for (text,) in db.execute("SELECT json_extract(message,'$.text') FROM exports WHERE input_id=? AND kind='progress'",
                              (data["remote_id"],)):
        if isinstance(text, str) and (digest(text) == value or (body(text) and digest(body(text)) == value)):
            return True
    return False


def capture(worker, data, status, ids, now=None):
    """One "Update:" export when this input's own running Deep run is due."""
    if not getattr(worker, "deep_updates", False) or not isinstance(status, dict):
        return
    run = status.get("run_id")
    payload_id = (status.get("progress") or {}).get("payload_id")
    kind = route(data)
    if (status.get("phase") != "running" or run not in ids or kind is None
            or not isinstance(payload_id, str) or not payload_id):
        return
    if data.get("phase") == "completed" or any(data.get(key) for key in (
            "deep_final_ready_at", "substantive_deep_final_prepared", "deep_final_completion", "settled")):
        return
    now = time.time() if now is None else now
    runs = data.setdefault("deep_updates", {}).setdefault("runs", {})
    if run not in runs:  # Not seen by note_runs: its clock starts now.
        runs[run] = {"started_at": now}
        worker.ledger.save(data)
    entry = runs[run]
    last = entry.get("sent_at")
    if now < (entry["started_at"] + FIRST_AFTER_S if last is None else last + INTERVAL_S):
        return
    heartbeat = (data.get("activity") or {}).get("heartbeat_at")
    if isinstance(heartbeat, (int, float)) and 0 <= now - heartbeat < AFTER_STATUS_S:
        return
    if payload_id == entry.get("examined") or payload_id in data.get("question_payloads", []):
        return
    held = entry.get("held") or {}
    if held.get("payload_id") == payload_id and now - held.get("since", now) < progress_hold_s(held):
        return  # Still being written: wait until it grows, or settles while the run runs.
    try:
        payload = worker.call("GET", "/payloads/" + payload_id)
    except ClientError as error:
        if error.status not in (404, 410):
            raise
        payload = None  # Removed: nothing left to send.
    if payload is not None and (payload.get("run_id") != run or payload.get("payload_id") != payload_id):
        log(worker, data, "deep_update_payload_mismatch", run, alert=True)
        payload = None
    text = (payload or {}).get("text")
    if isinstance(text, str) and text.startswith(QUESTION_PREFIX):
        text = None  # Its own question post is the only transport path.
    line = body(text)
    if line is not None and held.get("payload_id") != payload_id:
        entry["held"] = {"payload_id": payload_id, "since": now, "complete": complete_progress(text)}
        worker.ledger.save(data)
        return
    entry.pop("held", None)
    entry["examined"] = payload_id
    if line is None or repeats_question(data, text):
        worker.ledger.save(data)
        return
    identity = worker.provider_identity(run_id=run, status=status)
    if export(worker.ledger, data, run, payload_id, line, identity, kind, now) is not None:
        log(worker, data, "deep_update", run, route=kind, n=entry.get("sent", 0))


def export(ledger, data, run, payload_id, line, identity, kind, now):
    """Export one update (and its group copy) with the run's last-sent time
    and digest, in one transaction. None when the final came first or the
    chat already had this text."""
    source = SOURCE_PREFIX + "%s:%s:%s" % (data["remote_id"], run, payload_id)
    message = {"id": str(uuid.uuid5(NAMESPACE, source)), "role": "assistant", "state": "completed",
               "phase": "commentary", "kind": "progress", "source": "rust-v2-adapter",
               "parentMessageId": data["remote_id"], "text": line}
    message.update({k: v for k, v in (identity or {}).items() if k in IDENTITY_FIELDS and v})
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        if has_final(db, data):
            return None  # The answer came first; the stored row is left as it is.
        if _sent_before(db, data, line):
            ledger.save(data, db)
            return None
        ledger._export(db, data, "progress", source, message)
        if kind == "copy":
            copy(ledger, db, data, message, run, now)
        state = data["deep_updates"]
        value = digest(line)
        state["runs"][run].update(sent_at=now, sent=state["runs"][run].get("sent", 0) + 1, digest=value)
        state["digests"] = (state.get("digests", []) + [value])[-DIGEST_LIMIT:]
        ledger.save(data, db)
    return message


def copy_ids(export_id):
    return (str(uuid.uuid5(NAMESPACE, "copy:" + export_id)), str(uuid.uuid5(NAMESPACE, "copy-reply:" + export_id)))


def copy(ledger, db, data, message, run, now):
    """The group copy of `message` on its own pseudo status parent, in the
    caller's transaction."""
    remote_id, reply_id = copy_ids(message["id"])
    reply = {"id": reply_id, "role": "assistant", "state": "completed", "phase": "final_answer",
             "source": "rust-v2-adapter", "parentMessageId": remote_id, "text": message["text"]}
    reply.update({k: message[k] for k in IDENTITY_FIELDS if message.get(k)})
    extra = {"deep_update": {"input_id": data["remote_id"], "export_id": message["id"], "run_id": run}}
    ledger._pseudo_timer(db, remote_id, COPY_LABEL, int(now * 1000), extra, reply, source_id=COPY_SOURCE_ID)


def withdraw(ledger, db, data):
    """A final of `data` was just exported: retire every update (and group
    copy) V1 has not taken yet, so none is sent after the answer. One V1
    already imported cannot be recalled; a late ACK of it is still recorded."""
    rows = db.execute("SELECT export_id FROM exports WHERE input_id=? AND kind='progress' AND source_key LIKE ?",
                      (data["remote_id"], SOURCE_PREFIX + "%")).fetchall()
    retired = 0
    for (export_id,) in rows:
        retired += db.execute("UPDATE exports SET outcome='superseded' WHERE export_id=? AND outcome IS NULL "
                              "AND ack IS NULL", (export_id,)).rowcount
        remote_id, reply_id = copy_ids(export_id)
        if db.execute("UPDATE exports SET outcome='superseded' WHERE export_id=? AND input_id=? AND outcome IS NULL "
                      "AND ack IS NULL", (reply_id, remote_id)).rowcount:
            row = db.execute("SELECT data FROM inputs WHERE remote_id=?", (remote_id,)).fetchone()
            if row:
                ledger._settle(db, json.loads(row[0]), "superseded")
            retired += 1
    if retired:
        print("orkestr-v2-wa-adapter deep_update_withdrawn thread=%s input=%s count=%d"
              % (ledger.scope.get("remote_thread_id", "?"), data["remote_id"], retired), file=sys.stderr, flush=True)


def pending(db, input_id):
    """Whether an update of this input is exported and not reported yet."""
    return db.execute("SELECT 1 FROM exports WHERE input_id=? AND kind='progress' AND source_key LIKE ? "
                      "AND outcome IS NULL LIMIT 1", (input_id, SOURCE_PREFIX + "%")).fetchone() is not None


def log(worker, data, event, run, alert=False, **fields):
    # Identifiers only, never message text.
    extra = "".join(" %s=%s" % item for item in sorted(fields.items()))
    print("%sorkestr-v2-wa-adapter %s conversation=%s input=%s run=%s%s"
          % ("ALERT " if alert else "", event, getattr(worker.client, "conversation", "?"), data["remote_id"], run, extra),
          file=sys.stderr, flush=True)
