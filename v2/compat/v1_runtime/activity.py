"""Truthful, admission-scoped activity notices; no notice is a work result."""
from datetime import datetime
import json
import time
import uuid

from .ledger import LOCAL_ROLES, NOTICE_NAMESPACE, POST_NAMESPACE

INTERVAL_S = 10 * 60
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
    ledger = worker.ledger
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        times = [since + activity.get("paused_s", 0), activity.get("progress_at", since)]
        questions = set(data.get("question_payloads", []))
        question_ids = [str(uuid.uuid5(POST_NAMESPACE, "post:" + value))
                        for value in questions]
        placeholders = ",".join("?" for _ in question_ids)
        selection = "e.input_id=?" + (" OR e.input_id IN (" + placeholders + ")" if question_ids else "")
        for row in db.execute("SELECT e.source_key,e.ack,e.input_id,i.data FROM exports e JOIN inputs i ON i.remote_id=e.input_id "
                              "WHERE e.ack IS NOT NULL AND (" + selection + ")", [data["remote_id"], *question_ids]):
            source, raw, remote, parent = row
            if source.startswith(NOTICE_PREFIXES):
                continue
            if remote != data["remote_id"] and (json.loads(parent).get("post") or {}).get("id") not in questions:
                continue
            at = delivered_at(raw)
            if at is not None and at <= now:
                times.append(at)
        ledger.save(data, db)
        if now - max(times) < INTERVAL_S:
            return
        prior = db.execute("SELECT value FROM ledger_meta WHERE key='activity_notice'").fetchone()
        if prior and now - json.loads(prior[0])["at"] < INTERVAL_S:
            return
        pending = db.execute("SELECT 1 FROM exports e JOIN inputs i ON i.remote_id=e.input_id "
                             "WHERE (e.source_key LIKE 'heartbeat:%' OR e.source_key LIKE 'stalled:%' "
                             "OR json_extract(i.data,'$.activity_notice') IS NOT NULL) "
                             "AND (e.outcome IS NULL OR e.outcome='uncertain') LIMIT 1").fetchone()
        if pending:
            return  # One unresolved status message for this whole binding.
        minutes = max(0, int((now - since - activity.get("paused_s", 0)) // 60))
        running = phase == "running"
        text = ("Still running, %d minutes since admission. No new progress in the last 10 minutes." % minutes
                if running else "No running task is confirmed (%s), %d minutes since admission. The result is still pending."
                % (phase or "no run observed", minutes))
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
        db.execute("INSERT INTO ledger_meta VALUES('activity_notice',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (json.dumps(dict(at=now, input_id=data["remote_id"], running=running)),))
