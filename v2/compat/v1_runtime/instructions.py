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

Size never refuses a file. Only the path travels in the line (agents read the
file themselves); Fast inlines at most 20 KiB in Rust and keeps the line for
anything larger, so no downstream limit depends on the file size. Above
SOFT_BYTES (32 KiB, the old hard limit) health reports `instructions_oversize`
with the byte count and the operator gets one alert per file per day.
"""
import hashlib
import os
import stat

SOFT_BYTES = 32 * 1024
CHUNK = 64 * 1024
LINE = ("[Chat rules v%s: before answering, read %s (cat it) unless you already read this version "
        "in this session, and follow it.]")


def check_path(value):
    """Load-time validation: None, or an absolute path to a readable regular file (any size)."""
    if value is None:
        return None
    if (not isinstance(value, str) or not os.path.isabs(value) or len(value) > 1024 or
            any(ord(c) < 32 or c in "[]" for c in value)):
        raise ValueError("config_instructions_path")
    inspect(value)
    return value


def inspect(path):
    """(sha256 hex, size in bytes); ValueError with a stable code when the file cannot be used."""
    digest = hashlib.sha256()
    size = 0
    try:
        with open(path, "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise ValueError("instructions_not_regular")
            while True:
                chunk = handle.read(CHUNK)
                if not chunk:
                    break
                size += len(chunk)
                digest.update(chunk)
    except OSError:
        raise ValueError("instructions_unreadable") from None
    return digest.hexdigest(), size


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
