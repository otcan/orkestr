"""Recovery acceptance owns only its Popen server; observed PIDs are evidence."""
import signal
import subprocess
import time

from native_driver import ActiveCandidate, exists


class RecoveryCandidate(ActiveCandidate):
    def __init__(self, *args):
        super().__init__(*args)
        self.server_exit_code = None

    def close_owned(self):
        # A provider's namespace-local PID never enters cleanup. Even host
        # descendants observed through /proc do not confer signal authority.
        self.observe()
        if self.child is not None:
            if self.child.poll() is None:
                self.child.send_signal(signal.SIGINT)
                try:
                    # Reviewed retirement allows 3s for broker evidence and 2s
                    # for retained resources; HTTP drain is separately bounded.
                    self.child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    self.forced_cleanup = True
                    self.child.kill()
                    self.child.wait(timeout=3)
            self.server_exit_code = self.child.returncode
            self.child = None
        # The reviewed broker's lifetime containment must remove its own tree.
        # A surviving observed identity is a failure, never permission to kill it.
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and any(exists(p) for p in self.known.values()):
            time.sleep(.05)
        return self.server_exit_code in (None, 0) and not any(exists(p) for p in self.known.values())
