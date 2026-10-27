"""Read-only parallel Deep finals, settled out of order (docs/v2/parallel-deep.md).

With the owner's `parallel_deep` switch on, Core may answer an owner message
that queued behind a running Deep turn with its own read-only parallel Deep
turn (a "slot"). That message is then not the ledger head, so the serial head
path would hold its final until every earlier input settled. This watch finds
such an input's own slot run (exact-run status `parallel_deep: true`) and
drives that one input through the ordinary per-input path, which adopts the
server's acceptance and exports the final. A burst final (`concurrent_deep`)
quotes its own source message (`quoteSource` + `sourceInputId`, the V1 quote
contract of #369), so out-of-order answers stay attributable.

A slot that answered exactly `PARALLEL_DEFER` needed a change or an action:
Core returned the input to the writer's queue. Nothing is exported for it; the
input forgets that run and waits for the writer's own Deep run as before.

With the switch off no run is ever marked `parallel_deep`: nothing here acts.
"""
import sys
import time
import uuid

DEFER = "PARALLEL_DEFER"
# Inputs behind the head looked at per pass, and new run lookups per input.
MAX_INPUTS = 32
MAX_LOOKUPS = 8
# How long one read of the owner switch stays current.
SETTINGS_S = 30


def ignored(data):
    """Runs of this input that must never answer it (deferred slots)."""
    return set(data.get("parallel_deferred") or ())


def enabled(worker):
    """The owner's switch, read from the conversation settings at most every
    SETTINGS_S. Off (or unreadable): this watch reads and writes nothing."""
    now = time.monotonic()
    cached = getattr(worker, "_parallel_deep", None)
    if cached is not None and now - cached[0] < SETTINGS_S:
        return cached[1]
    try:
        status, value = worker.client.request("GET", "/settings", allowed=(200,))
        on = status == 200 and isinstance(value, dict) and value.get("parallel_deep") is True
    except Exception:
        on = False
    worker._parallel_deep = (now, on)
    return on


def drive(worker):
    """One pass over the inputs behind the head. True when one was driven."""
    if getattr(worker, "fast_reply_policy", None) != "owner_only" or not enabled(worker):
        return False
    from .intake_fast import isolated
    from .worker import Refused
    head = worker.ledger.next_input()
    driven = False
    for data in worker.ledger.pending_inputs()[:MAX_INPUTS]:
        if head is not None and data["remote_id"] == head["remote_id"]:
            continue
        if (data.get("phase") == "completed" or "intake" not in data or "window" not in data
                or data.get("origin") is not None or not isolated(worker, data)):
            continue
        run = parallel_run(worker, data)
        if run is None:
            continue
        driven = True
        if failed(worker, data, run):
            continue  # Core gave it back to the writer: wait for that run.
        try:
            worker.observe(data)
        except Refused as error:
            worker.ledger.refuse(data, str(error))
        except Exception:
            # Retried next pass; the serial head path is never held by it.
            pass
    return driven


def parallel_run(worker, data):
    """This input's own parallel slot run, if Core started one."""
    known = data.get("parallel_run")
    if known:
        return known
    after = data.get("parallel_cursor", data.get("cursor", 0))
    from . import journal
    # The binding's shared journal: one read serves every watch of it.
    events = journal.shared(worker).read(worker.client, after, 100)
    checked = set(data.get("parallel_checked") or ())
    ids = set(worker.client.matching_run_ids(events, data["intake"])) - checked - ignored(data)
    data["parallel_cursor"] = max([after] + [event["sequence"] for event in events])
    found = None
    for run in sorted(ids)[:MAX_LOOKUPS]:
        status, value = worker.client.request("GET", "/execution?run_id=" + run, allowed=(200, 404))
        checked.add(run)
        if status == 200 and isinstance(value, dict) and value.get("run_id") == run:
            if value.get("parallel_deep") is True:
                found = run
                break
    data["parallel_checked"] = sorted(checked)[-64:]
    if found:
        data["parallel_run"] = found
    worker.ledger.save(data)
    return found


def failed(worker, data, run):
    """A slot turn that failed (e.g. provider capacity) never answers: Core
    returns the input to the writer. Forget the run, as for a defer."""
    try:
        status, value = worker.client.request("GET", "/execution?run_id=" + run, allowed=(200, 404))
    except Exception:
        return False
    if status != 200 or not isinstance(value, dict) or value.get("phase") not in ("failed", "blocked"):
        return False
    forget(worker, data, run, "parallel_deep_failed")
    return True


def forget(worker, data, run, event):
    data["parallel_deferred"] = sorted(ignored(data) | {run})
    data["matched_runs"] = [value for value in data.get("matched_runs", []) if value != run]
    for key in ("parallel_run", "deep_accept_request", "deep_payload", "deep_final_ready_at",
                "substantive_deep_final_prepared", "progress_seen"):
        data.pop(key, None)
    (data.get("accepted") or {}).pop("deep", None)
    # The writer's run gets its own acceptance key: the slot's was spent.
    if isinstance(data.get("keys"), dict) and "deep" in data["keys"]:
        data["keys"]["deep"] = str(uuid.uuid4())
    data["phase"] = "running"
    worker.ledger.save(data)
    print("orkestr-v2-wa-adapter %s conversation=%s input=%s run=%s"
          % (event, getattr(worker.client, "conversation", "?"), data["remote_id"], run), file=sys.stderr, flush=True)


def deferred(worker, data, deep, text):
    """True when this input's accepted slot answer is the defer marker: forget
    that run (nothing is exported) and wait for the writer's own Deep run."""
    if data.get("parallel_run") != deep.get("run_id") or not isinstance(text, str) or text.strip() != DEFER:
        return False
    forget(worker, data, deep["run_id"], "parallel_deep_deferred")
    return True


def quote(data, status, reply):
    """A Deep final of a parallel burst quotes its own source message."""
    if isinstance(status, dict) and status.get("concurrent_deep") is True and "quoteSource" not in reply:
        reply.update(quoteSource=True, sourceInputId=data["remote_id"])
