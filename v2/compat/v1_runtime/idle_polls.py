"""Which Core polls a binding can leave out while nothing changed (ORK-782).

Every Core request opens a new connection and proves Core's identity from the
kernel's socket table (service_peer.py): about 15-50 ms of CPU each. An
enabled binding used to ask Core about once a second whether anything new had
arrived (web messages and thread-ask answers every 3 s, timers and posts every
5 s, digests every 30 s), however long its chat had been quiet.

With a fresh `ConversationWatch` (conversation_watch.py):

* Web messages, returned thread-ask answers and timer occurrences (SEQUENCED)
  are inputs Core writes in the transaction that advances the conversation's
  sequence. When the watch shows the sequence seen before this source's last
  poll, and that poll found nothing, the poll is left out. A changed sequence
  makes a left-out source due at once (the watch also wakes the worker), so a
  new input is found no later than before; FALLBACK_S still polls each source
  now and then.
* Posts and digests change no sequence. A binding with nothing to do for
  ACTIVE_S (no input, nothing found, no change in its conversation) polls them
  every POST_IDLE_POLL_S / DIGEST_IDLE_POLL_S instead.

Without a fresh watch nothing is left out and every cadence is the old one.
An idle period is stretched by a per-binding factor so bindings that started
together do not poll together.
"""
import random
import time

SEQUENCED = ("web", "thread_ask", "timers")
FALLBACK_S = 120
ACTIVE_S = 600
POST_IDLE_POLL_S = 15
DIGEST_IDLE_POLL_S = 60
# A pause ends at the due time; a few ms of early wakeup still counts.
EARLY_S = 0.05


class Polls:
    def __init__(self, conversation=None, spread=None):
        self.conversation = conversation
        self.watch = None  # Set by the registry; None keeps every old cadence.
        self.spread = random.uniform(0.8, 1.2) if spread is None else spread
        self._seen = {}      # source -> sequence before its last poll that found nothing
        self._pending = {}   # source -> sequence before the poll in progress
        self._polled = {}    # source -> monotonic time of its last poll
        self._skipped = set()
        self._active_until = None
        self._last_sequence = None

    def sequence(self, now=None):
        watch = self.watch
        if watch is None or not self.conversation:
            return None
        return watch.sequence(self.conversation, now)

    def touch(self, now=None):
        """Something happened in this binding: keep its interactive cadence."""
        self._active_until = (time.monotonic() if now is None else now) + ACTIVE_S

    def active(self, now=None):
        """Whether posts and digests keep their ordinary cadence."""
        now = time.monotonic() if now is None else now
        sequence = self.sequence(now)
        if sequence is None:
            return True  # No watch: the old cadence.
        if sequence != self._last_sequence:
            if self._last_sequence is not None:
                self.touch(now)
            self._last_sequence = sequence
        return self._active_until is not None and now < self._active_until

    def interval(self, busy_s, idle_s, now=None):
        return busy_s if self.active(now) else idle_s * self.spread

    def due(self, sources, checked, interval, now=None):
        """The ordinary cadence; a left-out source is due at once once its
        conversation changed."""
        now = time.monotonic() if now is None else now
        if checked is None or now - checked >= interval - EARLY_S:
            return True
        if not self._skipped.intersection(sources):
            return False
        sequence = self.sequence(now)
        return sequence is not None and any(
            source in self._skipped and self._seen.get(source) != sequence for source in sources)

    def begin(self, source, force=False, now=None):
        """Whether to ask Core now; False when nothing new can be there."""
        now = time.monotonic() if now is None else now
        sequence = self.sequence(now)
        if (not force and sequence is not None and self._seen.get(source) == sequence and
                now - self._polled.get(source, float("-inf")) < FALLBACK_S * self.spread):
            self._skipped.add(source)
            return False
        self._skipped.discard(source)
        self._pending[source] = sequence
        self._polled[source] = now
        return True

    def done(self, source, found, now=None):
        """After a poll that succeeded. Found rows may have more behind them."""
        sequence = self._pending.pop(source, None)
        if found:
            self._seen.pop(source, None)
            self.touch(now)
        elif sequence is None:
            self._seen.pop(source, None)
        else:
            self._seen[source] = sequence

    def failed(self, source):
        self._pending.pop(source, None)
        self._seen.pop(source, None)
