"""Admitted windows; only source-pinned supervisors of bound brokers enter.

Each window owns its original child set, durable budget and relay pool. One
listener serves every live window and routes an authenticated peer only to the
window whose bound broker owns it; no window can spend another window's budget.
"""
import socket
import struct
import threading
import time
from codex_bounded.peer import authenticate
from codex_bounded.configuration import HOSTS
from isolation.bounded_budget import Context
from isolation.bounded_pool import Pool
from isolation.bounded_proxy import outer
from .budget import WindowBudget
from .contract import require
from .ownership import Children


class Window:
    """One admitted window's private custody. Never shared across windows."""
    def __init__(self, package, server, ledger, window, generation):
        self.window, self.generation = window, generation
        self.children = Children(package, server)
        self.budget = WindowBudget(ledger, window, generation)
        self.pool = Pool(lambda context: outer(context, HOSTS), self.budget, outer=True)
        self.egress_closed = False

    def close_egress(self):
        """Stop this window's relay; caller holds the shared endpoint lock."""
        if not self.egress_closed:
            self.egress_closed = True
            self.budget.stop("window_closed")
            self.pool.retire()


class Endpoint:
    def __init__(self, package, owned_socket, windows, lock):
        self.package, self.owned_socket = package, owned_socket
        self.windows, self.lock = windows, lock
        self.stopped = threading.Event()
        self.failed = False
        self.thread = threading.Thread(target=self.run, name="codex-window-egress")

    def live(self):
        return [window for window in self.windows.values() if not window.egress_closed]

    def route(self, pid):
        with self.lock:
            for window in self.live():
                broker = window.children.broker_for(pid)
                if broker:
                    return window, broker
        return None, None

    def run(self):
        try:
            while not self.stopped.is_set():
                with self.lock:
                    for window in self.live():
                        window.pool.poll()
                try:
                    connection, _ = self.owned_socket.socket.accept()
                except socket.timeout:
                    continue
                except OSError:
                    if self.stopped.is_set():
                        break
                    raise
                accepted = time.monotonic_ns()
                try:
                    pid, _uid, _gid = struct.unpack("3i", connection.getsockopt(
                        socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    window, broker = self.route(pid)
                    identity = authenticate(connection, self.package, broker) if broker else None
                    if identity is None:
                        connection.close()
                        continue
                    with self.lock:
                        if window.egress_closed:
                            connection.close()
                            continue
                        window.children.remember(identity)
                        window.pool.submit(Context(connection, window.budget, accepted))
                except BaseException:
                    connection.close()
                    raise
        except Exception:
            self.failed = True

    def close(self):
        self.stopped.set()
        self.owned_socket.socket.close()
        if self.thread.ident:
            self.thread.join(3)
        require(not self.thread.is_alive() and not self.failed, "egress_cleanup_incomplete")
        self.owned_socket.close()
