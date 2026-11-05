"""Negative manager shutdown always retains and reaps the original Core child."""
import os
import signal
import time
from codex_bounded.trust import exists, process
from .contract import require
from .ownership import Process, Vanished


def close(self):
    self.closed = True
    errors = []
    if getattr(self, "service_peer", None) is not None:
        try:self.service_peer.close()
        except Exception:errors.append("service_peer_cleanup")
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
            # A failed control/observer callback must not abandon the
            # manager's original Core child during negative shutdown.
            try:
                if self.child.poll() is None:
                    current = process(self.child.pid)
                    if current is not None:
                        require(current['ppid'] == os.getpid() and self.identity and
                            current['start'] == self.identity['start'],
                            'original_server_cleanup_identity')
                        try:
                            original = Process(self.identity, any_uid=True)
                        except Vanished:
                            pass  # Exit between poll and pin still needs wait().
                        else:
                            try:original.send(signal.SIGKILL)
                            finally:original.close()
                            self.failed = True
                self.child.wait(3)
                require(not exists(self.identity), 'server_not_reaped')
            except Exception:
                errors.append("server_reap_unknown")
    try:
        self._uncertain_all("manager_stopped")
        if getattr(self,'managed',None):self.managed.close()
        if getattr(self,'desk',None) and not self.desk.close():errors.append('desk_cleanup')
        if getattr(self,'workspace_commands',None) and not self.workspace_commands.close():errors.append('workspace_cleanup')
        if not self._terminate_all():
            errors.append("window_cleanup")
    except Exception:
        errors.append("window_cleanup")
    try:self._capture_orphans()
    except Exception:errors.append('adopted_cleanup')
    if getattr(self, "launcher", None) is not None:
        try:
            self.launcher.poll(lambda window_id,generation,broker:bool(self.windows.get(window_id) and
                self.windows[window_id].generation==generation and self.windows[window_id].children.released_broker(broker)))
            self.launcher.close()
        except Exception:
            errors.append("managed_launch_cleanup")
    if self.egress is not None:
        try:
            endpoint, self.egress = self.egress, None
            endpoint.close()
        except Exception:
            errors.append("window_cleanup")
    for window in list(self.windows.values()):
        window.children.close()
    if getattr(self,'adopted',None) is not None:self.adopted.close()
    if getattr(self,'workspace_projects',None) is not None:self.workspace_projects.close()
    for item in (self.control, self.ledger, self.lock):
        if item is not None:
            try:
                item.close()
            except Exception:
                errors.append("state_cleanup")
    self.failed = self.failed or bool(errors)
    return not self.failed

