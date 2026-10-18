"""Native launcher lock inheritance, without executing a server."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import test_install

state = test_install.state


class NativeLockLifetimeTests(unittest.TestCase):
    def test_server_child_holds_lock_after_parent_releases_descriptor(self):
        with tempfile.TemporaryDirectory(prefix='v2-native-lock-') as raw:
            home = Path(raw)
            with state.locked(home) as fd:
                child = subprocess.Popen([sys.executable, '-B', '-c',
                    "import sys;print('ready',flush=True);sys.stdin.readline()"],
                    pass_fds=(fd,), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
                self.assertEqual(child.stdout.readline().strip(), 'ready')
            try:
                with self.assertRaisesRegex(RuntimeError, 'busy'):
                    with state.locked(home):
                        self.fail('child lock lost')
            finally:
                child.communicate('\n', timeout=5)
            with state.locked(home):
                pass

    def test_hardlinked_or_public_lock_rejected(self):
        with tempfile.TemporaryDirectory(prefix='v2-native-lock-') as raw:
            home = Path(raw)
            lock = home/'launcher.lock'
            lock.write_text('synthetic')
            lock.chmod(0o600)
            os.link(lock, home/'alias')
            with self.assertRaisesRegex(RuntimeError, 'invalid private launcher lock'):
                with state.locked(home):
                    pass

    def test_fifo_lock_rejected(self):
        with tempfile.TemporaryDirectory(prefix='v2-native-lock-') as raw:
            home = Path(raw)
            os.mkfifo(home/'launcher.lock', 0o600)
            with self.assertRaisesRegex(RuntimeError, 'invalid private launcher lock'):
                with state.locked(home):
                    pass
