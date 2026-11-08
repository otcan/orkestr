"""Root-registered machine context: await its answer without echoing its input.

The producer durably publishes a record BEFORE admitting the exact text to
Core. Its digest and conversation select presentation only, never execution
authority. Missing records keep ordinary owner/API mirroring unchanged.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import uuid

FORMAT = "orkestr-internal-context-v1"
MAX_RECORD = 4096


def _directory(path):
    selected = Path(path)
    if not selected.is_absolute() or ".." in selected.parts or selected.resolve() != selected:
        raise ValueError("internal_context_directory")
    fd = os.open(selected, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(fd)
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(fd)
        raise ValueError("internal_context_directory")
    return fd


def directory(path):
    fd = _directory(path)
    os.close(fd)
    return str(path)


def registered(path, conversation, message):
    """Exact Root-recorded text/scope match; corrupt records stop the scan.

    No language marker, arbitrary JSON shape, or caller-stated author can
    suppress a message. A valid record in another conversation cannot match.
    """
    if path is None:
        return False
    digest = hashlib.sha256(message["text"].encode()).hexdigest()
    parent = _directory(path)
    try:
        try:
            fd = os.open(digest + ".json", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        except FileNotFoundError:
            return False
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or
                    stat.S_IMODE(info.st_mode) != 0o400 or not 1 <= info.st_size <= MAX_RECORD):
                raise ValueError("internal_context_record")
            raw = os.read(fd, MAX_RECORD + 1)
            if len(raw) != info.st_size:
                raise ValueError("internal_context_record")
            value = json.loads(raw)
            if (set(value) != {"format", "conversation_id", "text_sha256", "operation_id", "artifact_sha256"} or
                    value["format"] != FORMAT or value["text_sha256"] != digest or
                    str(uuid.UUID(value["conversation_id"])) != value["conversation_id"] or
                    str(uuid.UUID(value["operation_id"])) != value["operation_id"] or
                    len(value["artifact_sha256"]) != 64 or
                    any(c not in "0123456789abcdef" for c in value["artifact_sha256"])):
                raise ValueError("internal_context_record")
            current = os.stat(digest + ".json", dir_fd=parent, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise ValueError("internal_context_replaced")
            return value["conversation_id"] == conversation
        finally:
            os.close(fd)
    finally:
        os.close(parent)
