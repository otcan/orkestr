"""Per-binding chat rules: one leading line on every intake sent to Rust.

V2 Fast/Deep sessions share one role workspace, so a migrated chat has no
per-conversation AGENTS.md. A binding may name an `instructions_path`; every
owner, member and V1-local intake of that binding then starts with

    [Chat rules v<12 hex>: before answering, read <path> (cat it) unless you
    already read this version in this session, and follow it.]

(one line), a blank line, and the unchanged text. The version is the first 12
hex digits of the file's SHA-256, so an edited file is read again. The line is
added when the intake is first sent and frozen with it (a retry resends the
same text); it is never part of the ledger's identity digest. A missing or
unreadable file sends the text without the line and is reported in health.

Size never refuses a file, and load/reload only stat it (the hash is computed
when a line is built, cached by file identity, and skipped above 16 MiB). Only the path travels in the line (agents read the
file themselves); Fast inlines at most 20 KiB in Rust and keeps the line for
anything larger, so no downstream limit depends on the file size. Above
SOFT_BYTES (32 KiB, the old hard limit) health reports `instructions_oversize`
with the byte count and the operator gets one alert per file per day.
"""
import hashlib
import os
import stat
import time

SOFT_BYTES = 32 * 1024
HARD_BYTES = 16 * 1024 * 1024  # Above this the file is never read: its version is its stat tuple.
CHUNK = 64 * 1024
RACY_S = 2
LINE = ("[Chat rules v%s: before answering, read %s (cat it) unless you already read this version "
        "in this session, and follow it.]")


def check_path(value):
    """Load-time validation: None, or an absolute path to a readable regular file (any size)."""
    if value is None:
        return None
    if (not isinstance(value, str) or not os.path.isabs(value) or len(value) > 1024 or
            any(ord(c) < 32 or c in "[]" for c in value)):
        raise ValueError("config_instructions_path")
    stat_size(value)
    return value


def _open(path):
    """Open without blocking (a FIFO must not stall a caller holding a lock); (fd, fstat)."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        raise ValueError("instructions_unreadable") from None
    try:
        info = os.fstat(fd)
    except OSError:
        os.close(fd)
        raise ValueError("instructions_unreadable") from None
    if not stat.S_ISREG(info.st_mode):
        os.close(fd)
        raise ValueError("instructions_not_regular")
    return fd, info


def _key(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def stat_size(path):
    """Size in bytes of a regular file without reading it (load, reload and health checks)."""
    fd, info = _open(path)
    os.close(fd)
    return info.st_size


_cache = {}


def inspect(path):
    """(version hex, size in bytes); the content hash is cached by (dev, inode, size, mtime, ctime).
    Above HARD_BYTES nothing is read: the version comes from that stat tuple."""
    fd, info = _open(path)
    try:
        key = _key(info)
        hit = _cache.get(path)
        if hit and hit[0] == key:
            return hit[1], info.st_size
        digest = hashlib.sha256()
        if info.st_size > HARD_BYTES:
            digest.update(repr(key).encode())
        else:
            try:
                # Never read past the size seen at fstat: a growing file cannot keep this loop going.
                left = min(info.st_size, HARD_BYTES)
                with os.fdopen(os.dup(fd), "rb") as handle:
                    while left > 0:
                        chunk = handle.read(min(CHUNK, left))
                        if not chunk:
                            break
                        left -= len(chunk)
                        digest.update(chunk)
            except OSError:
                raise ValueError("instructions_unreadable") from None
        # Racily clean: a same-size edit within one coarse timestamp tick looks unchanged,
        # so a digest of a file touched in the last RACY_S seconds is never cached.
        if time.time_ns() - max(info.st_mtime_ns, info.st_ctime_ns) >= RACY_S * 10 ** 9:
            if len(_cache) >= 256:
                _cache.clear()
            _cache[path] = (key, digest.hexdigest())
        else:
            _cache.pop(path, None)
        return digest.hexdigest(), info.st_size
    finally:
        os.close(fd)


def line(path):
    """The rules line for the file's current version (raises ValueError)."""
    return line_and_size(path)[0]


def line_and_size(path):
    version, size = inspect(path)
    return LINE % (version[:12], path), size


def warning(size):
    """Health warning for a file over the soft limit, else None."""
    return {"code": "instructions_oversize", "bytes": size} if size > SOFT_BYTES else None


def reserve(path):
    """Bytes the rules line and its blank line add to an intake (0 without a file)."""
    return len((LINE % ("0" * 12, path)).encode()) + 2 if path else 0
