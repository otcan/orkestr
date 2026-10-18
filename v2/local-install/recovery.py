"""Database-aware V2 recovery snapshots. Canonical migration restore remains gated."""
from contextlib import closing
import json
import time
from pathlib import Path
import sqlite3

from helper import require
from install_state import (config, files, fresh_path, locked, package, private_home,
                           sha256, unprivileged, write_json)

SNAPSHOT_FORMAT = "orkestr-v2-local-recovery-v1"


def readonly(path, immutable=False):
    require(path.is_file() and not path.is_symlink(), "regular database file required")
    return sqlite3.connect(path.as_uri() + "?mode=ro" + ("&immutable=1" if immutable else ""), uri=True, timeout=2)


def integrity(database):
    require(database.execute("PRAGMA integrity_check").fetchall() == [("ok",)], "SQLite integrity check failed")
    require(not database.execute("PRAGMA foreign_key_check").fetchall(), "SQLite foreign key check failed")


def backup(raw_home, raw_output):
    unprivileged()
    home = private_home(raw_home)
    output = fresh_path(raw_output, (home,))
    with locked(home):
        current = config(home)
        _, manifest = package(home / "releases" / current["release"])
        # Never copy main DB bytes: the backup API includes committed WAL content.
        with closing(readonly(home / "data" / "core.sqlite3")) as source:
            output.mkdir(mode=0o700)
            destination = output / "core.sqlite3"
            with closing(sqlite3.connect(destination)) as target:
                destination.chmod(0o600)
                deadline = time.monotonic() + 30
                def progress(*_):
                    require(time.monotonic() < deadline, "SQLite backup deadline exceeded")
                source.backup(target, pages=256, progress=progress, sleep=0.05)
                target.execute("PRAGMA journal_mode=DELETE")
                integrity(target)
                schema = target.execute("PRAGMA user_version").fetchone()[0]
                # SQLite user_version is not falsely equated with server migration version.
            write_json(output / "manifest.json", {
                "format": SNAPSHOT_FORMAT, "scope": "single-database local recovery only",
                "source_release": current["release"], "source_commit": manifest["source_commit"],
                "sqlite_user_version": schema, "files": files(output),
                "contains_sensitive_database_auth": True,
                "excluded": ["bootstrap token", "provider home", "logs", "packages", "external artifacts"],
                "migration_restore": "blocked pending canonical manifest and dormant-state/auth policy",
            })
    return {"status": "database snapshot verified", "snapshot": str(output), "restore": "gated"}


def validate_snapshot(raw):
    root = Path(raw).resolve()
    require(root.is_dir(), "snapshot directory required")
    manifest = json.loads((root / "manifest.json").read_text())
    require(manifest.get("format") == SNAPSHOT_FORMAT, "not a supported local recovery snapshot")
    require(manifest.get("files") == files(root) and set(manifest["files"]) == {"core.sqlite3"},
            "snapshot checksum inventory mismatch")
    with closing(readonly(root / "core.sqlite3", immutable=True)) as database:
        integrity(database)
        require(database.execute("PRAGMA user_version").fetchone()[0] == manifest["sqlite_user_version"],
                "snapshot schema marker mismatch")
    return root, manifest


def restore_preview(raw_home, snapshot):
    """Validate target/package and archive without changing DB or adopting any auth state."""
    unprivileged()
    home = private_home(raw_home)
    with locked(home):
        current = config(home)
        package(home / "releases" / current["release"])
        root, manifest = validate_snapshot(snapshot)
        require(root != home and home not in root.parents and root not in home.parents,
                "snapshot and target home overlap")
        require(not any((home / "data").iterdir()), "restore target data directory must be empty")
    return {"status": "validated only; nothing restored", "apply": "PENDING canonical Migration contract",
            "source_release": manifest["source_release"], "target_release": current["release"],
            "gap": "requires schema compatibility, instance binding, auth/session disposition and dormant work/effect policy"}
