"""Explicit private service-session cache for short-lived operator clients.

The long-running adapter keeps sessions in memory. One-shot helpers may opt in
to this locked cache to avoid exchanging a service key on every invocation.
No password or service key is stored here. A cached cookie remains a secret.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import time

from .rust_client import ClientError, RustSession, credentials, decode, require

FORMAT = "orkestr-service-session-cache-v1"
FIELDS = {"format", "owner_id", "source_commit", "credential_digest", "cookie", "csrf",
          "revoked", "logged_in_mono", "boot_id"}


def fingerprint(secret):
    return hashlib.sha256(json.dumps(secret, sort_keys=True).encode()).digest()


def directory(path):
    require(path.is_absolute() and ".." not in path.parts and path.name != "auth.json",
            "session_cache_path_refused")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            sticky_root = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
            require(info.st_uid in (0, os.geteuid()) and
                    (not info.st_mode & 0o022 or sticky_root), "session_cache_parent_refused")
        info = os.fstat(fd)
        require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700,
                "session_cache_directory_not_private")
        return fd
    except BaseException:
        os.close(fd)
        raise


def private_file(fd):
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
            stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
            "session_cache_file_refused")
    return info


class ServiceSessionCache:
    """Hold the cache lock through one client's complete operation.

    Before yielding, validate source/owner/session and durably retain the cookie.
    No successful mutation is followed by a fallible cache write. Revocations are
    retained even when the caller's operation fails; they never trigger re-login
    unless the protected service-key file is explicitly replaced.
    """
    def __init__(self, cache_path, *, lock_timeout_s=20, **session_options):
        require(type(lock_timeout_s) in (int, float) and 0 < lock_timeout_s <= 30,
                "session_cache_timeout_refused")
        self.path = Path(cache_path)
        self.client = RustSession(**session_options)
        require(self.client.peer_descriptor_path is not None,"service_peer_descriptor_required")
        self.timeout = lock_timeout_s
        self.parent = self.lock = None
        self.locked = False
        self.boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()

    def _restore(self, value, current):
        require(isinstance(value, dict) and set(value) == FIELDS and value["format"] == FORMAT and
                type(value["revoked"]) is bool and
                isinstance(value["credential_digest"], str) and
                re.fullmatch("[0-9a-f]{64}", value["credential_digest"]), "session_cache_shape_refused")
        if current.hex() != value["credential_digest"]:
            return  # Explicit protected-key replacement invalidates the old cache.
        client = self.client
        client._credential_digest = current
        client._revoked = value["revoked"]
        if client._revoked:
            return
        if (value["owner_id"] != client.owner or value["source_commit"] != client.source or
                value["boot_id"] != self.boot):
            return  # Recheck the new selected source/owner through a fresh exchange.
        cookie, csrf, logged = value["cookie"], value["csrf"], value["logged_in_mono"]
        require(isinstance(cookie, str) and re.fullmatch("orkestr_v2_session=[0-9a-f]{64}", cookie) and
                isinstance(csrf, str) and
                type(logged) in (int, float) and 0 < logged <= time.monotonic(),
                "session_cache_shape_refused")
        expected = hashlib.sha256(f"orkestr-v2-browser-csrf-v1:{cookie.split('=')[1]}".encode()).hexdigest()
        require(csrf == expected, "session_cache_shape_refused")
        client._cookie, client._csrf = cookie, csrf
        client._logged_in_at = logged
        client.generation = 1

    def _save(self):
        require(self.locked, "session_cache_lock_required")
        client = self.client
        require(client._credential_digest is not None and (client._cookie or client._revoked),
                "session_cache_not_authenticated")
        value = {"format": FORMAT, "owner_id": client.owner, "source_commit": client.source,
                 "credential_digest": client._credential_digest.hex(), "cookie": client._cookie,
                 "csrf": client._csrf, "revoked": client._revoked,
                 "logged_in_mono": client._logged_in_at, "boot_id": self.boot}
        temporary = f".service-session-{secrets.token_hex(16)}.tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=self.parent)
        try:
            with os.fdopen(fd, "w", closefd=False) as stream:
                json.dump(value, stream, sort_keys=True, allow_nan=False)
                stream.flush()
                os.fsync(fd)
            os.rename(temporary, self.path.name, src_dir_fd=self.parent, dst_dir_fd=self.parent)
            os.fsync(self.parent)
        finally:
            os.close(fd)
            try:
                os.unlink(temporary, dir_fd=self.parent)
            except FileNotFoundError:
                pass

    def __enter__(self):
        require(self.parent is None and self.lock is None, "session_cache_already_entered")
        try:
            self.parent = directory(self.path)
            self.lock = os.open(self.path.name + ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                                0o600, dir_fd=self.parent)
            private_file(self.lock)
            deadline = time.monotonic() + self.timeout
            while True:
                try:
                    fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.locked = True
                    break
                except BlockingIOError:
                    require(time.monotonic() < deadline, "session_cache_busy")
                    time.sleep(0.02)
            secret = credentials(self.client.credentials_path)
            require(set(secret) == {"service_token"}, "service_credentials_required")
            current = fingerprint(secret)
            try:
                fd = os.open(self.path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=self.parent)
            except FileNotFoundError:
                pass
            else:
                try:
                    info = private_file(fd)
                    require(0 < info.st_size <= 4096, "session_cache_size_refused")
                    raw = os.read(fd, 4097)
                    require(len(raw) == info.st_size, "session_cache_changed")
                    self._restore(decode(raw), current)
                finally:
                    os.close(fd)
            self.client.login()
            self._save()  # Complete persistence before any caller mutation.
            return self.client
        except BaseException:
            self.__exit__(*sys.exc_info())
            raise

    def __exit__(self, *_):
        try:
            if self.locked and self.client._revoked:
                self._save()
        finally:
            if self.lock is not None:
                os.close(self.lock)
                self.lock = None
            self.locked = False
            if self.parent is not None:
                os.close(self.parent)
                self.parent = None
