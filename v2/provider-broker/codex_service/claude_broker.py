"""Fixed Claude Deep service launcher, paused before any native or FD3 transfer.

The operator's package pins the Claude private configuration (host full access
only). The exact root manager captures this stopped process before Runtime may
wait for the provider writer; no request selects an executable or account.
"""
import ctypes
import dataclasses
import os
from pathlib import Path
import signal
import socket
import sys
from .contract import require
from .package import Package


def conversation_workspace(config, beta, cwd):
    """The working directory Runtime launched this turn in.

    Runtime starts the launcher in the window's Claude workspace: the
    configured one, or the conversation's operator-pinned directory from
    beta.json `conversation_workspaces` (host full access only, the same rule
    as Codex Deep/Fast). No other directory is ever accepted.
    """
    cwd = str(cwd)
    if cwd == str(config.workspace):
        return config
    pinned = beta.get("conversation_workspaces", {})
    require(config.host_full_access is not None and "host_full_access" in beta
            and type(pinned) is dict and cwd in pinned.values(), "claude_conversation_workspace")
    selected = dataclasses.replace(config, workspace=Path(cwd))
    selected.validate()  # Absolute, canonical, existing directory.
    return selected


def main(root):
    pump = None
    try:
        package = Package(root)
        require(os.geteuid() == package.uid and package.claude is not None, "claude_broker_identity")
        sys.path.insert(0, str(package.root / "broker"))
        from protocol import PROTOCOL, Failure, Refused
        from transport import Pump
        from reaping import REAPED_EXIT
        from claude_connector import ClaudeConfiguration
        from claude_protocol import ClaudeChannel
        fresh = ["open-owned-session", "--protocol", PROTOCOL]
        resumed = ["resume-owned-session", "--protocol", PROTOCOL]
        require(sys.argv[1:] in (fresh, resumed), "claude_broker_operation")

        def stop(_number, _frame):
            raise Refused("owned selected Claude stopped", Failure.SIGNAL)
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        parent = os.getppid()
        libc = ctypes.CDLL(None, use_errno=True)
        require(parent > 1 and libc.prctl(1, signal.SIGKILL, 0, 0, 0) == 0
                and os.getppid() == parent, "broker_parent_death")
        config = ClaudeConfiguration.load(package.root / "claude-private.json")
        require(config.host_full_access is not None, "claude_full_access_required")
        config = conversation_workspace(config, package.beta, os.getcwd())
        with socket.socket(fileno=3) as handoff:
            require(handoff.family == socket.AF_UNIX and handoff.type == socket.SOCK_STREAM,
                    "private_writer_endpoint")
            handoff.getpeername()
            # The owned root manager captures our original pidfd, then continues us.
            os.kill(os.getpid(), signal.SIGSTOP)
            if sys.argv[1:] == resumed:
                from claude_bootstrap import receive
                session = config.resumed_session(receive(config))  # One-use FD4.
            else:
                session = config.new_session()
            pump = Pump(session, ClaudeChannel(session), handoff=handoff, diagnostics=True)
            pump.run()
            if pump.parent_eof and pump.child is not None and pump.reaped:
                return REAPED_EXIT
        return 0
    except Exception:
        sys.stderr.write("selected Claude service broker refused; reconcile uncertain delivery\n")
        code = pump.failure_exit if pump is not None else 2
        return code if type(code) is int and 80 <= code <= 217 else 2
