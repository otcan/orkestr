"""Linux directory-inode flock shared by the server and offline helpers.

The directory must remain mounted at the same inode for its entire lifetime.
No removable lock file exists. This is cooperative process exclusion, not an
untrusted-writer sandbox or a distributed/network-filesystem lock.
"""
from contextlib import contextmanager
import fcntl
import os
import stat
import sys


def acquire(state):
    if sys.platform != 'linux':
        raise RuntimeError('container state locking requires Linux')
    fd = os.open(state, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise RuntimeError('private owned state directory required for locking')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('state busy; stop server and other recovery helpers') from error
        # The server inherits this descriptor across exec and holds it until exit.
        os.set_inheritable(fd, True)
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextmanager
def locked(state):
    fd = acquire(state)
    try:
        yield
    finally:
        os.close(fd)
