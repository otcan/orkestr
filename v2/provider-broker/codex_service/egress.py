"""One admitted window; only source-pinned supervisors of bound brokers enter."""
import socket
import struct
import threading
import time
from codex_bounded.peer import authenticate
from codex_bounded.configuration import HOSTS
from isolation.bounded_budget import Context
from isolation.bounded_pool import Pool
from isolation.bounded_proxy import outer
from .contract import require


class Endpoint:
    def __init__(self, package, owned_socket, budget, children):
        self.package, self.owned_socket = package, owned_socket
        self.budget, self.children = budget, children
        self.pool = Pool(lambda context: outer(context, HOSTS), budget, outer=True)
        self.stopped = threading.Event()
        self.failed = False
        self.thread = threading.Thread(target=self.run, name="codex-window-egress")

    def run(self):
        try:
            while not self.stopped.is_set():
                self.pool.poll()
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
                    broker = self.children.broker_for(pid)
                    identity = authenticate(connection, self.package, broker) if broker else None
                    if identity is None:
                        connection.close()
                        continue
                    self.children.remember(identity)
                    self.pool.submit(Context(connection, self.budget, accepted))
                except BaseException:
                    connection.close()
                    raise
        except Exception:
            self.failed = True

    def close(self):
        self.stopped.set()
        self.budget.stop("window_closed")
        self.owned_socket.socket.close()
        if self.thread.ident:
            self.thread.join(3)
        self.pool.retire()
        require(not self.thread.is_alive() and not self.failed, "egress_cleanup_incomplete")
        self.owned_socket.close()
