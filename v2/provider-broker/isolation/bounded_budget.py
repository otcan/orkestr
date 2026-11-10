"""Explicit opt-in limits for the isolated no-plugin Codex candidate."""
from dataclasses import dataclass
import threading
import time


@dataclass(frozen=True)
class Limits:
    active: int = 8
    pending: int = 4
    setup_seconds: float = 2.0
    lifetime_seconds: float = 900.0
    tunnel_seconds: float = 900.0
    aggregate_bytes: int = 64 * 1024**2
    tunnel_bytes: int = 64 * 1024**2
    attempts: int = 32


LIMITS = Limits()


class Refused(Exception):
    """Fixed categories only; never attach caller/provider content."""


class CleanupIncomplete(Exception):
    """An owned resolver could not be reaped; owner must report failure."""


class Budget:
    """One trusted controller owns this across every replacement native.

    Locks cover both directions/all relays. Charge once before forwarding; no
    refund on close and no reset on peer/owner change. Request exhaustion blocks
    new admission, while byte/lifetime exhaustion cancels established streams.
    """
    def __init__(self, limits=LIMITS):
        self.limits = limits
        self.created = time.monotonic()
        self.lock = threading.RLock()
        self.stopped = threading.Event()
        self.attempts = self.bytes = 0
        self.reason = None

    def check(self):
        with self.lock:
            if time.monotonic() >= self.created + self.limits.lifetime_seconds:
                self.stop("lifetime")
            if self.stopped.is_set():
                raise Refused(self.reason)

    def attempt(self):
        with self.lock:
            self.check()
            if self.attempts >= self.limits.attempts:
                raise Refused("attempts")
            self.attempts += 1
            return self.attempts

    def reserve(self, context, amount):
        with self.lock:
            self.check()
            if amount > self.limits.aggregate_bytes - self.bytes:
                self.stop("aggregate_bytes")
                raise Refused("aggregate_bytes")
            if amount > self.limits.tunnel_bytes - context.bytes:
                raise Refused("tunnel_bytes")
            self.bytes += amount
            context.bytes += amount

    def stop(self, reason="cancelled"):
        with self.lock:
            self.reason = self.reason or reason
            self.stopped.set()


class Context:
    def __init__(self, client, budget, accepted_ns=None):
        self.client, self.budget = client, budget
        self.accepted_ns = time.monotonic_ns() if accepted_ns is None else accepted_ns
        self.deadline = self.accepted_ns / 1e9 + budget.limits.setup_seconds
        self.cancelled = threading.Event()
        self.lock = threading.RLock()
        self.sockets = [client]
        self.bytes = 0
        self.established = None
        self.prelude = bytearray()
        self.prelude_read = False
        self.done = threading.Event()
        self.outcome = "unknown"
        client.setblocking(False)

    def own(self, endpoint):
        with self.lock:
            if self.cancelled.is_set():
                endpoint.close()
                raise Refused("cancelled")
            self.sockets.append(endpoint)
            endpoint.setblocking(False)
            return endpoint

    def check(self):
        self.budget.check()
        if self.cancelled.is_set():
            raise Refused("cancelled")
        now = time.monotonic()
        deadline = self.deadline if self.established is None else (
            self.established + self.budget.limits.tunnel_seconds)
        if now >= deadline:
            raise Refused("setup_deadline" if self.established is None else "tunnel_deadline")

    def establish(self):
        self.check()
        self.established = time.monotonic()

    def close(self):
        with self.lock:
            self.cancelled.set()
            for endpoint in self.sockets:
                try:
                    endpoint.shutdown(2)
                except OSError:
                    pass
                endpoint.close()
