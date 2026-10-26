"""Fixed service launcher, paused before any provider process or FD3 transfer."""
import ctypes
import os
import signal
import socket
import sys
from codex_bounded.broker import modules, pump_type
from .contract import require
from .package import Package, conversation_workspace_paths
from .profile import Configuration


def main(root, role="deep"):
    pump = None
    try:
        package = Package(root)
        require(os.geteuid() == package.uid, "broker_executor_identity")
        Channel, protocol, Refused, subreaper, reaped_exit, Pump = modules(package.root)
        fresh = ["open-owned-session", "--protocol", protocol]
        resumed = ["resume-owned-session", "--protocol", protocol]
        workspace = ["open-owned-workspace-worker-session", "--protocol", protocol]
        worker = role.startswith("worker-")
        workspace_enabled = worker and package.beta.get("workspace_exec") is not None
        allowed = (fresh, workspace) if workspace_enabled else ((fresh,) if worker else (fresh, resumed))
        require(role in package.role_profiles and sys.argv[1:] in allowed, "broker_operation")
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
            config = Configuration(package, role)
            # The exact owned root manager captures our original pidfd and only
            # then continues us. Runtime calls bind_child before waiting for FD3.
            os.kill(os.getpid(), signal.SIGSTOP)
            if sys.argv[1:] == resumed:
                from codex_bootstrap import receive
                expected_native = receive()  # Strict one-use FD4, after bind ACK.
                if getattr(config, "host_full_access", False) is True:
                    # A sandbox-created thread lives in this role's private
                    # state; the host native reads the real CODEX_HOME.
                    config.host_resume(expected_native)
            pump = pump_type(Pump, subreaper)(config,
                Channel(config.workspace, expected_native=expected_native,
                        workspace_exec=sys.argv[1:] == workspace,
                        workspace_trusted=sys.argv[1:] == workspace and type(
                            package.beta["workspace_exec"].get("trusted")) is dict,
                        host_full_access=getattr(config, "host_full_access", False) is True,
                        conversation_workspaces=conversation_workspace_paths(getattr(package, "beta", {}))
                        if not worker and getattr(config, "host_full_access", False) is True else (),
                        fast_only=role == "fast"),
                handoff=handoff,
                diagnostics=True)
            pump.run()
            if pump.parent_eof and pump.child is not None and pump.reaped:
                return reaped_exit
        return 0
    except Exception:
        sys.stderr.write("selected Codex service broker refused; reconcile uncertain delivery\n")
        code = pump.failure_exit if pump is not None else 2
        return code if type(code) is int and 80 <= code <= 217 else 2
