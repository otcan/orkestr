"""Fixed service launcher, paused before any provider process or FD3 transfer."""
import ctypes
import os
import signal
import socket
import sys
from codex_bounded.broker import modules, pump_type
from .contract import require
from .package import Package
from .profile import Configuration


def main(root):
    pump = None
    try:
        package = Package(root)
        require(os.geteuid() == package.uid, "broker_executor_identity")
        Channel, protocol, Refused, subreaper, reaped_exit, Pump = modules(package.root)
        fresh = ["open-owned-session", "--protocol", protocol]
        resumed = ["resume-owned-session", "--protocol", protocol]
        require(sys.argv[1:] in (fresh, resumed), "broker_operation")
        def stop(_number, _frame):
            from protocol import Failure
            raise Refused("owned selected Codex stopped", Failure.SIGNAL)
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        parent = os.getppid()
        libc = ctypes.CDLL(None, use_errno=True)
        require(parent > 1 and libc.prctl(1, signal.SIGKILL, 0, 0, 0) == 0
                and os.getppid() == parent, "broker_parent_death")
        expected_native = None
        with socket.socket(fileno=3) as handoff:
            require(handoff.family == socket.AF_UNIX and handoff.type == socket.SOCK_STREAM,
                    "private_writer_endpoint")
            handoff.getpeername()
            config = Configuration(package)
            # The exact owned root manager captures our original pidfd and only
            # then continues us. Runtime calls bind_child before waiting for FD3.
            os.kill(os.getpid(), signal.SIGSTOP)
            if sys.argv[1:] == resumed:
                from codex_bootstrap import receive
                expected_native = receive()  # Strict one-use FD4, after bind ACK.
            pump = pump_type(Pump, subreaper)(config,
                Channel(config.workspace, expected_native=expected_native), handoff=handoff,
                diagnostics=True)
            pump.run()
            if pump.parent_eof and pump.child is not None and pump.reaped:
                return reaped_exit
        return 0
    except Exception:
        sys.stderr.write("selected Codex service broker refused; reconcile uncertain delivery\n")
        code = pump.failure_exit if pump is not None else 2
        return code if type(code) is int and 80 <= code <= 217 else 2
