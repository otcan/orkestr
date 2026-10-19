"""Retained-file identity check for a stable, trusted offline namespace.

This detects changes up to each check, not hostile races after the final check.
"""
from contextlib import contextmanager
import os
import stat

from desktop_restore import MAX_BYTES, RecoveryError


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


@contextmanager
def retained_source(source):
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        original = os.fstat(fd)
        if not stat.S_ISREG(original.st_mode) or original.st_nlink != 1 or original.st_size > MAX_BYTES:
            raise RecoveryError('bounded regular single-link source required')

        def verify():
            try:
                current, pathname = os.fstat(fd), os.lstat(source)
            except OSError as error:
                raise RecoveryError('source pathname unavailable or changed') from error
            if identity(original) != identity(current) or identity(original) != identity(pathname):
                raise RecoveryError('source pathname or retained file changed')

        verify()
        yield verify
    finally:
        os.close(fd)
