#!/usr/bin/env python3
"""Read-only immutable-package preflight. Never starts a server or provider."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

NAMES = frozenset({"server_binary", "provider_native", "python_interpreter",
                   "broker_launcher", "broker_config", "broker_server",
                   "broker_configuration", "broker_protocol", "broker_transport"})
PACKAGE = frozenset(name for name in NAMES if name.startswith("broker_"))
PACKAGE_FILES = {"broker_launcher": "launcher", "broker_config": "broker-private.json",
                 "broker_server": "server.py", "broker_configuration": "configuration.py",
                 "broker_protocol": "protocol.py", "broker_transport": "transport.py"}
LIMIT = 512 * 1024 * 1024


class Refused(Exception):
    """Only fixed error codes may leave the verifier."""


def require(value, code):
    if not value:
        raise Refused(code)


def exact(value, names):
    require(isinstance(value, dict) and set(value) == set(names), "invalid_manifest_shape")


def object_unique(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "duplicate_manifest_key")
        value[key] = item
    return value


def protected(path, *, directory=False):
    require(isinstance(path, (str, Path)), "invalid_artifact_path")
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path,
            "artifact_path_not_canonical")
    for ancestor in [*reversed(path.parents), path]:
        info = ancestor.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022,
                "artifact_or_ancestor_has_untrusted_writer")
        if ancestor != path or directory:
            require(stat.S_ISDIR(info.st_mode), "artifact_ancestor_not_directory")
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                    "artifact_not_unaliased_regular_file")
    return path


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read_protected(path, limit=LIMIT, retain=False):
    path = protected(path)
    before = path.lstat()
    require(before.st_size <= limit, "artifact_size_limit")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        require(fingerprint(before) == fingerprint(os.fstat(fd)), "artifact_changed_during_read")
        digest, size, chunks = hashlib.sha256(), 0, []
        while True:
            chunk = os.read(fd, min(1024 * 1024, limit + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            require(size <= limit, "artifact_size_limit")
            digest.update(chunk)
            if retain:
                chunks.append(chunk)
        require(fingerprint(before) == fingerprint(os.fstat(fd))
                == fingerprint(path.lstat()), "artifact_changed_during_read")
        # Check every ancestor again after reading, rather than trusting an old
        # canonicalization result. A hostile root remains outside this boundary.
        protected(path)
        return digest.hexdigest(), b"".join(chunks)
    finally:
        os.close(fd)


def verify(manifest_path):
    manifest_hash, raw = read_protected(manifest_path, 32 * 1024, retain=True)
    manifest = json.loads(raw.decode("utf-8"), object_pairs_hook=object_unique)
    exact(manifest, {"schema_version", "mode", "server_source", "broker_source",
                     "package_root", "artifacts"})
    require(manifest["schema_version"] == 1 and type(manifest["schema_version"]) is int
            and manifest["mode"] == "isolated-codex-acceptance-v1", "unsupported_manifest")
    for key in ("server_source", "broker_source"):
        require(isinstance(manifest[key], str)
                and re.fullmatch("[a-f0-9]{40}", manifest[key]), "source_pin_required")
    exact(manifest["artifacts"], NAMES)
    package = protected(manifest["package_root"], directory=True)
    paths, hashes, package_files = set(), {}, set()
    for name, artifact in manifest["artifacts"].items():
        exact(artifact, {"path", "sha256"})
        require(isinstance(artifact["sha256"], str)
                and re.fullmatch("[a-f0-9]{64}", artifact["sha256"]), "artifact_pin_required")
        path = protected(artifact["path"])
        require(path not in paths, "artifact_alias_refused")
        paths.add(path)
        if name in PACKAGE:
            require(path.parent == package, "broker_file_outside_package")
            require(path.name == PACKAGE_FILES[name], "unexpected_broker_filename")
            package_files.add(path.name)
        digest, _ = read_protected(path)
        require(digest == artifact["sha256"], "artifact_hash_mismatch")
        if name in {"server_binary", "provider_native", "python_interpreter", "broker_launcher"}:
            require(path.stat().st_mode & 0o111, "artifact_not_executable")
        hashes[name] = digest
    # No additional importable source, bytecode cache, symlink or subdirectory.
    # The interpreter/stdlib are an explicitly trusted system boundary.
    require({entry.name for entry in package.iterdir()} == package_files,
            "unexpected_broker_package_entry")
    return {"schema_version": 1, "status": "verified", "mode": manifest["mode"],
            "server_source": manifest["server_source"], "broker_source": manifest["broker_source"],
            "manifest_sha256": manifest_hash, "artifacts": hashes,
            "provider_started": False, "credentials_read": False,
            "scope": "immutable_artifacts_only_not_dispatch_or_os_isolation_acceptance"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest")
    args = parser.parse_args()
    try:
        result = verify(args.manifest)
    except Refused as error:
        result = {"status": "refused", "code": str(error), "provider_started": False}
    except Exception:
        result = {"status": "refused", "code": "package_unavailable_or_invalid", "provider_started": False}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "verified" else 1


if __name__ == "__main__":
    sys.exit(main())
