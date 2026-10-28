"""Truthful, admission-scoped activity notices; no notice is a work result."""
from datetime import datetime
import json
import sys
import time
import uuid

from . import notices
from .ledger import LOCAL_ROLES, NOTICE_NAMESPACE, POST_NAMESPACE

INTERVAL_S = 10 * 60
MISSING_RUN_INTERVAL_S = 30 * 60
SECOND_HEALTHY_AFTER_S = 60 * 60
POLL_GAP_S = 60
NOTICE_PREFIXES = ("stalled:", "heartbeat:", "continued:")
# Deep heartbeat (binding `deep_heartbeat`, default on): a running Deep turn
# for a person's WhatsApp input (owner or member; never a timer) with no final
# gets one short template line after a quiet spell with no delivered message
# for that input, backing off: 3, then 5, then 7 minutes (lines at 3, 8, 15
# minutes), then every 15 minutes, at most HEARTBEAT_MAX lines per input.
# Model progress that was not delivered to the chat does not postpone it.
HEARTBEAT_GAPS_S = (3 * 60, 5 * 60, 7 * 60)
HEARTBEAT_LATER_S = 15 * 60
HEARTBEAT_MAX = 6
# One heartbeat per chat at most this often, across inputs.
HEARTBEAT_CHAT_SPACING_S = 5 * 60
HUMAN_ROLES = ("owner", "member")


def heartbeat_gap(sent):
    """The quiet spell before heartbeat number `sent + 1`, or None once capped."""
    if sent >= HEARTBEAT_MAX:
        return None
    return HEARTBEAT_GAPS_S[sent] if sent < len(HEARTBEAT_GAPS_S) else HEARTBEAT_LATER_S


def heartbeat_applies(worker, data):
    """Only where a person waits: their own WhatsApp input in an enabled binding."""
    return (getattr(worker, "deep_heartbeat", True) and data.get("origin") is None
            and (data.get("author") or {}).get("role") in HUMAN_ROLES)


def delivered_at(raw):
    try:
        ack = json.loads(raw) if raw else {}
        if (ack.get("outcome") != "delivered" or not ack.get("connectorMessageIds")
                or not ack.get("outboxJobId")):
            return None
        value = datetime.fromisoformat(ack["deliveredAt"].replace("Z", "+00:00"))
        return value.timestamp() if value.tzinfo is not None else None
    except (KeyError, TypeError, ValueError, AttributeError):
        return None


LAG_ALERT_S = 20 * 60


def match_lagging(worker, data):
    """Whether Core's journal head (non-streaming snapshot) is past this
    input's own event cursor, so its run match may simply not be read yet."""
    try:
        snapshot = worker.call("GET", "")
    except Exception:
        return False  # Unknown is not lag evidence; keep the old rule.
    head = snapshot.get("last_sequence") if isinstance(snapshot, dict) else None
    cursor = data.get("cursor")
    return type(head) is int and type(cursor) is int and head > cursor


def observe(worker, data, statuses, now=None):
    """Called only after a successful own-run status read, never during an outage.

    Queued followers cannot create notices. Confirmed visible work postpones
    one. A healthy long run gets the Deep heartbeat (or, with `deep_heartbeat`
    off, the legacy 10-minute notice that fresh source progress also
    postpones); an absent/nonrunning run gets a status observation, never a
    retry promise. One status line per chat at a time, deduped by its pending
    export and spaced through `ledger_meta.activity_notice`.
    """
    now = time.time() if now is None else now
    since = data.get("admitted_at")
    if (not isinstance(since, (int, float)) or data.get("phase") == "completed"
            or (data.get("author") or {}).get("role") in LOCAL_ROLES):
        return
    deep = statuses.get("deep") or {}
    phase = deep.get("phase")
    if phase in ("awaiting_acceptance", "completed", "failed", "lost", "blocked", "cancelled", "stopped", "interrupted"):
        return
    if deep.get("run_id") not in data.get("matched_runs", []):
        deep, phase = {}, None
        if now - since >= INTERVAL_S and match_lagging(worker, data):  # Only when a notice could be due.
            # This input's own journal match is behind Core's head (a burst,
            # timer traffic), so "no running task" is not established: no
            # notice. The operator is still alerted once it lags too long.
            lag = data.setdefault("activity", {}).setdefault("match_lag_since", now)
            if now - lag >= LAG_ALERT_S and not data["activity"].get("match_lag_alerted"):
                data["activity"]["match_lag_alerted"] = True
                print("ALERT orkestr-v2-wa-adapter run_match_lagging conversation=%s input=%s"
                      % (getattr(worker.client, "conversation", "?"), data["remote_id"]), file=sys.stderr, flush=True)
            worker.ledger.save(data)
            return
        (data.get("activity") or {}).pop("match_lag_since", None)
    activity = data.setdefault("activity", {})
    gap = now - activity.get("observed_at", now)
    if gap > POLL_GAP_S:
        # A missed status read is not evidence of a running task. Pause this
        # notice clock across session expiry/restart rather than announcing it.
        activity["paused_s"] = activity.get("paused_s", 0) + gap
        activity["progress_at"] = activity["resumed_at"] = now
    payload = (deep.get("progress") or {}).get("payload_id")
    if payload and payload != activity.get("payload_id"):
        activity.update(payload_id=payload, progress_at=now)
    activity.update(observed_at=now, phase=phase, run_id=deep.get("run_id"))
    if phase == "running":
        activity.pop("problem", None)
    heartbeat = phase == "running" and heartbeat_applies(worker, data)
    ledger = worker.ledger
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        if heartbeat:
            # Only what the chat saw counts: the admission (after any outage
            # pause), this input's delivered messages and its last heartbeat.
            times = [since + activity.get("paused_s", 0), activity.get("resumed_at", since),
                     activity.get("heartbeat_at", since)]
        else:
            times = [since + activity.get("paused_s", 0), activity.get("progress_at", since)]
        questions = set(data.get("question_payloads", []))
        question_ids = [str(uuid.uuid5(POST_NAMESPACE, "post:" + value))
                        for value in questions]
        fast_id = (data.get("first_response") or {}).get("remote_id")
        if fast_id:
            question_ids.append(fast_id)
        placeholders = ",".join("?" for _ in question_ids)
        selection = "e.input_id=?" + (" OR e.input_id IN (" + placeholders + ")" if question_ids else "")
        for row in db.execute("SELECT e.source_key,e.ack,e.input_id,i.data FROM exports e JOIN inputs i ON i.remote_id=e.input_id "
                              "WHERE e.ack IS NOT NULL AND (" + selection + ")", [data["remote_id"], *question_ids]):
            source, raw, remote, parent = row
            if source.startswith(NOTICE_PREFIXES):
                continue
            if (remote not in (data["remote_id"], fast_id)
                    and (json.loads(parent).get("post") or {}).get("id") not in questions):
                continue
            at = delivered_at(raw)
            if at is not None and at <= now:
                times.append(at)
        ledger.save(data, db)
        due = heartbeat_gap(activity.get("heartbeats", 0)) if heartbeat else INTERVAL_S
        if due is None or now - max(times) < due:
            return  # Not due yet, or this input's heartbeats are spent.
        running = phase == "running"
        if running:
            activity.pop("problem", None)
            count = activity.get("healthy_notices", 0)
            # Heartbeats follow heartbeat_gap() (capped there); the legacy
            # notice is sent once, then once more after an hour.
            if not heartbeat and (count >= 2 or (count and now - since - activity.get("paused_s", 0) < SECOND_HEALTHY_AFTER_S)):
                ledger.save(data, db)
                return
        else:
            if activity.get("problem") != "no_running_task":
                activity["problem"] = "no_running_task"
                print("ALERT orkestr-v2-wa-adapter no_running_task conversation=%s input=%s"
                      % (getattr(worker.client, "conversation", "?"), data["remote_id"]), file=sys.stderr, flush=True)
            ledger.save(data, db)
            if now - activity.get("missing_notice_at", -MISSING_RUN_INTERVAL_S) < MISSING_RUN_INTERVAL_S:
                return
        prior = db.execute("SELECT value FROM ledger_meta WHERE key='activity_notice'").fetchone()
        spacing = (HEARTBEAT_CHAT_SPACING_S if heartbeat else INTERVAL_S) if running else MISSING_RUN_INTERVAL_S
        if prior and now - json.loads(prior[0])["at"] < spacing:
            return  # At most one status line per chat per spacing.
        pending = db.execute("SELECT 1 FROM exports e JOIN inputs i ON i.remote_id=e.input_id "
                             "WHERE (e.source_key LIKE 'heartbeat:%' OR e.source_key LIKE 'stalled:%' "
                             "OR json_extract(i.data,'$.activity_notice') IS NOT NULL) "
                             "AND (e.outcome IS NULL OR e.outcome='uncertain') LIMIT 1").fetchone()
        if pending:
            return  # One unresolved status message for this whole binding.
        minutes = max(0, int((now - since - activity.get("paused_s", 0)) // 60))
        lang = notices.language_for(db, data)
        text = (notices.render(lang, "deep_heartbeat", minutes=max(1, minutes)) if heartbeat else
                notices.render(lang, "activity_running", minutes=minutes) if running else
                notices.render(lang, "activity_missing", state=phase or "no run observed", minutes=minutes))
        sequence = int(now * 1000)
        source = "heartbeat:%s:%d" % (data["remote_id"], sequence)
        remote = str(uuid.uuid5(NOTICE_NAMESPACE, "input:" + source))
        message = dict(id=str(uuid.uuid5(NOTICE_NAMESPACE, "reply:" + source)), role="assistant", state="completed",
                       phase="final_answer", source="rust-v2-adapter",
                       parentMessageId=remote, text=text, activityNotice=True)
        # A status has its own durable notification identity. The ordinary
        # progress path can be disabled or superseded by the task's final, and
        # cannot transport timer progress. This established pseudo-parent path
        # works for every origin without completing the original input.
        ledger._pseudo_timer(db, remote, "Status", sequence,
            {"activity_notice": dict(input_id=data["remote_id"], running=running, heartbeat=heartbeat)}, message, source_id="status")
        if running:
            activity["healthy_notices"] = activity.get("healthy_notices", 0) + 1
            if heartbeat:
                activity["heartbeat_at"] = now
                activity["heartbeats"] = activity.get("heartbeats", 0) + 1
        else:
            activity["missing_notice_at"] = now
        ledger.save(data, db)
        db.execute("INSERT INTO ledger_meta VALUES('activity_notice',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (json.dumps(dict(at=now, input_id=data["remote_id"], running=running)),))
