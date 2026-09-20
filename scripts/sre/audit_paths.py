"""Unix ownership/mode checks for collector-private SQLite evidence paths."""
import os
from pathlib import Path
import stat


def check_directory_chain(directory, allow_missing=False):
    candidate = Path(os.path.abspath(directory))
    for component in [*reversed(candidate.parents), candidate]:
        try:
            info = component.lstat()
        except FileNotFoundError:
            if allow_missing:
                continue
            raise
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0, os.geteuid()}:
            raise ValueError("audit directory ancestry must be trusted; symlinks forbidden")
        if component == candidate:
            if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise ValueError("audit directory must be private and owned by the collector")
        elif info.st_mode & 0o022:
            # A root-owned sticky /tmp protects child names against other UIDs.
            if info.st_uid != 0 or not info.st_mode & stat.S_ISVTX:
                raise ValueError("audit directory ancestor is writable by another identity")


def check_database_file(info):
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
            or info.st_mode & 0o077 or info.st_nlink != 1):
        raise ValueError("unsafe audit database or sidecar")


def check_sidecars(db_path):
    for suffix in ("-wal", "-shm", "-journal"):
        try:
            info = os.lstat(db_path + suffix)
        except FileNotFoundError:
            continue
        check_database_file(info)
