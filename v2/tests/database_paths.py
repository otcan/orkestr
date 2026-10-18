"""Black-box alias refusal; all targets and homes are owned synthetic fixtures."""
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

BINARY = sys.argv.pop(1)


def files(directory):
    result = {}
    for path in sorted(directory.iterdir()):
        info = path.lstat()
        if path.is_symlink():
            content = os.readlink(path)
        elif stat.S_ISREG(info.st_mode):
            content = path.read_bytes()
        else:
            content = None
        result[path.name] = (info.st_mode, info.st_ino, info.st_nlink, content)
    return result


class DatabasePathIsolation(unittest.TestCase):
    def refuse(self, kind, suffix):
        parent = Path(os.environ["ORKESTR_V2_HOME"])
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="path-isolation-", dir=parent) as case:
            home = Path(case) / "candidate"
            legacy = Path(case) / "synthetic-legacy"
            home.mkdir()
            legacy.mkdir()
            target = legacy / "preserve.sqlite3"
            target.write_bytes(b"")
            entry = home / ("core.sqlite3" + suffix)
            if kind == "symlink":
                entry.symlink_to(target)
            elif kind == "dangling":
                entry.symlink_to(legacy / "must-not-create.sqlite3")
            elif kind == "hardlink":
                os.link(target, entry)
            elif kind == "directory":
                entry.mkdir()
            elif kind == "fifo":
                os.mkfifo(entry)
            before = (files(home), files(legacy))
            # Do not pass host credentials, provider settings, or loader overrides.
            env = {
                "PATH": os.defpath,
                "LANG": "C",
                "ORKESTR_HOME": str(legacy),
                "ORKESTR_V2_HOME": str(home),
                "ORKESTR_V2_BIND": f'127.0.0.1:{os.environ.get("ORKESTR_V2_TEST_PORT", "47110")}',
                "ORKESTR_V2_BOOTSTRAP_TOKEN": "synthetic-bootstrap-for-path-isolation-only",
            }
            # Only this child may be killed; never search/kill by port or process name.
            child = subprocess.Popen([BINARY], env=env, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.PIPE)
            try:
                try:
                    _, stderr = child.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    self.fail("server failed to refuse aliased database before startup")
                self.assertNotEqual(child.returncode, 0)
                # A bind failure or unrelated refusal cannot satisfy this regression.
                self.assertIn(b"store startup failed", stderr)
                self.assertEqual((files(home), files(legacy)), before,
                                 "refused candidate or synthetic legacy files changed")
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                if child.stderr:
                    child.stderr.close()

    def test_database_and_sidecar_symlinks_preserve_targets(self):
        for suffix in ("", "-wal", "-shm", "-journal"):
            with self.subTest(suffix=suffix):
                self.refuse("symlink", suffix)

    def test_dangling_aliases_do_not_create_targets(self):
        for suffix in ("", "-wal", "-shm", "-journal"):
            with self.subTest(suffix=suffix):
                self.refuse("dangling", suffix)

    @unittest.skipUnless(hasattr(os, "link"), "hardlink support required")
    def test_hardlinked_database_and_sidecars_are_refused(self):
        for suffix in ("", "-wal", "-shm", "-journal"):
            with self.subTest(suffix=suffix):
                self.refuse("hardlink", suffix)

    def test_non_regular_database_entries_are_refused(self):
        for suffix in ("", "-wal", "-shm", "-journal"):
            for kind in ("directory", "fifo") if hasattr(os, "mkfifo") else ("directory",):
                with self.subTest(kind=kind, suffix=suffix):
                    self.refuse(kind, suffix)


if __name__ == "__main__":
    unittest.main(verbosity=2)
