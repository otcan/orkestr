"""No-site bootstrap; verify protected package bytes before packaged imports."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


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


def verified(root, expected):
    path = root / "manifest.json"
    protected(path)
    if path.stat().st_size > 1024 * 1024 or (expected is not None and digest(path) != expected):
        raise ValueError("package manifest")
    def unique(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result
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
    for category in ("files", "ui", "dependencies"):
        values = manifest[category]
        if type(values) is not dict or not values or len(values) > 10000:
            raise ValueError("package inventory")
        for name, expected_hash in values.items():
            if type(name) is not str or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
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
            if digest(selected) != expected_hash:
                raise ValueError("package digest")
    interpreter = str(Path("/usr/bin/python3").resolve())
    if str(Path(sys.executable).resolve()) != interpreter or interpreter not in manifest["dependencies"]:
        raise ValueError("fixed interpreter")


def main():
    if not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:
        raise ValueError("no-site invocation required")
    root = Path(__file__).resolve().parents[1]
    mode, *arguments = sys.argv[1:]
    if mode not in ("manager", "broker", "broker-fast", "broker-worker-0", "broker-claude",
                    "broker-worker-1", "broker-worker-2", "broker-worker-3", "server"):
        raise ValueError("fixed entry mode")
    expected = arguments[0] if mode == "manager" and len(arguments) == 1 else None
    verified(root, expected)
    sys.path.insert(0, str(root))
    from codex_service.package import Package
    Package(root, expected)
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
