"""Root-owned finite execution window; never install services or read account data."""
from dataclasses import replace
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time

from .configuration import Package
from .egress import Endpoint
from .trust import exists, process, require
from isolation.bounded_budget import Budget, LIMITS


class Runtime:
    def __init__(self, root, expected):
        require(os.geteuid() == 0, "root_controller_required")
        self.package = Package(root, expected)
        self.expected = expected
        self.budget = Budget(replace(LIMITS,
            lifetime_seconds=self.package.runtime["lifetime_seconds"]))
        self.child = self.identity = self.listener = self.egress = None
        self.endpoint_identity = None
        self.started = self.forced = self.closed = self.poisoned = False
        self.epochs = []

    def start(self):
        require(not self.closed and not self.poisoned and not self.forced, "execution_window_unusable")
        require(self.child is None and self.listener is None and self.egress is None,
                "previous_server_still_owned")
        package = Package(self.package.root, self.expected)
        self.budget.check()
        if not self.started:
            # A different controller cannot silently reset this window's budget.
            marker = package.endpoint.parent / "window.started"
            descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
            with os.fdopen(descriptor, "w") as stream:
                stream.write("one explicit selected Codex execution window\n")
            self.started = True
        require(not package.endpoint.exists() and not package.endpoint.is_symlink(), "endpoint_exists")
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.listener.bind(str(package.endpoint))
            os.chown(package.endpoint, 0, package.gid)
            package.endpoint.chmod(0o660)
            info = package.endpoint.stat()
            self.endpoint_identity = (info.st_dev, info.st_ino)
            self.listener.listen(12)
            self.listener.settimeout(0.05)
            command = [str(Path("/usr/bin/python3").resolve()), "-I", "-B",
                       str(package.root / "codex_bounded/server_child.py"), str(os.getpid())]
            self.child = subprocess.Popen(command, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                cwd="/", user=package.uid, group=package.gid, extra_groups=[], close_fds=True,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                process_group=0)
            self.identity = process(self.child.pid)
            require(self.identity is not None and self.identity["ppid"] == os.getpid() and
                    self.identity["uid"] == package.uid, "owned_server_identity")
            self.egress = Endpoint(package, self.identity, self.listener, self.budget)
            self.egress.thread.start()
            return dict(self.identity)
        except BaseException:
            self.poisoned = True
            self.stop_server()
            raise

    def stop_server(self):
        """Controlled replacement keeps this same Budget and its original deadline."""
        errors = []
        if self.child is not None:
            try:
                if self.child.poll() is None:
                    self.child.send_signal(signal.SIGINT)
                    try:
                        self.child.wait(timeout=12)
                    except subprocess.TimeoutExpired:
                        # The process is ours, so reap it; forced disappearance
                        # does not prove ordinary graceful retirement authority.
                        self.forced = self.poisoned = True
                        self.child.kill()
                        self.child.wait(timeout=3)
                require(self.child.returncode == 0, "server_exit_not_graceful")
                require(not exists(self.identity), "owned_server_not_reaped")
            except BaseException:
                errors.append("server_cleanup")
            finally:
                # Retain the owned Popen on an incomplete wait; never turn an
                # unknown live child into an apparently available replacement.
                if self.child.poll() is not None:
                    self.child = None
        if self.egress is not None:
            try:
                self.egress.close()
            except BaseException:
                errors.append("egress_cleanup")
            else:
                self.epochs.append(self.egress.snapshot())
                self.egress = None
        if self.listener is not None:
            try:
                self.listener.close()
            except BaseException:
                errors.append("listener_cleanup")
            else:
                self.listener = None
        if self.endpoint_identity is not None:
            try:
                info = self.package.endpoint.lstat()
                require((info.st_dev, info.st_ino) == self.endpoint_identity, "endpoint_replaced")
                self.package.endpoint.unlink()
            except BaseException:
                errors.append("endpoint_cleanup")
            else:
                self.endpoint_identity = None
        if errors:
            # Retrying cleanup is allowed. Recovering replacement authority is
            # not: uncertainty survives even if a later cleanup attempt works.
            self.poisoned = True
        require(not errors, "owned_cleanup_incomplete")

    def close(self):
        self.closed = True
        self.budget.stop()
        self.stop_server()

    def snapshot(self):
        return {"source_commit": self.package.manifest["source_commit"], "forced_cleanup": self.forced,
                "window_poisoned": self.poisoned,
                "attempts": self.budget.attempts, "combined_bytes": self.budget.bytes,
                "lifetime_seconds": self.budget.limits.lifetime_seconds,
                "budget_reason": self.budget.reason, "epochs": self.epochs}


def main(root, expected):
    runtime = None
    stopped = threading.Event()
    previous = {}
    failed = False
    try:
        runtime = Runtime(root, expected)
        for number in (signal.SIGTERM, signal.SIGINT):
            previous[number] = signal.signal(number, lambda *_args: stopped.set())
        runtime.start()
        while not stopped.wait(0.05):
            if runtime.child.poll() is not None:
                require(runtime.child.returncode == 0, "server_exit")
                break
            runtime.budget.check()
            require(not runtime.egress.failed, "egress_failed")
    except BaseException:
        failed = True
    finally:
        # Signals only set the event; they cannot interrupt joined cleanup.
        if runtime is not None:
            try:
                runtime.close()
            except BaseException:
                failed = True
            print(json.dumps({"completed": not failed and not runtime.forced, **runtime.snapshot()}))
        for number, handler in previous.items():
            signal.signal(number, handler)
    return 2 if failed or (runtime is not None and runtime.forced) else 0
