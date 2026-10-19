"""One root endpoint epoch; aggregate authority belongs to the owning controller."""
import socket
import threading
import time
from .configuration import HOSTS
from .peer import authenticate
from .trust import require
from isolation.bounded_budget import Context
from isolation.bounded_pool import Pool
from isolation.bounded_proxy import outer


class Endpoint:
    def __init__(self, package, owner, listener, budget):
        self.package, self.owner, self.listener = package, dict(owner), listener
        self.budget = budget
        self.pool = Pool(lambda context: outer(context, HOSTS), budget, outer=True)
        self.stopped = threading.Event()
        self.accepted = self.peer_refused = self.admission_refused = 0
        self.failed = False
        self.thread = threading.Thread(target=self.run, name="selected-codex-egress")

    def run(self):
        try:
            while not self.stopped.is_set():
                self.pool.poll()
                try:
                    connection, _ = self.listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    if self.stopped.is_set():
                        break
                    raise
                accepted_ns = time.monotonic_ns()
                try:
                    identity = authenticate(connection, self.package, self.owner)
                except BaseException:
                    connection.close()
                    raise
                if identity is None:
                    self.peer_refused += 1
                    connection.close()
                    continue
                self.accepted += 1
                context = Context(connection, self.budget, accepted_ns)
                if not self.pool.submit(context):
                    self.admission_refused += 1
        except Exception:
            self.failed = True

    def close(self):
        self.stopped.set()
        self.listener.close()
        if self.thread.ident:
            self.thread.join(3)
        # Also attempted when the accept thread fails; no shared-budget refund.
        self.pool.retire()
        require(not self.thread.is_alive() and not self.failed, "egress_cleanup_incomplete")

    def snapshot(self):
        return {"accepted": self.accepted, "peer_refused": self.peer_refused,
                "admission_refused": self.admission_refused, "peak_active": self.pool.peak_active,
                "peak_pending": self.pool.peak_pending, "attempts": self.budget.attempts,
                "combined_bytes": self.budget.bytes, "created_monotonic": self.budget.created}
