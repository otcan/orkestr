"""Protected metadata and process identities; never read provider credentials."""
import hashlib
import json
import os
from pathlib import Path
import stat


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


def digest(path):
    # Credential references must never be added to a package inventory.
    require(Path(path).name != "auth.json", "credential_hash_refused")
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


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
