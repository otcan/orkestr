"""Pace replays of a frozen window request that Core keeps queued.

A 202 from POST /window means Core queued the intent durably and its own
dispatcher opens the window later. The adapter learns of that dispatch only
by replaying the same frozen request, which reports the queue row. Every
worker pass used to replay it (once a second, and twice for some inputs),
for as long as the row stayed queued. A queued row can wait for hours, for
example behind a provider policy switch or owner-wide capacity, and one such
chat then sent about 100 requests a minute.

The first replays still follow every pass, so a short wait is noticed at
once. After that, a replay is due every SLOW_S, and after a longer wait every
IDLE_S. A dispatched or refused request forgets its pace. The state lives in
memory only: a restarted worker simply starts fast again. Nothing about the
request, its ledger record or its Core row changes.
"""
import time

FAST_REPLAYS = 5
SLOW_REPLAYS = 20
SLOW_S = 5.0
IDLE_S = 15.0


def _paces(worker):
    paces = getattr(worker, "_queued_replays", None)
    if paces is None:
        paces = worker._queued_replays = {}
    return paces


def _key(data):
    return data["window_request"]["request_key"]


def due(worker, data, now=None):
    """Whether the next replay of this queued request may be sent now."""
    pace = _paces(worker).get(_key(data))
    if pace is None:
        return True
    now = time.monotonic() if now is None else now
    return now >= pace["next"]


def waited(worker, data, now=None):
    """Core answered `queued` again: schedule the next replay."""
    now = time.monotonic() if now is None else now
    pace = _paces(worker).setdefault(_key(data), {"replays": 0, "next": now})
    pace["replays"] += 1
    if pace["replays"] < FAST_REPLAYS:
        pause = 0.0
    elif pace["replays"] < SLOW_REPLAYS:
        pause = SLOW_S
    else:
        pause = IDLE_S
    pace["next"] = now + pause


def forget(worker, data):
    """The request was dispatched, admitted or refused."""
    if "window_request" in data:
        _paces(worker).pop(_key(data), None)
