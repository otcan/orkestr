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
"""
import hashlib
import os
import stat

MAX_BYTES = 32 * 1024
LINE = ("[Chat rules v%s: before answering, read %s (cat it) unless you already read this version "
        "in this session, and follow it.]")


def check_path(value):
    """Load-time validation: None, or an absolute path to a readable regular file <= 32 KiB."""
    if value is None:
        return None
    if (not isinstance(value, str) or not os.path.isabs(value) or len(value) > 1024 or
            any(ord(c) < 32 or c in "[]" for c in value)):
        raise ValueError("config_instructions_path")
    read(value)
    return value


def read(path):
    """The file's bytes; ValueError with a stable code when it cannot be used."""
    try:
        with open(path, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("instructions_not_regular")
            if info.st_size > MAX_BYTES:
                raise ValueError("instructions_too_large")
            content = handle.read(MAX_BYTES + 1)
    except OSError:
        raise ValueError("instructions_unreadable") from None
    if len(content) > MAX_BYTES:
        raise ValueError("instructions_too_large")
    return content


def line(path):
    """The rules line for the file's current version (raises ValueError)."""
    return LINE % (hashlib.sha256(read(path)).hexdigest()[:12], path)


def reserve(path):
    """Bytes the rules line and its blank line add to an intake (0 without a file)."""
    return len((LINE % ("0" * 12, path)).encode()) + 2 if path else 0
