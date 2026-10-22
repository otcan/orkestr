"""No-site bootstrap; verify protected package bytes before packaged imports.

The root manager hashes the complete release once when the service starts and
leaves a root-owned seal (path, stat identity, SHA-256) in its runtime
directory. Every later child (server, Deep/Fast/Worker/Claude brokers) still
checks the manifest bytes and the full inventory and custody, but rehashes
only files whose stat identity differs from the seal. A replaced or rewritten
file always has a new identity (inode or ctime, which no unprivileged process
can set back), so it is hashed and refused exactly as before. Without a usable
seal every file is hashed, as before.

OS-managed dependencies (interpreter, bwrap, prlimit, CA bundle) are checked
for root custody, never for bytes: unattended security updates replace them.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

SEAL = "verified-package.json"
SEAL_FORMAT = "orkestr-v2-verified-package-v1"
MAX_SEAL = 4 * 1024 * 1024
# Same rule as codex_bounded.trust: a file is sealed or memoized only after its
# ctime has settled, so a rewrite within one coarse clock tick is never hidden.
SETTLED_NS = 1_000_000_000


def protected(path):
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError("package path")
    for part in (path, *path.parents):
        value = part.lstat()
        if value.st_uid != 0 or value.st_mode & 0o022 or stat.S_ISLNK(value.st_mode):
            raise ValueError("package custody")
    value = path.stat()
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
        raise ValueError("package file")


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def identity(path):
    info = os.stat(path)
    return (str(path), info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def settled(key):
    return time.time_ns() - key[5] >= SETTLED_NS


def unique(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def document(path, maximum):
    with path.open("rb") as stream:
        raw = stream.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError("document bound")
    return json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=unique)


def seal_path(root):
    """The manager's root-owned runtime directory, named by the protected plan."""
    plan = root / "service.json"
    protected(plan)
    directory = document(plan, 32768).get("endpoint_directory")
    if type(directory) is not str or not directory.startswith("/") or "\0" in directory:
        raise ValueError("seal directory")
    return Path(directory) / SEAL


def read_seal(root, manifest_digest):
    """Stat identities the root manager hashed for exactly this release, or {}."""
    try:
        path = seal_path(root)
        protected(path)  # Root-owned, single link, no non-root-writable ancestor.
        value = document(path, MAX_SEAL)
        if type(value) is not dict or value.get("format") != SEAL_FORMAT \
                or value.get("root") != str(root) or value.get("manifest_sha256") != manifest_digest \
                or type(value.get("files")) is not dict:
            return {}
        known = {}
        for name, record in value["files"].items():
            if type(name) is not str or type(record) is not list or len(record) != 6 \
                    or not all(type(item) is int for item in record[:5]) \
                    or type(record[5]) is not str or not re.fullmatch(r"[0-9a-f]{64}", record[5]):
                return {}
            known[(name, *record[:5])] = record[5]
        return known
    except (OSError, ValueError):
        return {}


def write_seal(directory, gid, root, manifest_digest, records):
    """Root manager only, after full verification. Best effort: a missing seal
    only means every child hashes the release itself."""
    path = directory / SEAL
    temporary = directory / (SEAL + ".%d.tmp" % os.getpid())
    data = json.dumps({"format": SEAL_FORMAT, "root": str(root), "manifest_sha256": manifest_digest,
                       "files": {key[0]: [*key[1:], value] for key, value in sorted(records.items())}},
                      sort_keys=True, separators=(",", ":")).encode()
    try:
        if len(data) > MAX_SEAL:
            raise ValueError("seal bound")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            os.fchown(fd, 0, gid)
            os.fchmod(fd, 0o640)
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, path)
        return True
    except (OSError, ValueError):
        try:
            temporary.unlink()
        except OSError:
            pass
        sys.stderr.write("package seal unavailable; children verify by hashing\n")
        sys.stderr.flush()
        return False


def verified(root, expected, sealed=False):
    """Validate the whole closed inventory. Returns the manifest digest and the
    settled stat identities verified here (hashed or matched to the seal)."""
    path = root / "manifest.json"
    protected(path)
    if path.stat().st_size > 1024 * 1024:
        raise ValueError("package manifest")
    manifest_digest = digest(path)
    if expected is not None and manifest_digest != expected:
        raise ValueError("package manifest")
    manifest = json.loads(path.read_bytes().decode("utf-8", "strict"), object_pairs_hook=unique)
    if set(manifest) != {"format", "source_commit", "files", "dependencies", "ui"} or \
            manifest["format"] != "orkestr-v2-codex-service-package-v1":
        raise ValueError("package format")
    # These are the complete import closure of Package itself. Validate them
    # before its import; Package then validates the full fixed module inventory
    # before manager/broker/server imports can execute.
    initial = {"codex_service/__init__.py", "codex_service/package.py", "codex_service/contract.py",
               "codex_service/role_profiles.py",
               "codex_bounded/__init__.py", "codex_bounded/configuration.py", "codex_bounded/trust.py"}
    dependencies = {str(Path(name).resolve(strict=True)) for name in
                    ("/usr/bin/python3", "/usr/bin/bwrap", "/usr/bin/prlimit", "/etc/ssl/certs/ca-certificates.crt")}
    if not initial <= set(manifest["files"]) or set(manifest["dependencies"]) != dependencies:
        raise ValueError("bootstrap closure")
    known = read_seal(root, manifest_digest) if sealed else {}
    records = {}
    for category in ("files", "ui", "dependencies"):
        values = manifest[category]
        if type(values) is not dict or not values or len(values) > 10000:
            raise ValueError("package inventory")
        for name, expected_hash in values.items():
            if type(name) is not str or type(expected_hash) is not str \
                    or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
                raise ValueError("package hash")
            if category == "dependencies":
                selected = Path(name)
            else:
                if name.startswith("/") or any(p in ("", ".", "..") for p in name.split("/")):
                    raise ValueError("package relative path")
                selected = root / ("ui" if category == "ui" else "") / name
            if selected.name == "auth.json":
                raise ValueError("credential inventory refused")
            protected(selected)
            if category == "dependencies":
                continue  # OS-managed: custody above, never bytes.
            key = identity(selected)
            if known.get(key) == expected_hash:
                records[key] = expected_hash
                continue
            if digest(selected) != expected_hash:
                raise ValueError("package digest")
            if identity(selected) == key and settled(key):
                records[key] = expected_hash
    interpreter = str(Path("/usr/bin/python3").resolve())
    if str(Path(sys.executable).resolve()) != interpreter or interpreter not in manifest["dependencies"]:
        raise ValueError("fixed interpreter")
    return manifest_digest, records


def main():
    if not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:
        raise ValueError("no-site invocation required")
    root = Path(__file__).resolve().parents[1]
    mode, *arguments = sys.argv[1:]
    if mode not in ("manager", "broker", "broker-fast", "broker-worker-0", "broker-claude",
                    "broker-worker-1", "broker-worker-2", "broker-worker-3", "server"):
        raise ValueError("fixed entry mode")
    expected = arguments[0] if mode == "manager" and len(arguments) == 1 else None
    # The pinned root manager always hashes everything; children reuse its seal.
    manifest_digest, records = verified(root, expected, sealed=mode != "manager")
    sys.path.insert(0, str(root))
    from codex_bounded import trust
    for key, value in records.items():
        trust.remember(key, value)  # Package re-checks these without rehashing.
    from codex_service.package import Package
    package = Package(root, expected)
    if mode == "manager" and expected is not None and os.geteuid() == 0:
        write_seal(package.control.parent, package.gid, root, manifest_digest, records)
    if mode == "broker" or mode.startswith("broker-"):
        from codex_service.broker import main as selected
        role = "deep" if mode == "broker" else mode.removeprefix("broker-")
        sys.argv = [str(root / ("launcher.py" if role == "deep" else f"launcher-{role}.py")), *arguments]
        if role == "claude":
            from codex_service.claude_broker import main as claude
            return claude(root)
        return selected(root, role)
    if mode == "server":
        if len(arguments) != 1:
            raise ValueError("server parent")
        from codex_service.server_child import main as selected
        selected(arguments[0])
        raise ValueError("server did not exec")
    if expected is None or not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("manifest pin required")
    from codex_service.manager import main as selected
    return selected(root, expected)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stderr.write("selected Codex service entry refused\n")
        raise SystemExit(2)
