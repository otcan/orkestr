"""Real process flock contention and exec lifetime; synthetic state only."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import test_distribution as distribution
import state_lock

recovery = distribution.load('dormant')


class StateLockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='v2-lock-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)

    def child(self, code, *args, **kwargs):
        return subprocess.Popen([sys.executable, '-B', '-c', code, str(self.state),
                                 str(distribution.HERE), *args],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, **kwargs)

    def test_cross_process_helpers_refuse_without_writes_then_release(self):
        code = "import sys;sys.path.insert(0,sys.argv[2]);import state_lock;from pathlib import Path;state_lock.acquire(Path(sys.argv[1]))"
        with state_lock.locked(self.state):
            child = self.child(code)
            out, err = child.communicate(timeout=5)
            self.assertNotEqual(child.returncode, 0)
            self.assertIn('state busy', err)
            # Lock must win before validation/copy/receipt mutations.
            for operation in (
                lambda: recovery.snapshot(self.state/'data/core.sqlite3', self.state/'snapshot', self.state/'image'),
                lambda: recovery.apply(self.state/'snapshot', self.state, self.state/'image'),
                lambda: recovery.rollback(self.state, self.state/'image')):
                with self.assertRaisesRegex(RuntimeError, 'state busy'):
                    operation()
            self.assertEqual(list(self.state.iterdir()), [])
        child = self.child(code)
        child.communicate(timeout=5)
        self.assertEqual(child.returncode, 0)

    def test_exec_inheritance_holds_until_child_exit(self):
        code = "import os,sys;sys.path.insert(0,sys.argv[2]);import state_lock;from pathlib import Path;fd=state_lock.acquire(Path(sys.argv[1]));os.execv(sys.executable,[sys.executable,'-B','-c',\"import sys;print('ready',flush=True);sys.stdin.readline()\"])"
        child = self.child(code, stdin=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'ready')
            with self.assertRaisesRegex(RuntimeError, 'state busy'):
                state_lock.acquire(self.state)
        finally:
            child.communicate('\n', timeout=5)
        with state_lock.locked(self.state):
            pass

    def test_alias_conflicts_and_symlink_refused(self):
        with state_lock.locked(self.state):
            with self.assertRaisesRegex(RuntimeError, 'state busy'):
                state_lock.acquire(self.state / '.')
        link = self.state/'alias'
        link.symlink_to(self.state, target_is_directory=True)
        with self.assertRaises(OSError):
            state_lock.acquire(link)
