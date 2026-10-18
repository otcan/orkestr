"""Private local install state and verified directory packages; no service manager."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import stat
import sys

from helper import overlap, require

FORMAT = "orkestr-v2-local-install-v1"
PACKAGE_FORMAT = "orkestr-v2-directory-package-v1"


def unprivileged():
    require(sys.version_info >= (3, 11), "Python 3.11+ is required")
    require(hasattr(os, "getuid") and os.getuid() != 0, "run as an unprivileged POSIX user")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write("\n")


def replace_json(path, value):
    temporary = path.with_name(path.name + "." + secrets.token_hex(8))
    try:
        write_json(temporary, value)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def private_home(raw):
    path = Path(raw)
    require(path.is_absolute() and not path.is_symlink(), "home must be absolute and not a symlink")
    path = path.resolve()
    require(path.is_dir(), "initialized home required")
    info = path.stat()
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
            "home must be owned by current user with mode 0700")
    for name in ("data", "logs", "control", "releases", "provider-home"):
        child = path / name
        require(not child.is_symlink() and child.is_dir(), "invalid private home layout")
        child_info = child.stat()
        require(child_info.st_uid == os.getuid() and stat.S_IMODE(child_info.st_mode) == 0o700,
                "home subdirectories must be private and owned by current user")
    return path


def fresh_path(raw, protected=()):
    path = Path(raw)
    require(path.is_absolute() and not path.exists() and not path.is_symlink(),
            "destination must be absolute and nonexistent")
    path = path.resolve()
    require(path.parent.is_dir(), "destination parent must exist")
    roots = list(protected)
    # Protect checkout when used from source. Packaged tools do not assume a repository layout.
    if Path(__file__).resolve().parent.name == "local-install":
        roots.append(Path(__file__).resolve().parents[2])
    legacy = os.environ.get("ORKESTR_HOME")
    if legacy:
        legacy = Path(legacy)
        require(legacy.is_absolute() and legacy.is_dir(), "configured legacy home must exist and be absolute")
        roots.append(legacy.resolve())
    require(all(not overlap(path, Path(root).resolve()) for root in roots),
            "destination overlaps protected source, package, repository or legacy home")
    return path


def files(root):
    result = {}
    for path in sorted(root.rglob("*")):
        require(not path.is_symlink(), "symlinks are not allowed in packages/snapshots")
        if path.is_dir():
            continue
        require(path.is_file(), "only regular files are allowed")
        if path.name == "manifest.json" and path.parent == root:
            continue
        result[path.relative_to(root).as_posix()] = sha256(path)
    return result


def package(raw):
    root = Path(raw).resolve()
    require(root.is_dir(), "package directory required")
    require(not (root / "manifest.json").is_symlink(), "package manifest symlink refused")
    manifest = json.loads((root / "manifest.json").read_text())
    require(manifest.get("format") == PACKAGE_FORMAT, "unsupported package format")
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", manifest.get("version", "")), "invalid version")
    require(re.fullmatch(r"[0-9a-f]{40}", manifest.get("source_commit", "")), "full source commit required")
    require(manifest.get("files") == files(root), "package checksum inventory mismatch")
    require("server/orkestr-v2-server" in manifest["files"], "package has no server executable")
    require(os.access(root / "server/orkestr-v2-server", os.X_OK), "server is not executable")
    return root, manifest


def config(home):
    path = home / "install.json"
    require(not path.is_symlink(), "config symlink refused")
    value = json.loads(path.read_text())
    require(value.get("format") == FORMAT, "unsupported install format")
    require(isinstance(value.get("port"), int) and 1024 <= value["port"] <= 65535, "invalid configured port")
    release = value.get("release", "")
    require(re.fullmatch(r"[0-9a-f]{64}", release), "invalid release identifier")
    return value


@contextlib.contextmanager
def locked(home):
    path = home / "launcher.lock"
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("home is busy; stop its launcher before this operation") from error
        yield
    finally:
        os.close(descriptor)


def free_port(port):
    require(1024 <= port <= 65535, "explicit port must be 1024..65535")
    try:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
    except OSError as error:
        raise RuntimeError("loopback port unavailable; occupant will not be stopped") from error


def add_release(home, source):
    source, manifest = package(source)
    release = sha256(source / "manifest.json")
    target = home / "releases" / release
    if target.exists():
        package(target)
    else:
        staging = home / "releases" / (".stage-" + secrets.token_hex(8))
        try:
            shutil.copytree(source, staging)
            package(staging)
            staging.rename(target)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    return release, manifest


def initialize(raw, source, port):
    unprivileged()
    source, _ = package(source)
    home = fresh_path(raw, (source,))
    free_port(port)
    home.mkdir(mode=0o700)
    # Failure leaves a fresh diagnostic directory; never delete user state automatically.
    for name in ("data", "logs", "control", "releases", "provider-home"):
        (home / name).mkdir(mode=0o700)
    with locked(home):
        release, _ = add_release(home, source)
        token = home / "control" / "bootstrap.token"
        descriptor = os.open(token, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(secrets.token_urlsafe(48))
        write_json(home / "install.json", {"format": FORMAT, "port": port, "release": release})
    return home


def upgrade(home, source):
    unprivileged()
    home = private_home(home)
    with locked(home):
        current = config(home)
        source, _ = package(source)
        require(not overlap(source, home), "upgrade source must be outside home")
        release, manifest = add_release(home, source)
        current["release"] = release
        replace_json(home / "install.json", current)
    return manifest
