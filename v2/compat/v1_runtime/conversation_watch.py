"""One shared look at every conversation's event sequence (ORK-782).

Each enabled binding asked Core about once a second whether its conversation
had a new web-UI message, returned thread-ask answer or timer occurrence.
Every Core request opens a new connection and proves Core's identity from the
kernel's socket table (service_peer.py), so 68 mostly idle bindings cost about
2.2 cores and kept the outbound gate full, delaying real deliveries.

Those three kinds of rows are inputs of the conversation: Core writes each in
the same transaction that advances the conversation's `last_sequence`
(`intake::admit_in_transaction`). This watch reads `last_sequence` of every
conversation of the owner with one paged directory listing
(`GET /api/v2/conversations`) every WATCH_S and wakes the binding of each
conversation that changed. `idle_polls.Polls` uses it to leave out a poll that
cannot find anything new.

A value is only served while the last complete listing is younger than
STALE_S. Without one (an older server, Core down, the gate refusing the
request) every binding polls at its ordinary cadence again, as before.
"""
import sys
import threading
import time
import uuid

WATCH_S = 2.0
STALE_S = 10.0
PAGE = 100
# The directory holds about 130 conversations; this bounds a broken cursor.
MAX_PAGES = 50
RETRY_AT_PACE = 4
RETRY_MAX_S = 30.0


def _conversation(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        return False


class ConversationWatch:
    def __init__(self, read_page, interval=WATCH_S):
        # read_page(after, limit) -> the decoded `GET /api/v2/conversations` page.
        self.read_page, self.interval = read_page, interval
        self._sequences = {}
        self._fresh_at = None
        self._lock = threading.Lock()

    def sequence(self, conversation, now=None):
        """The conversation's `last_sequence` at the latest complete listing,
        or None when it is unknown or the listing is stale."""
        now = time.monotonic() if now is None else now
        with self._lock:
            if self._fresh_at is None or now - self._fresh_at > STALE_S:
                return None
            return self._sequences.get(conversation)

    def status(self, now=None):
        """For `GET /health`: whether bindings may leave out polls now."""
        now = time.monotonic() if now is None else now
        with self._lock:
            age = None if self._fresh_at is None else now - self._fresh_at
            return {"enabled": True, "fresh": age is not None and age <= STALE_S,
                    "ageS": None if age is None else round(age, 1), "conversations": len(self._sequences)}

    def _listing(self):
        sequences, after = {}, 0
        for _ in range(MAX_PAGES):
            value = self.read_page(after, PAGE)
            rows = value.get("conversations") if isinstance(value, dict) else None
            cursor = value.get("next_cursor") if isinstance(value, dict) else None
            if not isinstance(rows, list) or len(rows) > PAGE or not (
                    cursor is None or (type(cursor) is int and cursor > after)):
                raise ValueError("conversation_listing_shape")
            for row in rows:
                sequence = row.get("last_sequence") if isinstance(row, dict) else None
                if (not isinstance(row, dict) or not _conversation(row.get("conversation_id")) or
                        type(sequence) is not int or sequence < 0):
                    raise ValueError("conversation_listing_shape")
                sequences[row["conversation_id"]] = sequence
            if cursor is None:
                return sequences
            after = cursor
        raise ValueError("conversation_listing_unbounded")

    def poll(self):
        """One complete listing. Returns the conversations whose sequence
        changed since the previous one (none for the first listing)."""
        # A value is as old as the start of the listing that read it.
        started = time.monotonic()
        sequences = self._listing()
        with self._lock:
            previous, first = self._sequences, self._fresh_at is None
            self._sequences, self._fresh_at = sequences, started
        if first:
            return set()
        return {conversation for conversation, sequence in sequences.items() if previous.get(conversation) != sequence}

    def run(self, stop, on_change):
        """Poll until `stop` is set; `on_change(conversations)` wakes their bindings."""
        failures = 0
        while not stop.is_set():
            try:
                changed = self.poll()
                failures = 0
            except Exception as error:
                changed = set()
                failures += 1
                if failures in (1, 10) or failures % 100 == 0:
                    print("WARN orkestr-v2-wa-adapter conversation_watch_unavailable error=%s attempts=%d"
                          % (getattr(error, "code", None) or type(error).__name__, failures),
                          file=sys.stderr, flush=True)
            if changed:
                try:
                    on_change(changed)
                except Exception:
                    pass  # A wake is a hint; every binding still polls on its own cadence.
            stop.wait(self.pause(failures))

    def pause(self, failures):
        """A few failures (a full outbound gate after a restart) are retried
        at the normal pace, so the watch is not starved by the very polls it
        replaces; a lasting outage backs off up to RETRY_MAX_S."""
        if failures <= RETRY_AT_PACE:
            return self.interval
        return min(RETRY_MAX_S, self.interval * 2 ** min(failures - RETRY_AT_PACE, 8))
