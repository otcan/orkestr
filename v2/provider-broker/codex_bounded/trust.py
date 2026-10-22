"""Protected metadata and process identities; never read provider credentials."""
import hashlib
import json
import os
from pathlib import Path
import stat
import time


class Refused(Exception):
    """Static diagnostics only: do not attach paths, requests or provider text."""


def require(value, reason):
    if not value:
        raise Refused(reason)


def protected(path, directory=False):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, "canonical_package_required")
    for item in (path, *path.parents):
        info = item.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022 and
                not stat.S_ISLNK(info.st_mode), "protected_package_required")
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) if directory else
            stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "package_file_type")
    return path


def private(path, uid, directory=False):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, "canonical_state_required")
    for item in (path, *path.parents):
        info = item.lstat()
        require(info.st_uid in (0, uid) and not info.st_mode & 0o022 and
                not stat.S_ISLNK(info.st_mode), "private_state_ancestor")
    info = path.stat()
    require(info.st_uid == uid and stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600),
            "private_state_owner")
    require(stat.S_ISDIR(info.st_mode) if directory else
            stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "private_state_type")
    return path


# Verified digests of this process, keyed by the file's full stat identity.
# A later change of the bytes always changes the key: a write updates ctime
# (which no unprivileged caller can set back), and a replacement changes the
# inode. Only files whose ctime was already SETTLED when hashed are memoized,
# so a same-size rewrite within one coarse kernel clock tick still rehashes.
SETTLED_NS = 1_000_000_000
_VERIFIED = {}


def identity(path):
    info = os.stat(path)
    return (str(path), info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def settled(key, now_ns=None):
    return (time.time_ns() if now_ns is None else now_ns) - key[5] >= SETTLED_NS


def remember(key, value):
    """Record a digest verified by this process (or by the root manager's seal)."""
    require(type(key) is tuple and len(key) == 6 and type(value) is str and len(value) == 64,
            "verified_digest")
    if settled(key):
        _VERIFIED[key] = value


def digest(path):
    # Credential references must never be added to a package inventory.
    require(Path(path).name != "auth.json", "credential_hash_refused")
    before = identity(path)
    known = _VERIFIED.get(before)
    if known is not None:
        return known
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    value = value.hexdigest()
    if identity(path) == before:
        remember(before, value)
    return value


def system_dependency(path):
    """OS-managed runtime dependency (interpreter, bwrap, prlimit, CA bundle).

    These files belong to the distribution's package manager and change with
    every unattended security update. Pinning their BYTES turned a routine
    ca-certificates update into a full outage of new turns, so they are held
    to the same custody rule as the rest of /usr and /etc: a canonical,
    root-owned, single-link regular file whose whole ancestry no non-root user
    can write. Only root can change them, and root is already trusted with the
    package, the manifest pin and the unit itself. Their packaging-time hashes
    stay in the manifest as build evidence only.
    """
    return protected(path)


def metadata(path, maximum=32768):
    require(Path(path).stat().st_size <= maximum, "metadata_bound")
    def unique(items):
        value = {}
        for key, item in items:
            require(key not in value, "duplicate_metadata_key")
            value[key] = item
        return value
    with Path(path).open("rb") as stream:
        raw = stream.read(maximum + 1)
    require(len(raw) <= maximum, "metadata_bound")
    value = json.loads(raw, object_pairs_hook=unique)
    require(isinstance(value, dict), "metadata_object_required")
    return value


def process(pid):
    try:
        path = Path("/proc") / str(pid)
        fields = (path / "stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": pid, "ppid": int(fields[1]), "start": int(fields[19]),
                "uid": path.stat().st_uid}
    except (OSError, ValueError, IndexError):
        return None


def exists(identity):
    current = process(identity["pid"])
    return bool(current and all(current[key] == identity[key] for key in ("pid", "start", "uid")))


def belongs(pid, owner):
    if not exists(owner):
        return False
    for _ in range(40):
        current = process(pid)
        if current is None:
            return False
        if current["pid"] == owner["pid"]:
            return all(current[key] == owner[key] for key in ("start", "uid"))
        if current["ppid"] <= 1 or current["ppid"] == pid:
            return False
        pid = current["ppid"]
    return False
