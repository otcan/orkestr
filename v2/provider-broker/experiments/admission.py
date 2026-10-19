"""Native-free admission experiment; not imported by any product launcher.

The caller owns sockets, CONNECT parsing, destination authorization and cleanup.
This small model compares capacity policies without parsing encrypted traffic.
All deadlines use one caller-supplied monotonic clock. There is no idle eviction.
"""
from collections import deque
from dataclasses import dataclass


@dataclass(frozen=True)
class Limits:
    active: int = 8
    pending: int = 4
    queue_seconds: float = 2.0
    lifetime_seconds: float = 900.0
    tunnel_seconds: float = 900.0
    aggregate_bytes: int = 64 * 1024**2
    tunnel_bytes: int = 64 * 1024**2
    requests: int = 32


@dataclass
class Ticket:
    sequence: int
    accepted_at: float
    state: str = "pending"
    started_at: float | None = None
    bytes_reserved: int = 0


class Admission:
    """Serialized controller state. A trusted controller creates it once.

    Counts and aggregate byte usage survive tunnel closure. Reusing a socket or
    changing a peer identity cannot reset the budget. Pending sockets consume
    no upstream connection. Reserve bytes in either direction before forwarding.
    The owner must close sockets whose ticket changes out of active/pending.
    """

    def __init__(self, now=0.0, limits=Limits()):
        if any(value <= 0 for value in (
            limits.active, limits.queue_seconds, limits.lifetime_seconds,
            limits.tunnel_seconds, limits.aggregate_bytes, limits.tunnel_bytes,
            limits.requests,
        )) or limits.pending < 0:
            raise ValueError("invalid experiment limits")
        self.limits = limits
        self.created_at = self.now = now
        self.requests = self.bytes_reserved = 0
        self.active = {}
        self.pending = deque()
        self.closed = False
        self.peak_active = self.peak_pending = 0

    def advance(self, now):
        if now < self.now:
            raise ValueError("monotonic clock moved backwards")
        self.now = now
        if self.closed:
            return
        if now >= self.created_at + self.limits.lifetime_seconds:
            self.close("lifetime_expired")
            return
        for ticket in list(self.active.values()):
            if now >= ticket.started_at + self.limits.tunnel_seconds:
                ticket.state = "tunnel_expired"
                del self.active[ticket.sequence]
        retained = deque()
        for ticket in self.pending:
            if now >= ticket.accepted_at + self.limits.queue_seconds:
                ticket.state = "queue_expired"
            else:
                retained.append(ticket)
        self.pending = retained
        self._drain()

    def open(self, now):
        self.advance(now)
        if self.closed or self.requests >= self.limits.requests:
            return None
        self.requests += 1
        ticket = Ticket(self.requests, now)
        if len(self.active) < self.limits.active:
            self._activate(ticket)
        elif len(self.pending) < self.limits.pending:
            self.pending.append(ticket)
            self.peak_pending = max(self.peak_pending, len(self.pending))
        else:
            ticket.state = "queue_full"
        return ticket

    def finish(self, ticket, now, reason="finished"):
        # Cancellation precedes draining: a cancelled pending ticket never gains
        # a slot merely because this call also observes an available connection.
        if ticket.state == "active":
            self.active.pop(ticket.sequence)
        elif ticket.state == "pending":
            self.pending.remove(ticket)
        else:
            self.advance(now)
            return
        ticket.state = reason
        self.advance(now)

    def reserve(self, ticket, amount, now):
        self.advance(now)
        if type(amount) is not int or amount < 0:
            raise ValueError("invalid byte count")
        if ticket.state != "active":
            return False
        if amount > self.limits.aggregate_bytes - self.bytes_reserved:
            self.close("aggregate_bytes_exhausted")
            return False
        if amount > self.limits.tunnel_bytes - ticket.bytes_reserved:
            self.finish(ticket, now, "tunnel_bytes_exhausted")
            return False
        self.bytes_reserved += amount
        ticket.bytes_reserved += amount
        return True

    def close(self, reason="cancelled"):
        self.closed = True
        for ticket in (*self.active.values(), *self.pending):
            ticket.state = reason
        self.active.clear()
        self.pending.clear()

    def _activate(self, ticket):
        ticket.state = "active"
        ticket.started_at = self.now
        self.active[ticket.sequence] = ticket
        self.peak_active = max(self.peak_active, len(self.active))

    def _drain(self):
        while self.pending and len(self.active) < self.limits.active:
            self._activate(self.pending.popleft())
