"""One adapter-wide HTTP bound, including a slot for a foreground turn."""
from contextlib import contextmanager
import threading
import time

MAX_EXCHANGES = 8
MAX_QUEUE_S = 0.25


class Permit:
    def __init__(self, gate, background):
        self.gate, self.background = gate, background

    def release(self):
        if self.gate is not None:
            gate, self.gate = self.gate, None
            gate.active.release()
            if self.background:
                gate.background.release()


class OutboundGate:
    def __init__(self):
        self.active = threading.BoundedSemaphore(MAX_EXCHANGES)
        self.background = threading.BoundedSemaphore(MAX_EXCHANGES - 1)
        self.local = threading.local()

    @contextmanager
    def foreground(self):
        previous = getattr(self.local, "foreground", False)
        self.local.foreground = True
        try:
            yield
        finally:
            self.local.foreground = previous

    def acquire(self, deadline):
        """No network/proof work starts until both required slots are held."""
        until = min(deadline, time.monotonic() + MAX_QUEUE_S)
        background = not getattr(self.local, "foreground", False)
        remaining = lambda: max(0, until - time.monotonic())
        if background and not self.background.acquire(timeout=remaining()):
            return None
        try:
            acquired = self.active.acquire(timeout=remaining())
        except BaseException:
            if background:
                self.background.release()
            raise
        if not acquired:
            if background:
                self.background.release()
            return None
        if time.monotonic() >= deadline:
            self.active.release()
            if background:
                self.background.release()
            return None
        return Permit(self, background)
