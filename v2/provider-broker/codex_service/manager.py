"""Root-owned persistent UI process and explicit bounded execution windows."""
import ctypes
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import sys
import subprocess
import threading
import time
import traceback

from codex_bounded.trust import exists, process
from .channel import ServerPeer, bind_deadline, receive, receive_control, respond
from .contract import BIND_REPLY_SECONDS, DRAIN_SECONDS, Refused, require
from .custody import OwnedSocket, StateLock
from .egress import Endpoint, Window
from .ledger import Ledger
from .package import Package

# Idle pace of the control loop. A waiting control request is accepted at once;
# custody housekeeping (server exit, descendant tree walk over /proc, window
# deadlines) runs at most once per TICK_S instead of on every 50 ms accept
# timeout, which kept the manager at a quarter of a core while idle.
TICK_S = 0.25
# A busy ledger (sqlite "database is locked" past its 0.5 s timeout, seen when
# the host is starved of CPU/IO) only delays custody housekeeping: every pass
# re-reads the ledger and repeats idempotently. It is tolerated this long
# before the manager stops as before (2026-11-03: one such pass under load
# tore the whole service down with exit 2 and no logged cause).
TICK_BUSY_GRACE_S = 30.0
MANAGED_REPLY_SECONDS = 5


def report(event, error):
    """One operator line plus the traceback; never request values."""
    sys.stderr.write("manager %s: %s: %s\n" % (event, type(error).__name__, str(error)[:200]))
    traceback.print_exception(error, file=sys.stderr)
    sys.stderr.flush()


class Manager:
    tick_busy_since = None  # Monotonic start of consecutive busy-ledger passes.
    tick_busy_passes = 0
    ticked = None  # Monotonic time of the last custody housekeeping pass.

    def __init__(self, root, expected):
        require(os.geteuid() == 0, "root_manager_required")
        self.package = Package(root, expected)
        self.lock = self.ledger = self.control = None
        self.child = self.identity = self.peer = self.egress = None
        self.windows = {}
        self.guard = threading.RLock()
        self.failed = self.closed = False
        self.launcher = None
        self.desk = None
        self.workspace_projects = None
        self.workspace_commands = None
        self.managed = None
        self.service_peer = None
        self.adopted = None
        self.custody_fault = False
        try:
            self.lock = StateLock(self.package.ledger_directory)
            self.ledger = Ledger(self.lock.path, self.package.owner, self.package.conversation)
            self.control = OwnedSocket(self.package.control, self.package.gid, self.ledger, "control", TICK_S)
            if self.package.runtime.get('desk_login'):
                from .desk_operations import Operations
                self.desk=Operations(self.package)
            if self.package.runtime.get('managed_operations'):
                from .managed_ingress import Ingress
                self.managed=Ingress(self)
        except BaseException:
            self.close()
            raise

    def start(self):
        require(not self.closed and self.child is None, "manager_already_started")
        require(ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, "root_subreaper")
        package = self.package
        from .qualification import start
        self.qualification = start(package)
        command = [str(Path("/usr/bin/python3").resolve()), "-I", "-S", "-B",
                   str(package.root / "codex_service/entry.py"), "server", str(os.getpid())]
        # Host full access (operator opt-in) keeps the service user's real
        # supplementary groups, like V1 executors; otherwise none.
        groups = []
        if type(package.beta.get("host_full_access")) is dict:
            import pwd
            groups = [g for g in os.getgrouplist(pwd.getpwuid(package.uid).pw_name, package.gid)
                      if g != package.gid]
        # Retain trusted server diagnostics; contained provider stderr remains closed.
        self.child = subprocess.Popen(command, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            cwd="/", user=package.authority_uid, group=package.authority_gid, extra_groups=groups, close_fds=True,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=None,
            process_group=0)
        self.identity = process(self.child.pid)
        require(self.identity is not None and self.identity["ppid"] == os.getpid()
                and self.identity["uid"] == package.authority_uid, "owned_server_identity")
        self.peer = ServerPeer(self.identity, package.root / "server")
        if self.qualification is not None:
            self.qualification.core_identity = self.identity
            package.qualification = self.qualification
        self.publish_service_peer()

    def publish_service_peer(self):
        require(not self.closed and self.service_peer is None and self.peer is not None,"http_peer_already_published")
        from .manager_service_peer import Publisher
        self.service_peer=Publisher(self.package,self.child,self.identity)

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

    def _terminate(self, window, wait=2):
        """Emergency cleanup of one window; others keep their custody."""
        errors = []
        if getattr(self,'workspace_commands',None):self.workspace_commands.cancel_window(window.window)
        if getattr(self,'desk',None):
            for operation,handle in self.desk.active.items():
                if handle['window']==window.window:self.desk.cancel(operation)
        try:
            self._close_egress(window)
        except Exception:
            errors.append("egress_cleanup")
        try:
            if not window.children.cleanup(wait) or window.children.forced:
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

    def _observation_deadline(self, request, accepted):
        self.ledger._scope(request)
        row = self.ledger.details(request["window_id"], request["generation"])
        require(row["conversation"] == request["conversation_id"], "scope")
        work = row["deadline_mono_ns"] / 1e9 - DRAIN_SECONDS
        # Cleanup may still observe a cancelled operation after work ended.
        # Keep that existing one-second bound inside the original cleanup end.
        if request.get("operation") == "managed_poll" and time.monotonic() >= work:
            deadline = min(accepted + 1, row["deadline_mono_ns"] / 1e9)
        else:
            deadline = min(accepted + MANAGED_REPLY_SECONDS, work)
        require(time.monotonic() < deadline, "observation_deadline")
        return deadline

    def _package_preflight(self):
        try:
            self.package.verify_inventory()
        except Exception:
            # Diagnostics can accidentally leave root-owned bytecode in a
            # running release. Refuse before waiting for a child handshake,
            # with one value-free operator alert per invalid episode.
            if not getattr(self, "inventory_alerted", False):
                sys.stderr.write("ALERT orkestr-v2-manager package_inventory_invalid\n")
                sys.stderr.flush()
                self.inventory_alerted = True
            raise Refused("package_inventory") from None
        self.inventory_alerted = False

    def dispatch(self, request, deadline=None, descriptors=()):
        self.ledger._scope(request)
        operation = request["operation"]
        from .qualification import guard
        guard(self, operation)
        self._capture_orphans()
        require(not getattr(self,'custody_fault',False) or operation in ('status','drain','uncertain','desk_login_poll','desk_login_cancel','managed_poll','managed_cancel','managed_run_close',
                    'workspace_command_receipt','workspace_command_cancel'),
                'manager_custody_fault')
        if operation == "status":
            return {"ok": True, "receipt": self.ledger.status(request["conversation_id"])}
        if operation == 'workspace_attest':
            from .workspace_setup import dispatch
            return dispatch(self,request,descriptors)
        if operation == "admit":
            self._package_preflight()
            receipt, fresh = self.ledger.admit(request)
            if fresh:
                require(receipt["window_id"] not in self.windows, "previous_custody_owned")
                self._open(receipt)
            return {"ok": True, "receipt": receipt, "fresh_window": fresh}
        row = self.ledger.details(request["window_id"], request["generation"])
        require(row["conversation"] == request["conversation_id"], "scope")
        window = self.windows.get(request["window_id"])
        if operation in ('workspace_command','workspace_command_receipt','workspace_command_cancel'):
            from .workspace_ops import dispatch
            return dispatch(self,request,window,descriptors)
        if operation in ('managed_pending','managed_consume','managed_poll','managed_cancel','managed_run_open','managed_run_close','managed_renew','managed_result','managed_worker_reply','managed_worker_bind'):
            from .managed_control import dispatch
            return dispatch(self,request,window)
        if operation in ('desk_login','desk_login_poll','desk_login_cancel'):
            from .desk_operations import dispatch
            return dispatch(self,request,window)
        if operation == "launch_child":
            require(self.package.identity_split and window is not None and not window.egress_closed
                    and self.ledger.tick(request["window_id"], request["generation"])["state"] == "active",
                    "split_launch_window")
            self._package_preflight()
            if self.launcher is None:
                from .launch import Launcher
                self.launcher = Launcher(self.package, self.identity)
            try:
                if deadline is None:
                    deadline = self._bind_deadline(request, time.monotonic())
                receipt = self.launcher.launch(request, descriptors,
                    lambda proof: window.children.bind_managed(proof, window.window, window.generation), deadline)
            except BaseException:
                self._uncertain(window.window, window.generation, "cleanup_unknown")
                self._terminate(window, wait=0.25)
                raise
            return {"ok": True, "receipt": self.ledger.status(request["conversation_id"]), "launch": receipt}
        if operation == "bind_child":
            status = self.ledger.tick(request["window_id"], request["generation"])
            require(status["state"] == "active" and window is not None and not window.egress_closed
                    and self.egress is not None, "window_not_accepting_children")
            try:
                self._package_preflight()
                if deadline is None:
                    deadline = self._bind_deadline(request, time.monotonic())
                fresh = window.children.bind(request["broker_pid"], request["broker_start"],
                                             deadline - BIND_REPLY_SECONDS)
            except Exception:
                self._uncertain(window.window, window.generation, "cleanup_unknown")
                # The refused broker is the waiting server's child: it cannot be
                # reaped before this reply, so a long wait here only stalls every
                # other conversation's control request. Reconcile re-checks reap.
                self._terminate(window, wait=0.25)
                raise Refused("broker_binding") from None
            return {"ok": True, "receipt": self.ledger.status(request["conversation_id"]), "fresh_child": fresh}
        if operation == "extend":
            require(window is not None and not window.egress_closed, "window_not_extendable")
            return {"ok": True, "receipt": self.ledger.extend(request)}
        if operation == "drain":
            return {"ok": True, "receipt": self.ledger.drain(request["window_id"], request["generation"])}
        if operation == "uncertain":
            self.ledger.uncertain(request["window_id"], request["generation"], request["reason"])
            if window is not None:
                self._terminate(window)
            return {"ok": True, "receipt": self.ledger.status(request["conversation_id"])}
        if operation == "reconcile":
            require(not getattr(self,'workspace_commands',None) or self.workspace_commands.window_clean(request['window_id']),'workspace_cleanup_unknown')
            require(not getattr(self,'desk',None) or self.desk.window_clean(request['window_id']),'desk_cleanup_unknown')
            if row["state"] != "retired" and window is not None:
                # This window still has custody in this manager (same manager
                # life). Runtime reconciles only a window its own task no
                # longer owns (for example a failed broker bind or Fast setup)
                # after Core committed the audited decision. Close what is
                # still open here first, exactly like an uncertainty report,
                # so the conversation recovers without a manager restart.
                # Every original child must still be reaped; uncertain cleanup
                # is never promoted. A fresh manager never holds custody of a
                # previous life's window. An exact replay of a retired record
                # needs no custody check.
                if not window.egress_closed:
                    self._uncertain(window.window, window.generation, "runtime_refused")
                    self._terminate(window)
                require(window.egress_closed, "window_egress_owned")
                try:
                    released = window.children.released()
                except Exception:
                    self._cleanup_notice(window)
                    raise
                if not released:
                    self._cleanup_notice(window)
                    require(not window.children.uncertain, "owned_cleanup_uncertain")
                    require(False, "owned_child_not_reaped")
            self._capture_orphans()
            require(not getattr(self,'custody_fault',False),'manager_custody_fault')
            receipt = self.ledger.reconcile(request)
            if window is not None:
                with self.guard:
                    self.windows.pop(window.window, None)
                window.children.close()
            return {"ok": True, "receipt": receipt}
        require(operation == "retire", "operation")
        require(not getattr(self,'workspace_commands',None) or self.workspace_commands.window_clean(request['window_id']),'workspace_cleanup_unknown')
        require(not getattr(self,'desk',None) or self.desk.window_clean(request['window_id']),'desk_cleanup_unknown')
        if row["state"] != "retired":
            require(window is not None, "original_cleanup_proof_missing")
            window.children.proven_gone()
            self._close_egress(window)
            # Metadata-only exact Core proof after original observed child reap.
            # This remains legal after normal expiry; uncertainty never recovers.
        self._capture_orphans()
        require(not getattr(self,'custody_fault',False),'manager_custody_fault')
        receipt = self.ledger.retire(request)
        if window is not None:
            with self.guard:
                self.windows.pop(window.window, None)
            window.children.close()
        return {"ok": True, "receipt": receipt}

    @staticmethod
    def _cleanup_notice(window):
        children = window.children
        reason = (getattr(children, "uncertainty_reason", None) or "owned_child_observation") \
            if getattr(children, "uncertain", False) else "owned_child_not_reaped"
        # Once per changed condition, with scope IDs and a closed reason only.
        signature = (reason, bool(children.forced))
        if getattr(window, "cleanup_notice", None) != signature:
            window.cleanup_notice = signature
            sys.stderr.write("manager window cleanup refused: window=%s generation=%d reason=%s forced=%d\n" %
                             (window.window, window.generation, reason, bool(children.forced)))
            sys.stderr.flush()

    def _known_children(self):
        known={(self.identity['pid'],self.identity['start'])} if self.identity else set()
        for window in self.windows.values():known.update(window.children.records)
        if self.launcher:
            known.update(self.launcher.proxies)
            known.update((h.broker['pid'],h.broker['start']) for h in self.launcher.children.values())
        if getattr(self,'desk',None):known.update((h['identity']['pid'],h['identity']['start']) for h in self.desk.active.values() if h['identity'])
        if getattr(self,'workspace_commands',None):known.update((h['identity']['pid'],h['identity']['start']) for h in self.workspace_commands.active.values() if h['identity'])
        return known

    def _desk_window_active(self,window_id,generation):
        window=self.windows.get(window_id)
        return bool(not self.closed and window and not window.egress_closed and
                    self.ledger.tick(window_id,generation)['state']=='active' and exists(self.identity))

    def _capture_orphans(self):
        if not getattr(getattr(self,'package',None),'identity_split',False) or not self.identity:return
        if self.adopted is None:
            from .ownership import Adopted
            self.adopted=Adopted(self.package)
        known=self._known_children()
        if self.adopted.capture(known):
            self.failed=self.custody_fault=True
            if self.launcher:self.launcher.fault()
            if getattr(self,'desk',None):self.desk.fault()
            if getattr(self,'workspace_commands',None):self.workspace_commands.fault()
            self._uncertain_all('cleanup_unknown')
            for window in self.windows.values():
                window.children._observation_failed(Refused('owned_child_association_unknown'))
                self._terminate(window,wait=0)
        if self.adopted.records:
            require(self.adopted.drain(known),'adopted_children_not_reaped')

    def tick(self):
        if not self.closed and getattr(self, "qualification", None) is not None:
            self.qualification.observe(self.identity)
        if getattr(self,'workspace_commands',None):self.workspace_commands.tick(self._desk_window_active)
        if getattr(self,'desk',None):self.desk.tick(self._desk_window_active)
        if getattr(self,'managed',None):
            from .managed_control import tick
            tick(self.managed);self.managed.tick()
        self._capture_orphans()
        if getattr(self, "launcher", None) is not None:
            def released(window_id, generation, broker):
                window=self.windows.get(window_id)
                return bool(window and window.generation==generation and window.children.released_broker(broker))
            for window_id,generation in self.launcher.poll(released):
                window=self.windows.get(window_id)
                if window and window.generation==generation:
                    self._uncertain(window_id,generation,"runtime_refused")
                    self._terminate(window,wait=.25)
        require(self.child is not None, "server_not_started")
        if self.child.poll() is not None and not self.closed:
            self.failed = True  # Even exit0 is unexpected outside close().
            self._uncertain_all("server_lost")
            raise Refused("unexpected_server_exit")
        for window in list(self.windows.values()):
            try:
                window.children.observe()
            except Exception:
                # One window's descendant tree cannot be followed (bound,
                # identity or metadata). Only that window loses custody; the
                # shared manager and every other conversation keep running.
                self._uncertain(window.window, window.generation, "cleanup_unknown")
                self._terminate(window)
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

    def due(self, now=None):
        """Whether custody housekeeping is due; requests never wait for it."""
        now = time.monotonic() if now is None else now
        if self.ticked is not None and 0 <= now - self.ticked < TICK_S:
            return False
        self.ticked = now
        return True

    def guarded_tick(self, now=None):
        """tick(), tolerating a busy ledger for TICK_BUSY_GRACE_S. Every other
        failure (an unexpected server exit included) still stops the manager."""
        now = time.monotonic() if now is None else now
        try:
            self.tick()
        except sqlite3.OperationalError as error:
            if self.tick_busy_since is None:
                self.tick_busy_since, self.tick_busy_passes = now, 0
                report("tick deferred (ledger busy)", error)
            self.tick_busy_passes += 1
            if now - self.tick_busy_since >= TICK_BUSY_GRACE_S:
                sys.stderr.write("manager tick failed: ledger busy for %.1fs over %d passes\n" %
                                 (now - self.tick_busy_since, self.tick_busy_passes))
                sys.stderr.flush()
                raise
            return
        if self.tick_busy_since is not None:
            sys.stderr.write("manager tick recovered: ledger busy for %.1fs over %d passes\n" %
                             (now - self.tick_busy_since, self.tick_busy_passes))
            sys.stderr.flush()
            self.tick_busy_since = None

    def once(self):
        if self.due():
            self.guarded_tick()
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
            request = None
            descriptors = []
            try:
                request, descriptors = receive_control(connection, deadline)
                if request["operation"] in ("bind_child", "launch_child"):
                    deadline = self._bind_deadline(request, accepted)
                elif request["operation"] == "workspace_attest":
                    # Read-only proof completes before Core opens a dependent
                    # control request or acquires its durable writer fence.
                    deadline = accepted + MANAGED_REPLY_SECONDS
                elif request["operation"] in ("managed_pending", "managed_run_open", "managed_consume",
                                               "managed_poll", "managed_renew", "managed_result", "managed_worker_reply", "managed_worker_bind"):
                    # A consumed capability can commit before a delayed ACK.
                    # Share Core's bounded control allowance; capability expiry,
                    # receive budget, run leases and cleanup bounds stay fixed.
                    deadline = self._observation_deadline(request, accepted)
                answer = self.dispatch(request, deadline, descriptors)
            except Refused as error:
                # Static refusal codes only (never request values): the operator
                # needs the reason a retirement or custody check refused.
                operation = request.get("operation") if isinstance(request, dict) else None
                if operation in ("retire", "reconcile", "extend", "uncertain", "bind_child"):
                    sys.stderr.write("manager refused %s: %s\n" % (operation, str(error)[:64]))
                    sys.stderr.flush()
                answer = {"ok": False, "code": "control_refused", "receipt": self.ledger.status()}
            except (OSError, ValueError):
                answer = {"ok": False, "code": "control_unavailable"}
            finally:
                for fd in descriptors:
                    os.close(fd)
            try:
                respond(connection, answer, deadline)
            except (OSError, Refused):
                pass  # A lost ACK never resets a committed admission/reservation.

    def close(self):
        from .manager_shutdown import close
        return close(self)


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
    except Exception as error:
        # The cause of an unplanned stop: without it every crash read only as
        # the server's "timer controller failed during shutdown".
        report("stopping after", error)
        failed = True
    finally:
        if manager is not None:
            try:
                failed = not manager.close() or failed
            except Exception as error:
                report("close failed", error)
                failed = True
        print(json.dumps({"service_stopped": True, "clean_shutdown": not failed}))
        for number, handler in previous.items():
            signal.signal(number, handler)
    return 2 if failed else 0
