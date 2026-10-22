"""Root-owned service state and sockets; no provider credential inspection."""
import fcntl
import os
from pathlib import Path
import socket
import stat

from codex_bounded.trust import protected
from .contract import require


class StateLock:
    def __init__(self, directory):
        self.directory = protected(directory, True)
        require(stat.S_IMODE(self.directory.stat().st_mode) == 0o700, "ledger_directory_mode")
        path = self.directory / "manager.lock"
        self.fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(self.fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                    and stat.S_IMODE(info.st_mode) == 0o600, "ledger_lock_identity")
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for name in ("budget.sqlite3", "budget.sqlite3-wal", "budget.sqlite3-shm"):
                candidate = self.directory / name
                if candidate.exists() or candidate.is_symlink():
                    protected(candidate)
                    require(stat.S_IMODE(candidate.stat().st_mode) == 0o600, "ledger_file_mode")
            self.path = self.directory / "budget.sqlite3"
            if not self.path.exists():
                descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
                os.fsync(descriptor)
                os.close(descriptor)
                self.sync()
        except BaseException:
            os.close(self.fd)
            self.fd = None
            raise

    def sync(self):
        descriptor = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


class OwnedSocket:
    def __init__(self, path, gid, ledger, name, timeout=0.05):
        self.path, self.ledger, self.name = Path(path), ledger, name
        protected(self.path.parent, True)
        require(len(bytes(self.path)) < 100, "socket_path_bound")
        previous = ledger.endpoint(name)
        if self.path.exists() or self.path.is_symlink():
            info = self.path.lstat()
            require(previous == (info.st_dev, info.st_ino) and stat.S_ISSOCK(info.st_mode)
                    and info.st_uid == 0 and info.st_gid == gid
                    and stat.S_IMODE(info.st_mode) == 0o660, "stale_socket_identity")
            # The root-private flock proves the old manager is gone. Never
            # unlink an unrecorded/replaced endpoint or erase window history.
            self.path.unlink()
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.identity = None
        try:
            self.socket.bind(str(self.path))
            os.chown(self.path, 0, gid)
            self.path.chmod(0o660)
            info = self.path.lstat()
            self.identity = (info.st_dev, info.st_ino)
            ledger.set_endpoint(name, self.identity)
            self.socket.listen(12)
            # accept() returns at once for a waiting peer; the timeout only
            # paces the owner's idle loop.
            self.socket.settimeout(timeout)
        except BaseException:
            self.close()
            raise

    def close(self):
        self.socket.close()
        if self.identity is not None:
            info = self.path.lstat()
            require((info.st_dev, info.st_ino) == self.identity and stat.S_ISSOCK(info.st_mode),
                    "socket_replaced")
            self.path.unlink()
            self.ledger.clear_endpoint(self.name, self.identity)
            self.identity = None
