"""A continuation Core admitted under its own window intent is watched, not frozen.

A continued input (release or deadline continuation) is admitted with its
source run. Core then queues its own window intent for exactly that input
(`source-continuation:<event>`) in the same transaction, and may dispatch it
before the adapter's own frozen request arrives. That request is then refused
(409 `window_fenced`) although Core admitted, and may already have run,
exactly this input. Before this module the adapter held the input "until Core
proves safe settlement", for good, and every later input of the chat expired
behind it.

Core's proof is positive and exact: its current window was opened for this
input's own message and event, or its journal shows a run of them. The input
is then no orphan: the adapter watches it like a Core-dispatched queue row
(`Worker.window_queued`), so its run settles it through the ordinary path.
Without such proof nothing changes: the frozen request stays held and is never
replaced. Only continued inputs qualify; for any other input the adapter is
the only requester, so `window_fenced` keeps its stale-request meaning.
"""
import sys
import time

from .journal import PAGE, shared

# Journal pages read per refused pass while looking for this input's own run.
RUN_CHECK_PAGES = 5
DISPATCHED_BY = "core_continuation_intent"


def _current_window(worker, intake):
    current = worker.call("GET", "/window", allowed=(200, 204))
    if (isinstance(current, dict) and current.get("window_id") and
            current.get("conversation_id", worker.client.conversation) == worker.client.conversation and
            current.get("input_message_id") == intake.get("message_id") and
            current.get("input_event_id") == intake.get("event_id")):
        return current["window_id"]
    return None


def _own_run(worker, data, intake):
    """Whether Core's journal (up to its current head) shows a run of this
    exact input. Reads only below a snapshot head, so it never waits there."""
    from .intake_fast import EVENT_WAIT_S  # Lazy: intake_fast imports intake.
    snapshot = worker.call("GET", "")
    head = snapshot.get("last_sequence") if isinstance(snapshot, dict) else None
    cursor = data.get("cursor")
    if type(head) is not int or type(cursor) is not int:
        return False
    journal = shared(worker)
    for _ in range(RUN_CHECK_PAGES):
        if head <= cursor:
            return False
        events = journal.read(worker.client, cursor, PAGE, timeout_s=EVENT_WAIT_S)
        if not events:
            return False
        if worker.client.matching_run_ids(events, intake):
            return True
        cursor = events[-1]["sequence"]
    return False


def adopt(worker, data):
    """After a definite `window_fenced`: True when Core proved it admitted this
    continued input itself; the row is then watched like a dispatched one."""
    intake = data.get("intake") or {}
    if not data.get("continued") or not intake.get("message_id") or not intake.get("event_id"):
        return False
    window = _current_window(worker, intake)
    evidence = "window" if window else ("run" if _own_run(worker, data, intake) else None)
    if evidence is None:
        return False
    data.pop("window_refusal", None)
    data.update(window={"dispatched_by": DISPATCHED_BY, "window_id": window}, phase="running")
    data["window_adopted"] = {"evidence": evidence, "window_id": window, "at": time.time()}
    worker.ledger.save(data)
    # Identifiers only, never message text.
    print("orkestr-v2-wa-adapter window_adopted conversation=%s input=%s evidence=%s window=%s"
          % (worker.client.conversation, data["remote_id"], evidence, window or "none"),
          file=sys.stderr, flush=True)
    return True
