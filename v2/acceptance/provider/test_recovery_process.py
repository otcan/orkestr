"""Actual synthetic children only; observed process identity is never authority."""
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import unittest

from native_driver import process
from recovery_process import RecoveryCandidate


class RecoveryProcessTests(unittest.TestCase):
    def child(self):
        return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={"PATH": "/usr/bin:/bin"}, start_new_session=True)

    def candidate(self):
        value = RecoveryCandidate("/unused", Path(tempfile.gettempdir()), {"bootstrap": "synthetic"})
        value.child = subprocess.Popen([sys.executable, "-c",
            "import signal,sys,time; signal.signal(signal.SIGINT,lambda *_:sys.exit(0)); "
            "print('ready',flush=True); time.sleep(30)"], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin"},
            start_new_session=True)
        try:
            self.assertTrue(select.select([value.child.stdout], [], [], 2)[0])
            self.assertEqual(value.child.stdout.readline(32), b"ready\n")
        except BaseException:
            value.child.kill()
            value.child.wait(timeout=3)
            raise
        finally:
            value.child.stdout.close()
        return value

    def test_normal_owned_handle_cleanup_and_repeat_leave_no_child(self):
        candidate = self.candidate()
        child = candidate.child
        try:
            self.assertTrue(candidate.close_owned())
            self.assertIsNotNone(child.returncode)
            self.assertFalse(candidate.forced_cleanup)
            self.assertTrue(candidate.close_owned())
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)

    def test_surviving_observation_fails_without_signalling_that_process(self):
        candidate, other = self.candidate(), self.child()
        owned = candidate.child
        identity = process(other.pid)
        self.assertIsNotNone(identity)
        self.assertEqual(identity["uid"], os.geteuid())
        candidate.known[(identity["pid"], identity["start"])] = identity
        try:
            self.assertFalse(candidate.close_owned())
            self.assertIsNotNone(owned.returncode)
            self.assertIsNone(other.poll(), "an observed PID must not be killed")
            self.assertFalse(candidate.forced_cleanup)
        finally:
            for child in (owned, other):
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=3)


if __name__ == "__main__":
    unittest.main()
