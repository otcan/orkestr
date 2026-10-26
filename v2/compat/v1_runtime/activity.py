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


LIVE_PHASES = ("queued", "starting", "running", "cancel_requested")


def conversation_busy(worker):
    """Whether Core reports a live Deep run in this conversation (any input)."""
    try:
        status, value = worker.client.request("GET", "/execution", allowed=(200, 204, 404))
    except Exception:
        return False  # Unknown is not evidence either way; keep the old rule.
    return status == 200 and isinstance(value, dict) and value.get("phase") in LIVE_PHASES


def observe(worker, data, statuses, now=None):
    """Called only after a successful own-run status read, never during an outage.

    Queued followers cannot create notices. Fresh source progress and confirmed
    visible work both postpone one. A healthy long run gets a truthful heartbeat;
    an absent/nonrunning run gets a status observation, never a retry promise.
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
        if conversation_busy(worker):
            # The adapter's own run match lags Core's journal (a burst, timer
            # traffic): Core is running a Deep turn, so "no running task" would
            # be false. Treat it as running; no alert, no missing-run notice.
            phase = "running"
    activity = data.setdefault("activity", {})
    gap = now - activity.get("observed_at", now)
    if gap > POLL_GAP_S:
        # A missed status read is not evidence of a running task. Pause this
        # notice clock across session expiry/restart rather than announcing it.
        activity["paused_s"] = activity.get("paused_s", 0) + gap
        activity["progress_at"] = now
    payload = (deep.get("progress") or {}).get("payload_id")
    if payload and payload != activity.get("payload_id"):
        activity.update(payload_id=payload, progress_at=now)
    activity.update(observed_at=now, phase=phase, run_id=deep.get("run_id"))
    if phase == "running":
        activity.pop("problem", None)
    ledger = worker.ledger
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
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
        if now - max(times) < INTERVAL_S:
            return
        running = phase == "running"
        if running:
            activity.pop("problem", None)
            count = activity.get("healthy_notices", 0)
            if count >= 2 or (count and now - since - activity.get("paused_s", 0) < SECOND_HEALTHY_AFTER_S):
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
        if prior and now - json.loads(prior[0])["at"] < (INTERVAL_S if running else MISSING_RUN_INTERVAL_S):
            return
        pending = db.execute("SELECT 1 FROM exports e JOIN inputs i ON i.remote_id=e.input_id "
                             "WHERE (e.source_key LIKE 'heartbeat:%' OR e.source_key LIKE 'stalled:%' "
                             "OR json_extract(i.data,'$.activity_notice') IS NOT NULL) "
                             "AND (e.outcome IS NULL OR e.outcome='uncertain') LIMIT 1").fetchone()
        if pending:
            return  # One unresolved status message for this whole binding.
        minutes = max(0, int((now - since - activity.get("paused_s", 0)) // 60))
        lang = notices.language_for(db, data)
        text = (notices.render(lang, "activity_running", minutes=minutes) if running else
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
            {"activity_notice": dict(input_id=data["remote_id"], running=running)}, message, source_id="status")
        if running:
            activity["healthy_notices"] = activity.get("healthy_notices", 0) + 1
        else:
            activity["missing_notice_at"] = now
        ledger.save(data, db)
        db.execute("INSERT INTO ledger_meta VALUES('activity_notice',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (json.dumps(dict(at=now, input_id=data["remote_id"], running=running)),))
