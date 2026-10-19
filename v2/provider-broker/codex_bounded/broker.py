"""Ordinary FD3 writer handoff and FD4 resume, using the fixed selected profile."""
import array
import importlib
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import sys

from .configuration import BROKER, Package
from .trust import require


def modules(root):
    root = Path(root)
    sys.path.insert(0, str(root / "broker"))
    for name in BROKER:
        module = importlib.import_module(name.removesuffix(".py"))
        require(Path(module.__file__).resolve() == root / "broker" / name, "broker_import_origin")
    from protocol import Channel, PROTOCOL, Refused
    from reaping import become_subreaper, REAPED_EXIT
    from transport import Pump
    return Channel, PROTOCOL, Refused, become_subreaper, REAPED_EXIT, Pump


def pump_type(base, become_subreaper):
    class SelectedPump(base):
        def launch(self):
            become_subreaper()
            command, descriptors = self.config.isolated_command()
            try:
                self.child = subprocess.Popen(command, env={}, cwd=self.config.workspace if self.config.workspace_descriptor is None else None,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    close_fds=True, pass_fds=descriptors, process_group=0)
            finally:
                for descriptor in descriptors:
                    os.close(descriptor)
            for pipe in (self.child.stdin, self.child.stdout):
                os.set_blocking(pipe.fileno(), False)
            require(self.handoff is not None, "native_writer_handoff_required")
            writer = self.child.stdin
            try:
                rights = array.array("i", [writer.fileno()])
                sent = self.handoff.sendmsg([b"provider-stdin-v1"],
                    [(socket.SOL_SOCKET, socket.SCM_RIGHTS, rights)])
                require(sent == len(b"provider-stdin-v1"), "native_writer_handoff")
            finally:
                writer.close()
                self.handoff.close()
            self.child.stdin = None
            self.watch(self.child.stdout.fileno(), selectors.EVENT_READ)
    return SelectedPump


def main(root, role=None):
    # No configuration, command, credential or protocol fallback selected by argv.
    try:
        arguments = sys.argv[1:]
        workspace_descriptor = None
        workspace_fresh = ["open-owned-workspace-session", "--protocol", "orkestr-v2-provider-broker-v1"]
        workspace_resume = ["resume-owned-workspace-session", "--protocol", "orkestr-v2-provider-broker-v1"]
        if arguments in (workspace_fresh,workspace_resume):
            from isolation.workspace_fd import InheritedWorkspace
            workspace_descriptor = InheritedWorkspace()  # Mandatory FD5; no fallback.
        package = Package(root, workspace_descriptor=workspace_descriptor)
        require(os.geteuid() == package.uid, "broker_executor_identity")
        package.profile_path(role)  # Role is fixed by the protected launcher, never argv.
        Channel, protocol, Refused, become_subreaper, reaped_exit, Pump = modules(package.root)
        resumed = arguments == ["resume-owned-session", "--protocol", protocol] or arguments == workspace_resume
        require(resumed or arguments == ["open-owned-session", "--protocol", protocol] or arguments == workspace_fresh, "broker_operation")
        def stop(_signal, _frame):
            raise Refused("owned selected Codex stopped")
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        from .profile import Configuration
        config = Configuration(package.root, role, workspace_descriptor=workspace_descriptor)

        expected_native = None
        if resumed:
            from codex_bootstrap import receive
            expected_native = receive()  # Strict one-use FD4; no UUID/history from request JSON.
        with socket.socket(fileno=3) as handoff:
            require(handoff.family == socket.AF_UNIX and handoff.type == socket.SOCK_STREAM,
                    "private_writer_endpoint")
            handoff.getpeername()
            pump = pump_type(Pump, become_subreaper)(config,
                Channel(config.workspace, expected_native=expected_native), handoff=handoff)
            pump.run()
            if pump.parent_eof and pump.child is not None and pump.reaped:
                return reaped_exit
        return 0
    except Exception:
        sys.stderr.write("selected Codex broker refused; reconcile uncertain delivery\n")
        return 2
