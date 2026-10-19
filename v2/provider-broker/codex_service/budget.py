"""Existing opaque relay contract, backed by conservative durable credits."""
import threading
import time
import uuid

from isolation.bounded_budget import LIMITS, Refused
from .contract import CREDIT_BYTES, Refused as LedgerRefused


class WindowBudget:
    def __init__(self, ledger, window, generation):
        self.ledger, self.window, self.generation = ledger, window, generation
        row = ledger.details(window, generation)
        if row["state"] not in ("active", "draining"):
            raise Refused("window_closed")
        # Never construct this from a recovered/old spent window. Manager owns
        # the sole live instance, created only by a fresh admit transition.
        self.limits = LIMITS
        self.created = row["deadline_mono_ns"] / 1e9 - LIMITS.lifetime_seconds
        self.lock = threading.RLock()
        self.stopped = threading.Event()
        self.attempts = row["attempts"]
        self.reserved = row["reserved_bytes"]
        self.bytes = self.reserved  # Existing reservations cannot become free credit.
        self.reason = None
        self._last_tick = 0.0
        self._row = row

    def check(self):
        with self.lock:
            if self.stopped.is_set():
                raise Refused(self.reason)
            boot, wall, mono = self.ledger.clock.sample()
            if (boot != self._row["boot"] or wall < self._row["created_wall_ns"] or
                    wall >= self._row["deadline_wall_ns"] or mono >= self._row["deadline_mono_ns"]):
                self.ledger.uncertain(self.window, self.generation, "clock_changed")
                self.stop("window_clock")
                raise Refused("window_clock")
            now = time.monotonic()
            if now - self._last_tick >= 0.1:
                row = self.ledger.tick(self.window, self.generation)
                self._last_tick = now
                if row["state"] not in ("active", "draining"):
                    self.stop("window_closed")
                    raise Refused("window_closed")

    def attempt(self):
        with self.lock:
            self.check()
            try:
                self.attempts = self.ledger.reserve(self.window, self.generation,
                    str(uuid.uuid4()), "attempt", 1)
                return self.attempts
            except LedgerRefused as error:
                raise Refused(str(error)) from None

    def reserve(self, context, amount):
        with self.lock:
            self.check()
            if type(amount) is not int or not 0 < amount <= CREDIT_BYTES:
                raise Refused("chunk_bound")
            if amount > self.limits.tunnel_bytes - context.bytes:
                raise Refused("tunnel_bytes")
            if amount > self.reserved - self.bytes:
                try:
                    self.reserved = self.ledger.reserve(self.window, self.generation,
                        str(uuid.uuid4()), "bytes", CREDIT_BYTES)
                except LedgerRefused as error:
                    self.stop("aggregate_bytes")
                    raise Refused(str(error)) from None
            self.bytes += amount
            context.bytes += amount
            # The credit COMMIT has completed before relay() can forward bytes.
            # Incomplete sends and unused credits are never refunded.

    def stop(self, reason="cancelled"):
        with self.lock:
            self.reason = self.reason or reason
            self.stopped.set()
