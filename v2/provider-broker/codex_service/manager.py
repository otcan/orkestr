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
from .channel import ServerPeer, bind_deadline, receive, respond
from .contract import BIND_REPLY_SECONDS, DRAIN_SECONDS, Refused, require
from .custody import OwnedSocket, StateLock
from .egress import Endpoint, Window
from .ledger import Ledger
from .package import Package


class Manager:
    def __init__(self, root, expected):
        require(os.geteuid() == 0, "root_manager_required")
        self.package = Package(root, expected)
        self.lock = self.ledger = self.control = None
        self.child = self.identity = self.peer = self.egress = None
        self.windows = {}
        self.guard = threading.RLock()
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

    def _uncertain(self, window, generation, reason):
        try:
            self.ledger.uncertain(window, generation, reason)
        except Refused:
            pass  # Retired or superseded rows keep their committed outcome.

    def _uncertain_all(self, reason):
        if self.ledger is not None:
            for status in self.ledger.unfinished():
                self._uncertain(status["window_id"], status["generation"], reason)

    def _close_egress(self, window):
        endpoint = None
        with self.guard:
            window.close_egress()
            if self.egress is not None and not any(
                    not other.egress_closed for other in self.windows.values()):
                endpoint, self.egress = self.egress, None
        if endpoint is not None:
            # Join outside the guard: the listener takes it on every loop.
            endpoint.close()

    def _terminate(self, window):
        """Emergency cleanup of one window; others keep their custody."""
        errors = []
        try:
            self._close_egress(window)
        except Exception:
            errors.append("egress_cleanup")
        try:
            if not window.children.cleanup() or window.children.forced:
                errors.append("child_cleanup")
        except Exception:
            errors.append("child_cleanup")
        if errors:
            self._uncertain(window.window, window.generation, "cleanup_unknown")
        return not errors

    def _terminate_all(self):
        return all([self._terminate(window) for window in list(self.windows.values())])

    def _open(self, receipt):
        window = None
        try:
            with self.guard:
                window = Window(self.package, self.identity, self.ledger,
                                receipt["window_id"], receipt["generation"])
                self.windows[receipt["window_id"]] = window
                if self.egress is None:
                    owned = OwnedSocket(self.package.endpoint, self.package.gid, self.ledger, "egress")
                    self.egress = Endpoint(self.package, owned, self.windows, self.guard)
                    self.egress.thread.start()
        except Exception:
            self._uncertain(receipt["window_id"], receipt["generation"], "runtime_refused")
            if window is not None:
                self._terminate(window)
            raise Refused("window_initialization") from None

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
                require(receipt["window_id"] not in self.windows, "previous_custody_owned")
                self._open(receipt)
            return {"ok": True, "receipt": receipt, "fresh_window": fresh}
        row = self.ledger.details(request["window_id"], request["generation"])
        require(row["conversation"] == request["conversation_id"], "scope")
        window = self.windows.get(request["window_id"])
        if operation == "bind_child":
            status = self.ledger.tick(request["window_id"], request["generation"])
            require(status["state"] == "active" and window is not None and not window.egress_closed
                    and self.egress is not None, "window_not_accepting_children")
            try:
                if deadline is None:
                    deadline = self._bind_deadline(request, time.monotonic())
                fresh = window.children.bind(request["broker_pid"], request["broker_start"],
                                             deadline - BIND_REPLY_SECONDS)
            except Exception:
                self._uncertain(window.window, window.generation, "cleanup_unknown")
                self._terminate(window)
                raise Refused("broker_binding") from None
            return {"ok": True, "receipt": self.ledger.status(request["conversation_id"]), "fresh_child": fresh}
        if operation == "drain":
            return {"ok": True, "receipt": self.ledger.drain(request["window_id"], request["generation"])}
        if operation == "uncertain":
            self.ledger.uncertain(request["window_id"], request["generation"], request["reason"])
            if window is not None:
                self._terminate(window)
            return {"ok": True, "receipt": self.ledger.status(request["conversation_id"])}
        require(operation == "retire", "operation")
        if row["state"] != "retired":
            require(window is not None, "original_cleanup_proof_missing")
            window.children.proven_gone()
            self._close_egress(window)
            # Metadata-only exact Core proof after original observed child reap.
            # This remains legal after normal expiry; uncertainty never recovers.
        receipt = self.ledger.retire(request)
        if window is not None:
            with self.guard:
                self.windows.pop(window.window, None)
            window.children.close()
        return {"ok": True, "receipt": receipt}

    def tick(self):
        require(self.child is not None, "server_not_started")
        if self.child.poll() is not None and not self.closed:
            self.failed = True  # Even exit0 is unexpected outside close().
            self._uncertain_all("server_lost")
            raise Refused("unexpected_server_exit")
        for window in list(self.windows.values()):
            window.children.observe()
        for status in self.ledger.unfinished():
            try:
                status = self.ledger.tick(status["window_id"], status["generation"])
            except Refused:
                status = self.ledger.status(status["conversation_id"])
            window = self.windows.get(status["window_id"])
            if status["state"] in ("expired", "reconciliation") and window is not None:
                self._terminate(window)
        if self.egress is not None and self.egress.failed:
            # The shared listener failed: every live window loses its relay.
            for window in list(self.windows.values()):
                if not window.egress_closed:
                    self._uncertain(window.window, window.generation, "cleanup_unknown")
            self._terminate_all()

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
            self._uncertain_all("manager_stopped")
            if not self._terminate_all():
                errors.append("window_cleanup")
        except Exception:
            errors.append("window_cleanup")
        if self.egress is not None:
            try:
                endpoint, self.egress = self.egress, None
                endpoint.close()
            except Exception:
                errors.append("window_cleanup")
        for window in list(self.windows.values()):
            window.children.close()
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
