"""Root-recorded release interruption: continue the stopped Deep turn once (ORK-792).

The release train publishes one record per Deep run it interrupts, BEFORE it
stops that run, in a Root-only directory. The adapter then treats that exact
stop like a window-deadline stop: the input continues once in a new turn of
the same native session (with its grouped follow-ups) and the chat gets one
short notice, without an alert.

Core honours the same record once: its released-binding check admits exactly
one fenced continuation of that run at the recorded provider generation until
the record expires (apps/server release_interruption.rs). A record selects the
continuation only; it is never execution authority.
Without the configuration, or without a valid record for the exact run and
conversation, a stop keeps today's meaning (final: one notice and an alert).
"""
import json
import os
from pathlib import Path
import re
import stat
import time

FORMAT = "orkestr-release-interruption-v1"
MAX_RECORD = 4096
# Core run IDs are UUIDs; the record file is named after the exact run.
RUN_NAME = re.compile(r"[0-9A-Za-z][0-9A-Za-z-]{0,63}")
FIELDS = {"format", "conversation_id", "run_id", "release_source", "interrupted_at_ms", "provider_generation",
          "expires_at_ms"}
# Core (store-sqlite source_binding_released_once) honours a record at most this long.
MAX_WINDOW_MS = 2 * 60 * 60 * 1000
# Root-owned; Core (another user) reads it through the directory's group.
DIRECTORY_MODES = (0o700, 0o750)
RECORD_MODES = (0o400, 0o440)
# Root custody in production; tests may run as another user.
OWNER_UID = 0


def _directory(path):
    selected = Path(path)
    if not selected.is_absolute() or ".." in selected.parts or selected.resolve() != selected:
        raise ValueError("release_interruption_directory")
    fd = os.open(selected, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(fd)
    if info.st_uid != OWNER_UID or stat.S_IMODE(info.st_mode) not in DIRECTORY_MODES:
        os.close(fd)
        raise ValueError("release_interruption_directory")
    return fd


def directory(path):
    """Configuration check: an absolute, canonical, owner-only directory."""
    fd = _directory(path)
    os.close(fd)
    return str(path)


def configured(service):
    """The record directory when the service enables it, else None (today's behaviour).

    Both `release_interruption_enabled: true` and `release_interruption_dir`
    are required; removing or disabling either is the kill switch."""
    if service.get("release_interruption_enabled") is not True:
        return None
    return service.get("release_interruption_dir")


def recorded(path, conversation, run_id):
    """Whether Root recorded this exact run of this conversation as interrupted.

    False when the feature is off (no path), when no record exists, or when the
    record is not exactly valid: a corrupt or foreign record never continues.
    """
    if path is None or not isinstance(run_id, str) or not RUN_NAME.fullmatch(run_id):
        return False
    name = run_id
    try:
        parent = _directory(path)
    except (OSError, ValueError):
        return False
    try:
        try:
            fd = os.open(name + ".json", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        except OSError:
            return False
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER_UID or info.st_nlink != 1 or
                    stat.S_IMODE(info.st_mode) not in RECORD_MODES or not 1 <= info.st_size <= MAX_RECORD):
                return False
            raw = os.read(fd, MAX_RECORD + 1)
            if len(raw) != info.st_size:
                return False
            value = json.loads(raw)
        finally:
            os.close(fd)
    except (OSError, ValueError):
        return False
    finally:
        os.close(parent)
    if not isinstance(value, dict) or set(value) != FIELDS or value["format"] != FORMAT:
        return False
    if value["run_id"] != run_id or value["conversation_id"] != str(conversation):
        return False
    source, at, until = value["release_source"], value["interrupted_at_ms"], value["expires_at_ms"]
    generation = value["provider_generation"]
    # An expired record keeps today's meaning here too: Core would refuse it.
    return (isinstance(source, str) and len(source) == 40 and all(c in "0123456789abcdef" for c in source) and
            type(at) is int and at > 0 and type(until) is int and at < until <= at + MAX_WINDOW_MS and
            type(generation) is int and generation >= 0 and time.time() * 1000 <= until)
