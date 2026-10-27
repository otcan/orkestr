"""Grouped Deep turns: one Deep final answers a burst of owner inputs.

While a Deep turn is busy, owner messages keep arriving and each one gets its
own Fast reply at once. Core (store-sqlite `deep_groups.rs`) then gives the
next Deep turn ALL owner inputs that queued meanwhile (at most 12, within a
byte budget), consumed by that one run. Its exact-run status lists them as
`grouped_inputs`, head first, in arrival order; a single-input run has no
such field and nothing here changes.

The serial head path folds the other inputs of the group into the head, in
one ledger transaction: they leave the run queue (`absorbed_into`, as a burst
member), their own Fast watches keep going, and they settle together with the
head's final or notice. The one final quotes the LAST input of the group
(`quoteSource` + `sourceInputId`, the V1 quote contract of #369).

Core never lets a grouped input run twice (each is consumed by the run), so
folding it never drops work: the run's outcome is that input's outcome.
"""
import json
import sys

from . import fast_watch
from .participants import compose

MAX_GROUP = 12
# A member row this many rows behind the head is still found.
SCAN_ROWS = 256


def members(data, deep, ids):
    """The validated grouped inputs after the head, or [] for a lone run."""
    from .worker import Refused
    if not isinstance(deep, dict) or deep.get("run_id") not in ids:
        return []
    group = deep.get("grouped_inputs")
    if group is None:
        return []
    if not isinstance(group, list) or not 2 <= len(group) <= MAX_GROUP:
        raise Refused("deep_group_shape")
    for item in group:
        if not isinstance(item, dict) or not all(isinstance(item.get(key), str) and item[key]
                                                 for key in ("message_id", "event_id", "request_key")):
            raise Refused("deep_group_shape")
    intake = data.get("intake") or {}
    if group[0]["message_id"] != intake.get("message_id") or group[0]["event_id"] != intake.get("event_id"):
        raise Refused("deep_group_mismatch")
    return group[1:]


def matches(row, item):
    """The ledger row of one grouped Core input: its intake receipt, else
    (receipt not saved yet) its frozen client message id."""
    intake = row.get("intake")
    if isinstance(intake, dict) and intake.get("message_id"):
        return intake["message_id"] == item["message_id"] and intake.get("event_id") == item["event_id"]
    return (row.get("keys") or {}).get("message") == item["request_key"]


def _rows(db, head):
    found = db.execute("SELECT data FROM inputs WHERE rowid > (SELECT rowid FROM inputs WHERE remote_id=?) "
                       "ORDER BY rowid LIMIT ?", (head["remote_id"], SCAN_ROWS)).fetchall()
    return [json.loads(raw) for (raw,) in found]


def fold(worker, data, deep, ids):
    """Fold the grouped inputs of `data`'s own Deep run into `data`. Repeated
    each pass until every grouped input is folded; then a no-op."""
    group = members(data, deep, ids)
    if not group:
        return
    known = data.get("deep_group") or {}
    if known.get("run_id") == deep["run_id"] and not known.get("pending"):
        return
    # A deadline continuation of this head may itself group newer inputs:
    # the earlier members stay folded and settle with it too.
    earlier = [] if known.get("run_id") == deep["run_id"] else list(known.get("inputs") or ())
    ledger = worker.ledger
    from .intake_fast import isolated
    with ledger.connect() as db:
        candidates = _rows(db, data)
    for row in candidates:
        # Its Fast reply continues on its own watch after it leaves the queue.
        if (any(matches(row, item) for item in group) and row.get("phase") != "completed" and
                isolated(worker, row) and "intake" in row and "window" in row):
            fast_watch.ensure(ledger, row)
    folded, pending, last = [], [], None
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        rows = _rows(db, data)
        for item in group:
            row = next((r for r in rows if matches(r, item)), None)
            if row is None:
                pending.append(item["message_id"])
                continue
            if row.get("absorbed_into") == data["remote_id"]:
                folded.append(row["remote_id"])
            elif row.get("phase") == "completed":
                continue  # Settled on its own before the group was seen.
            else:
                row.update(phase="completed", absorbed_into=data["remote_id"],
                           deep_group_of={"run_id": deep["run_id"], "head": data["remote_id"]})
                ledger.save(row, db)
                folded.append(row["remote_id"])
            if item is group[-1]:
                last = row["remote_id"]
        folded = earlier + [remote for remote in folded if remote not in earlier]
        state = {"run_id": deep["run_id"], "inputs": folded, "pending": pending,
                 "last": last or (folded[-1] if folded else None)}
        if state == known:
            return  # A grouped input is still missing here; nothing changed.
        data["deep_group"] = state
        ledger.save(data, db)
    # Identifiers only, never message text.
    print("%sorkestr-v2-wa-adapter deep_group_folded conversation=%s input=%s run=%s folded=%d pending=%d"
          % ("ALERT " if pending else "", getattr(worker.client, "conversation", "?"), data["remote_id"],
             deep["run_id"], len(folded), len(pending)), file=sys.stderr, flush=True)


def quote(data, reply):
    """The group's one final (also after a deadline continuation) quotes the
    group's last input."""
    group = data.get("deep_group") or {}
    if group.get("inputs") and group.get("last"):
        reply.update(quoteSource=True, sourceInputId=group["last"])


def grouped(data):
    return bool((data.get("deep_group") or {}).get("inputs"))


CARRY_NOTE = ("[%d owner messages were answered together by the stopped turn and continue together. "
              "Answer every numbered item explicitly in this one reply, in order.]")


def carry(ledger, head, text):
    """A deadline continuation of a grouped turn carries every grouped
    message, numbered in arrival order, so none is dropped. They still settle
    with the head."""
    rows = [ledger.input(remote_id) for remote_id in settled_with(head)]
    texts = [compose(row) for row in rows if row and isinstance(row.get("text"), str) and row["text"].strip()]
    if not texts:
        return text
    items = [text] + texts
    return CARRY_NOTE % len(items) + "".join("\n\n%d. %s" % (index + 1, item) for index, item in enumerate(items))


def settled_with(data):
    """Inputs that settle together with `data` (its grouped inputs)."""
    return list((data.get("deep_group") or {}).get("inputs") or ())
