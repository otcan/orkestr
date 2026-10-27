"""One shared, append-only view of a binding's Core journal.

Before, every reader (the serial head input, each Fast watch, each web
watch) read Core's event stream from its own cursor, one short stream read
per input per pass. After a burst every later input re-read the hundreds of
events the earlier ones had already read, at about one page per pass, so a
Deep final Core had accepted reached WhatsApp many minutes late (moteks,
2026-10-27: 20 and 29 minutes).

Core's journal is append-only and the client validates each envelope's scope
and cursor order once, so an event read once can serve every reader of the
same binding. Each reader still keeps its own cursor and still matches only
its own exact source tuple; the cache only removes repeated transport.

The cache covers one contiguous span (base, top]: every event of the
conversation with base < sequence <= top. Sequences may have gaps (the
journal is shared across aggregates), which is why coverage is tracked
separately from the events themselves. A read inside the span is served
from memory; a read at its end fetches from Core and extends it. A read
below the span goes to Core and is joined to the span when it reaches it.
The span is bounded (MAX_EVENTS) by dropping its oldest events.
"""
import bisect
import time

# A burst of 10 inputs with ~300 events each fits; one binding thread holds
# at most this many decoded envelopes (a few MB).
MAX_EVENTS = 3000
PAGE = 100


class Journal:
    def __init__(self, max_events=MAX_EVENTS):
        self.max_events = max_events
        self.client = None
        self._reset(None)
        self.fetched = 0  # Envelopes read from Core (diagnostics and tests).

    def _reset(self, client):
        self.client = client
        self.base = self.top = None
        self.events, self.sequences = [], []

    def _fetch(self, client, after, maximum, timeout_s):
        options = {} if timeout_s is None else {"timeout_s": timeout_s}
        try:
            events = client.read_events(after=after, maximum=maximum, **options)
        except Exception:
            # A lost, restarted or resynced Core: never serve memory read
            # before it; the next reads start a new span from Core.
            self._reset(client)
            raise
        self.fetched += len(events)
        return events

    def _trim(self):
        extra = len(self.events) - self.max_events
        if extra > 0:
            self.base = self.sequences[extra - 1]
            del self.events[:extra], self.sequences[:extra]

    def read(self, client, after, maximum=PAGE, timeout_s=None):
        """The same contract as `client.read_events`: up to `maximum` events
        with sequence > `after`, in journal order. A read that reaches the
        end of the span also reads on from Core, so it never returns less
        than a direct read would; empty means Core had nothing new."""
        return self._read(client, after, maximum, timeout_s)[0]

    def _read(self, client, after, maximum, timeout_s):
        """(events, at_end): `at_end` when a Core read at the journal's end
        returned nothing (only an empty read proves a cursor caught up)."""
        if client is not self.client:
            self._reset(client)  # Another binding's (or a test's) client.
        served = []
        if self.base is not None and self.base <= after < self.top:
            start = bisect.bisect_right(self.sequences, after)
            served = [dict(event) for event in self.events[start:start + maximum]]
            if len(served) == maximum or served[-1]["sequence"] < self.top:
                return served, False
            after = self.top
        fetched = self._fetch(client, after, maximum - len(served), timeout_s)
        if fetched:
            self._keep(after, fetched)
        return served + [dict(event) for event in fetched], not fetched

    def _keep(self, after, events):
        last = events[-1]["sequence"]
        if self.base is None or after > self.top:
            # First read, or a reader ahead of the span: start a new span.
            self.base, self.top = after, last
            self.events, self.sequences = list(events), [e["sequence"] for e in events]
        elif after == self.top:
            self.top = last
            self.events.extend(events)
            self.sequences.extend(e["sequence"] for e in events)
        elif last >= self.base:
            # A reader below the span whose page reaches it: join both.
            start = bisect.bisect_right(self.sequences, last)
            self.events = list(events) + self.events[start:]
            self.sequences = [e["sequence"] for e in self.events]
            self.base, self.top = after, max(self.top, last)
        else:
            return  # Disjoint and older: served, not kept.
        self._trim()

    def page(self, client, after, pages, budget_s, timeout_s=None):
        """Read forward from `after` until caught up, at most `pages` pages
        of PAGE events or about `budget_s` seconds. Returns (events,
        caught_up); `caught_up` means a Core read at the journal's end
        returned nothing."""
        events, cursor, started = [], after, time.monotonic()
        for _ in range(pages):
            batch, at_end = self._read(client, cursor, PAGE, timeout_s)
            events.extend(batch)
            if at_end:
                return events, True
            cursor = batch[-1]["sequence"]
            if time.monotonic() - started > budget_s:
                break
        return events, False


def shared(worker):
    """The binding's journal (created with the worker; tests may pass stubs)."""
    journal = getattr(worker, "journal", None)
    if not isinstance(journal, Journal):
        journal = Journal()
        try:
            worker.journal = journal
        except AttributeError:
            pass
    return journal
