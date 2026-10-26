"""Original pidfds only. Empty process snapshots never create retirement proof."""
import math
import errno
import os
from functools import wraps
from pathlib import Path
import select
import signal
import sys
import time
import threading
from codex_bounded.trust import belongs, exists, process
from .contract import MAX_BIND_MS, Refused, require
from .role_profiles import ROLE_NAMES

MAX_CHILDREN = 256
# Host full access runs real commands (builds, sudo, code-mode hosts) under the
# native, so its live descendant tree is larger and may include setuid children.
HOST_MAX_CHILDREN = 512


def serialized(function):
    @wraps(function)
    def wrapped(self, *args, **kwargs):
        with self.lock:
            return function(self, *args, **kwargs)
    return wrapped


def same(identity, any_uid=False):
    """Original pid+start (and uid unless a host descendant may change it)."""
    if not any_uid:
        return exists(identity)
    current = process(identity["pid"])
    return bool(current and current["start"] == identity["start"])


class Vanished(Refused):
    """The original identity was reaped before its pidfd pinned it.

    Same closed codes as before, so every strict caller (broker bind) refuses
    exactly as it did. Only the descendant walk may skip it: a reaped process
    can no longer run, and the bound broker is a child subreaper, so any
    orphan it left is re-parented inside the walked broker tree and is found
    on the next pass. A live process whose identity changed is never this.
    """


def _refuse(identity, reason):
    current = process(identity["pid"])
    if current is None or current["start"] != identity["start"]:
        # No process, or the pid was reused: the original was already reaped.
        raise Vanished(reason)
    raise Refused(reason)


class Process:
    def __init__(self, identity, any_uid=False):
        self.identity = dict(identity)
        # Host mode: an original descendant may exec a setuid program (sudo);
        # it stays the same owned process for cleanup and reap proof.
        self.any_uid = any_uid
        self.fd = None
        if not same(identity, any_uid):
            _refuse(identity, "owned_process_missing")
        try:
            self.fd = os.pidfd_open(identity["pid"], 0)
        except ProcessLookupError:
            raise Vanished("owned_process_missing") from None
        try:
            if not same(identity, any_uid):
                _refuse(identity, "owned_process_changed")
        except BaseException:
            self.close()
            raise

    def exited(self):
        return bool(select.select([self.fd], [], [], 0)[0])

    def gone(self):
        # pidfd readiness includes a zombie. Retirement requires actual reap.
        return not same(self.identity, self.any_uid)

    def send(self, number):
        if not self.exited():
            signal.pidfd_send_signal(self.fd, number)

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def host_full_access(package):
    access = getattr(package, "beta", {}).get("host_full_access")
    return type(access) is dict and access.get("providers", True) is True


class Children:
    def __init__(self, package, server):
        self.package, self.server = package, dict(server)
        # Operator opt-in (V1-equivalent): the native and its commands run
        # directly on the host. Descendants may legitimately run as another
        # uid (sudo), and a long window may start many short-lived commands.
        self.host = host_full_access(package)
        self.bound = HOST_MAX_CHILDREN if self.host else MAX_CHILDREN
        self.records = {}
        self.brokers = set()
        self.forced = self.uncertain = False
        self.uncertainty_reason = None
        self.lock = threading.RLock()

    @serialized
    def remember(self, identity):
        key = (identity["pid"], identity["start"])
        if key not in self.records:
            if len(self.records) >= self.bound:
                self._forget_reaped()
            require(len(self.records) < self.bound, "owned_child_bound")
            self.records[key] = Process(identity, any_uid=self.host)
        return self.records[key]

    def _forget_reaped(self):
        """Drop reaped non-broker descendants. A reaped original identity stays
        gone, so every cleanup and retirement proof is unchanged."""
        for key in [key for key, record in self.records.items()
                    if key not in self.brokers and record.gone()]:
            self.records.pop(key).close()

    @serialized
    def bind(self, pid, start, deadline):
        require(type(deadline) in (int, float) and math.isfinite(deadline)
                and 0 < deadline - time.monotonic() <= MAX_BIND_MS / 1000,
                "broker_pause_deadline")
        identity = process(pid)
        require(identity is not None and identity["start"] == start and
                identity["uid"] == self.package.uid and identity["ppid"] == self.server["pid"]
                and belongs(pid, self.server), "broker_owner")
        key = (pid, start)
        if key in self.brokers:
            # An exact IPC retry cannot continue/spawn anything a second time.
            return False
        require(not self.uncertain and not self.forced, "cleanup_uncertain")
        record = self.remember(identity)
        path = Path("/proc") / str(pid)
        while True:
            require(time.monotonic() < deadline, "broker_pause_deadline")
            require(exists(identity) and belongs(pid, self.server), "broker_owner_changed")
            state = (path / "stat").read_text().rsplit(")", 1)[1].split()[0]
            if state == "T":
                break
            time.sleep(0.005)
        # The initial executable may still be the source-pinned shell entry.
        # Only the final stopped interpreter/argv can establish launch authority.
        executable = Path("/usr/bin/python3").resolve()
        expected = [bytes(executable), b"-I", b"-S", b"-B",
                    bytes(self.package.root / "codex_service/entry.py")]
        modes = {b"broker": "deep", **{("broker-" + role).encode(): role
                 for role in ROLE_NAMES if role in getattr(self.package, "role_profiles", {})}}
        if getattr(self.package, "claude", None) is not None:
            modes[b"broker-claude"] = "claude"
        fresh = [b"open-owned-session", b"--protocol", b"orkestr-v2-provider-broker-v1"]
        resumed = [b"resume-owned-session", b"--protocol", b"orkestr-v2-provider-broker-v1"]
        arguments = (path / "cmdline").read_bytes().split(b"\0")[:-1]
        role = modes.get(arguments[5]) if len(arguments) >= 6 else None
        allowed = (fresh,) if role is not None and role.startswith("worker-") else (fresh, resumed)
        if role is not None and role.startswith("worker-") and getattr(self.package, "beta", {}).get("workspace_exec") is not None:
            allowed += ([b"open-owned-workspace-worker-session", b"--protocol", b"orkestr-v2-provider-broker-v1"],)
        require(arguments[:5] == expected and role is not None and arguments[6:] in allowed
                and (path / "exe").resolve() == executable, "broker_source")
        require(exists(identity) and belongs(pid, self.server), "broker_owner_changed")
        require(time.monotonic() < deadline, "broker_pause_deadline")
        self.brokers.add(key)  # Retain original ownership BEFORE releasing launch.
        record.send(signal.SIGCONT)
        return True

    @serialized
    def broker_for(self, pid):
        for key in self.brokers:
            owner = self.records[key].identity
            if belongs(pid, owner):
                return owner
        return None

    @serialized
    def observe(self):
        pending = [self.records[key].identity for key in self.brokers]
        visited = set()
        try:
            while pending:
                parent = pending.pop()
                key = (parent["pid"], parent["start"])
                if key in visited or not same(parent, self.host):
                    continue
                visited.add(key)
                require(len(visited) <= self.bound, "owned_child_bound")
                path = Path(f"/proc/{parent['pid']}/task/{parent['pid']}/children")
                try:
                    with path.open("rb") as stream:
                        raw = stream.read(8193)
                except (FileNotFoundError, ProcessLookupError):
                    # Pinned descendant reaped since `same` above (ESRCH):
                    # its orphans re-parent under the broker subreaper.
                    continue
                require(len(raw) <= 8192, "owned_child_bound")
                for token in raw.split():
                    require(token.isdigit(), "owned_child_metadata")
                    child = process(int(token))
                    if child is None or child["ppid"] != parent["pid"]:
                        continue
                    require(self.host or child["uid"] == self.package.uid, "owned_child_identity")
                    try:
                        self.remember(child)
                    except Vanished:
                        # A short-lived descendant (CLI helper, shell probe)
                        # exited and was reaped mid-walk. Not uncertainty.
                        continue
                    pending.append(child)
        except BaseException as error:
            self._observation_failed(error)
            raise

    def _observation_failed(self, error):
        """Persist a closed diagnostic; never expose raw exception text/paths."""
        self.uncertain = True
        if self.uncertainty_reason is not None:
            return
        reason = error.args[0] if error.args else None
        allowed = {"owned_child_bound", "owned_child_identity", "owned_child_metadata",
                   "owned_process_missing", "owned_process_changed"}
        if isinstance(reason, str) and reason in allowed:
            self.uncertainty_reason = reason
        elif isinstance(error, OSError) and error.errno in (errno.ENOENT, errno.ESRCH):
            self.uncertainty_reason = "owned_child_disappeared"
        else:
            self.uncertainty_reason = "owned_child_observation"

    @serialized
    def proven_gone(self):
        self.observe()
        require(self.brokers and not self.forced and not self.uncertain, "original_cleanup_proof_missing")
        live = self._log_live()
        require(not live, "owned_child_not_reaped")
        return True

    @serialized
    def released(self):
        """Every original identity reaped and cleanup certain. Not graceful proof."""
        self.observe()
        live = self._log_live()
        return not self.uncertain and not live

    def _log_live(self):
        """Owned identities still alive. Operator diagnostic on stderr: pid and
        kernel command name (comm, at most 15 bytes) only, never arguments,
        environment or paths."""
        live = [record for record in self.records.values() if not record.gone()]
        if live:
            names = []
            for record in live[:8]:
                pid = record.identity["pid"]
                try:
                    comm = Path(f"/proc/{pid}/comm").read_text()[:15].strip()
                except OSError:
                    comm = "?"
                names.append("%d:%s" % (pid, "".join(c if c.isprintable() else "?" for c in comm)))
            more = " (+%d more)" % (len(live) - 8) if len(live) > 8 else ""
            sys.stderr.write("manager owned child not reaped: %s%s\n" % (" ".join(names), more))
            sys.stderr.flush()
        return live

    @serialized
    def cleanup(self, seconds=2):
        """Emergency owned cleanup. Forced signals permanently lose retirement
        proof. A child not yet reaped by the deadline only makes THIS call
        report failure: a killed broker is the Runtime server's child and stays
        a zombie until the server reaps it, which it cannot do while it waits
        for this very reply. `released()` re-observes later, so reconciliation
        succeeds once every original identity is reaped. Only a descendant tree
        that could not be followed (`observe`) stays permanently uncertain."""
        try:
            self.observe()
        except Exception as error:
            # A failed walk loses retirement proof, but must not prevent cleanup
            # of identities already pinned by their original pidfds.
            self._observation_failed(error)
        live = [record for record in self.records.values() if not record.exited()]
        if live:
            self.forced = True
            for record in reversed(live):
                record.send(signal.SIGKILL)
        deadline = time.monotonic() + seconds
        while any(not record.gone() for record in self.records.values()):
            for record in self.records.values():
                # We may adopt an orphan under the root subreaper. Never wait on
                # arbitrary pids; wait only original owned identities/pidfds.
                if record.exited() and same(record.identity, record.any_uid):
                    try:
                        os.waitid(os.P_PIDFD, record.fd, os.WEXITED | os.WNOHANG)
                    except ChildProcessError:
                        pass
            if time.monotonic() >= deadline:
                break
            time.sleep(0.01)
        return not self.uncertain and all(record.gone() for record in self.records.values())

    @serialized
    def close(self):
        for record in self.records.values():
            record.close()
