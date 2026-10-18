"""Private local install state and verified directory packages; no service manager."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import socket
import stat
import sys

from helper import filesystem_disjoint, require

FORMAT = "orkestr-v2-local-install-v1"
PACKAGE_FORMAT = "orkestr-v2-directory-package-v1"
PACKAGE_TOOLS = ("helper.py", "install_state.py", "launcher.py", "recovery.py", "path_identity.py")


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


def protected_roots(extra=()):
    roots = list(extra)
    # Packaged tools do not assume a repository layout.
    if Path(__file__).resolve().parent.name == "local-install":
        roots.append(Path(__file__).resolve().parents[2])
    legacy = os.environ.get("ORKESTR_HOME")
    if legacy:
        legacy = Path(legacy)
        require(legacy.is_absolute() and legacy.is_dir(), "configured legacy home must exist and be absolute")
        roots.append(legacy.resolve())
    return roots


def private_home(raw):
    path = Path(raw)
    require(path.is_absolute() and not path.is_symlink(), "home must be absolute and not a symlink")
    path = path.resolve()
    require(path.is_dir(), "initialized home required")
    roots = protected_roots()
    if roots:
        path = filesystem_disjoint(path, roots)
    siblings = [path / "install.json", path / "launcher.lock"]
    info = path.stat()
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
            "home must be owned by current user with mode 0700")
    for name in ("data", "logs", "control", "releases", "provider-home"):
        child = path / name
        require(not child.is_symlink() and child.is_dir(), "invalid private home layout")
        child = filesystem_disjoint(child, roots + siblings)
        siblings.append(child)
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
    return filesystem_disjoint(path, protected_roots(protected))


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


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "duplicate package manifest key")
        value[key] = item
    return value


def package(raw):
    root = Path(raw).resolve()
    require(root.is_dir(), "package directory required")
    manifest_path = root / "manifest.json"
    require(not manifest_path.is_symlink(), "package manifest symlink refused")
    require(manifest_path.is_file(), "regular package manifest required")
    manifest = json.loads(manifest_path.read_text(), object_pairs_hook=unique_object)
    require(isinstance(manifest, dict), "package manifest must be an object")
    require(manifest.get("format") == PACKAGE_FORMAT, "unsupported package format")
    for key, pattern, message in (
        ("version", r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", "invalid version"),
        ("source_commit", r"[0-9a-f]{40}", "full source commit required"),
        ("target", r"[a-z0-9_]+-[a-z0-9_]+", "invalid package target"),
    ):
        require(isinstance(manifest.get(key), str) and re.fullmatch(pattern, manifest[key]), message)
    require(type(manifest.get("ui")) is bool, "package ui must be boolean")
    require(isinstance(manifest.get("schema_compatibility"), str)
            and bool(manifest["schema_compatibility"]), "schema compatibility declaration required")
    inventory = manifest.get("files")
    require(isinstance(inventory, dict), "package files must be an inventory object")
    for name, digest in inventory.items():
        path = PurePosixPath(name)
        require(bool(name) and not path.is_absolute() and str(path) == name
                and ".." not in path.parts and "\\" not in name and "\0" not in name
                and name != "manifest.json", "invalid package inventory path")
        require(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest),
                "invalid package inventory checksum")
    required = {"server/orkestr-v2-server", "bin/orkestr-v2"}
    required.update("tools/" + name for name in PACKAGE_TOOLS)
    require(required <= inventory.keys(), "package required executable/tool inventory incomplete")
    require(("ui/index.html" in inventory) == manifest["ui"]
            and (manifest["ui"] or not any(name.startswith("ui/") for name in inventory)),
            "package UI inventory disagrees with manifest")
    require(inventory == files(root), "package checksum inventory mismatch")
    for name in ("server/orkestr-v2-server", "bin/orkestr-v2"):
        require(os.access(root / name, os.X_OK), "package executable permission missing")
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
            # Closed server connections may remain in TIME_WAIT after owned stop.
            # REUSEADDR permits restart while still refusing an active listener.
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(("127.0.0.1", port))
    except OSError as error:
        raise RuntimeError("loopback port unavailable; occupant will not be stopped") from error


def add_release(home, source):
    source, manifest = package(source)
    release = sha256(source / "manifest.json")
    target = home / "releases" / release
    if target.exists():
        _, cached_manifest = package(target)
        require(cached_manifest == manifest, "cached release differs from validated source manifest")
        require(sha256(target / "manifest.json") == release, "cached release manifest identity mismatch")
    else:
        staging = home / "releases" / (".stage-" + secrets.token_hex(8))
        try:
            shutil.copytree(source, staging)
            _, copied_manifest = package(staging)
            require(copied_manifest == manifest, "copied release manifest changed during validation")
            require(sha256(staging / "manifest.json") == release,
                    "copied release manifest identity changed; upgrade refused")
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
        source = filesystem_disjoint(source, [home])
        release, manifest = add_release(home, source)
        current["release"] = release
        replace_json(home / "install.json", current)
    return manifest
