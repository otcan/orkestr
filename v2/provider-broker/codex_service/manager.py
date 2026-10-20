"""Root-owned persistent UI process and explicit bounded execution windows."""
import ctypes
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import threading
import time

from codex_bounded.trust import exists, process
from .budget import WindowBudget
from .channel import ServerPeer, bind_deadline, receive, respond
from .contract import BIND_REPLY_SECONDS, DRAIN_SECONDS, Refused, require
from .custody import OwnedSocket, StateLock
from .egress import Endpoint
from .ledger import Ledger
from .ownership import Children
from .package import Package


class Manager:
    def __init__(self, root, expected):
        require(os.geteuid() == 0, "root_manager_required")
        self.package = Package(root, expected)
        self.lock = self.ledger = self.control = None
        self.child = self.identity = self.peer = None
        self.children = self.egress = self.budget = None
        self.failed = self.closed = False
        try:
            self.lock = StateLock(self.package.ledger_directory)
            self.ledger = Ledger(self.lock.path, self.package.owner, self.package.conversation)
            self.control = OwnedSocket(self.package.control, self.package.gid, self.ledger, "control")
        except BaseException:
            self.close()
            raise

    def start(self):
        require(not self.closed and self.child is None, "manager_already_started")
        require(ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, "root_subreaper")
        package = self.package
        command = [str(Path("/usr/bin/python3").resolve()), "-I", "-S", "-B",
                   str(package.root / "codex_service/entry.py"), "server", str(os.getpid())]
        # Retain trusted server diagnostics; contained provider stderr remains closed.
        self.child = subprocess.Popen(command, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            cwd="/", user=package.uid, group=package.gid, extra_groups=[], close_fds=True,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=None,
            process_group=0)
        self.identity = process(self.child.pid)
        require(self.identity is not None and self.identity["ppid"] == os.getpid()
                and self.identity["uid"] == package.uid, "owned_server_identity")
        self.peer = ServerPeer(self.identity, package.root / "server")

    def _uncertain(self, reason):
        if self.ledger is not None:
            status = self.ledger.status()
            if status["state"] not in ("idle", "retired"):
                self.ledger.uncertain(status["window_id"], status["generation"], reason)

    def _close_egress(self):
        if self.budget is not None:
            self.budget.stop("window_closed")
        if self.egress is not None:
            self.egress.close()
            self.egress = None

    def _terminate_window(self):
        errors = []
        try:
            self._close_egress()
        except Exception:
            errors.append("egress_cleanup")
        if self.children is not None:
            try:
                if not self.children.cleanup() or self.children.forced:
                    errors.append("child_cleanup")
            except Exception:
                errors.append("child_cleanup")
        if errors:
            self._uncertain("cleanup_unknown")
        return not errors

    def _bind_deadline(self, request, accepted):
        self.ledger._scope(request)
        row = self.ledger.details(request["window_id"], request["generation"])
        require(row["conversation"] == request["conversation_id"], "scope")
        return bind_deadline(request["bind_deadline_ms"], accepted,
                             row["deadline_mono_ns"] / 1e9 - DRAIN_SECONDS)

    def dispatch(self, request, deadline=None):
        self.ledger._scope(request)
        operation = request["operation"]
        if operation == "status":
            return {"ok": True, "receipt": self.ledger.status(request["conversation_id"])}
        if operation == "admit":
            receipt, fresh = self.ledger.admit(request)
            if fresh:
                try:
                    require(self.egress is None, "previous_egress_owned")
                    if self.children is not None:
                        self.children.proven_gone()
                        self.children.close()
                    self.children = Children(self.package, self.identity)
                    self.budget = WindowBudget(self.ledger, receipt["window_id"], receipt["generation"])
                    owned = OwnedSocket(self.package.endpoint, self.package.gid, self.ledger, "egress")
                    self.egress = Endpoint(self.package, owned, self.budget, self.children)
                    self.egress.thread.start()
                except Exception:
                    self._uncertain("runtime_refused")
                    self._terminate_window()
                    raise Refused("window_initialization") from None
            return {"ok": True, "receipt": receipt, "fresh_window": fresh}
        row = self.ledger.details(request["window_id"], request["generation"])
        require(row["conversation"] == request["conversation_id"], "scope")
        if operation == "bind_child":
            status = self.ledger.tick(request["window_id"], request["generation"])
            require(status["state"] == "active" and self.children is not None
                    and self.egress is not None, "window_not_accepting_children")
            try:
                if deadline is None:
                    deadline = self._bind_deadline(request, time.monotonic())
                fresh = self.children.bind(request["broker_pid"], request["broker_start"],
                                           deadline - BIND_REPLY_SECONDS)
            except Exception:
                self._uncertain("cleanup_unknown")
                self._terminate_window()
                raise Refused("broker_binding") from None
            return {"ok": True, "receipt": self.ledger.status(request["conversation_id"]), "fresh_child": fresh}
        if operation == "drain":
            return {"ok": True, "receipt": self.ledger.drain(request["window_id"], request["generation"])}
        if operation == "uncertain":
            self.ledger.uncertain(request["window_id"], request["generation"], request["reason"])
            self._terminate_window()
            return {"ok": True, "receipt": self.ledger.status(request["conversation_id"])}
        require(operation == "retire", "operation")
        if row["state"] != "retired":
            require(self.children is not None, "original_cleanup_proof_missing")
            self.children.proven_gone()
            self._close_egress()
            # Metadata-only exact Core proof after original observed child reap.
            # This remains legal after normal expiry; uncertainty never recovers.
        return {"ok": True, "receipt": self.ledger.retire(request)}

    def tick(self):
        require(self.child is not None, "server_not_started")
        if self.child.poll() is not None and not self.closed:
            self.failed = True  # Even exit0 is unexpected outside close().
            self._uncertain("server_lost")
            raise Refused("unexpected_server_exit")
        if self.children is not None:
            self.children.observe()
        status = self.ledger.status()
        if status["state"] in ("active", "draining", "expired"):
            try:
                status = self.ledger.tick(status["window_id"], status["generation"])
            except Refused:
                status = self.ledger.status()
            if status["state"] in ("expired", "reconciliation"):
                self._terminate_window()
        if self.egress is not None and self.egress.failed:
            self._uncertain("cleanup_unknown")
            self._terminate_window()

    def once(self):
        self.tick()
        try:
            connection, _ = self.control.socket.accept()
        except socket.timeout:
            return
        with connection:
            # A foreign same-UID process receives no parser or status oracle.
            if not self.peer.accepts(connection):
                return
            accepted = time.monotonic()
            deadline = accepted + 1
            try:
                request = receive(connection, deadline)
                if request["operation"] == "bind_child":
                    deadline = self._bind_deadline(request, accepted)
                answer = self.dispatch(request, deadline)
            except Refused:
                answer = {"ok": False, "code": "control_refused", "receipt": self.ledger.status()}
            except (OSError, ValueError):
                answer = {"ok": False, "code": "control_unavailable"}
            try:
                respond(connection, answer, deadline)
            except (OSError, Refused):
                pass  # A lost ACK never resets a committed admission/reservation.

    def close(self):
        self.closed = True
        errors = []
        # Runtime first receives ordinary shutdown and has its cleanup margin.
        # systemd KillMode=mixed gives the root manager ordered ownership here.
        if self.child is not None:
            try:
                if self.child.poll() is None:
                    self.child.send_signal(signal.SIGINT)
                    deadline = time.monotonic() + 30
                    # Keep the private control channel responsive so Runtime can
                    # commit exact retirement while shutting down its owned task.
                    while self.child.poll() is None and time.monotonic() < deadline:
                        self.once()
                    if self.child.poll() is None:
                        self.failed = True
                        self.child.kill()
                        self.child.wait(3)
                if self.child.returncode != 0:
                    self.failed = True
                require(not exists(self.identity), "server_not_reaped")
            except Exception:
                errors.append("server_cleanup")
        try:
            self._uncertain("manager_stopped")
            if not self._terminate_window():
                errors.append("window_cleanup")
        except Exception:
            errors.append("window_cleanup")
        if self.children is not None:
            self.children.close()
        for item in (self.control, self.ledger, self.lock):
            if item is not None:
                try:
                    item.close()
                except Exception:
                    errors.append("state_cleanup")
        self.failed = self.failed or bool(errors)
        return not self.failed


def main(root, expected):
    os.umask(0o077)
    manager = None
    stopped = threading.Event()
    previous = {}
    failed = False
    try:
        for number in (signal.SIGTERM, signal.SIGINT):
            previous[number] = signal.signal(number, lambda *_args: stopped.set())
        manager = Manager(root, expected)
        manager.start()
        while not stopped.is_set():
            manager.once()
    except Exception:
        failed = True
    finally:
        if manager is not None:
            try:
                failed = not manager.close() or failed
            except Exception:
                failed = True
        print(json.dumps({"service_stopped": True, "clean_shutdown": not failed}))
        for number, handler in previous.items():
            signal.signal(number, handler)
    return 2 if failed else 0
