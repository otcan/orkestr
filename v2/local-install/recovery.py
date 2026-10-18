"""Database-aware V2 recovery snapshots. Same-package dormant apply only; migration/activation remain gated."""
from contextlib import closing
import json
import time
from pathlib import Path
import sqlite3

from helper import filesystem_disjoint, require
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
    return {"status": "database snapshot verified", "snapshot": str(output), "restore": "same-package dormant apply only; activation gated"}


def validate_snapshot(raw):
    root = Path(raw).resolve()
    require(root.is_dir(), "snapshot directory required")
    require(not (root / "manifest.json").is_symlink(), "snapshot manifest symlink refused")
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
        root = filesystem_disjoint(snapshot, [home])
        root, manifest = validate_snapshot(root)
        require(not any((home / "data").iterdir()), "restore target data directory must be empty")
    return {"status": "validated only; nothing restored", "apply": "PENDING canonical Migration contract",
            "source_release": manifest["source_release"], "target_release": current["release"],
            "gap": "requires schema compatibility, instance binding, auth/session disposition and dormant work/effect policy"}


def restore_apply(raw_home, snapshot):
    """Same-package offline recovery into empty data, permanently dormant until rollback.

    This preserves opaque database bytes/auth, does not adopt bootstrap credentials,
    rewrite schema, admit work or provide activation. Cross-version restore is refused.
    """
    unprivileged()
    home = private_home(raw_home)
    with locked(home):
        current = config(home)
        package(home / "releases" / current["release"])
        root, manifest = validate_snapshot(filesystem_disjoint(snapshot, [home]))
        require(manifest["source_release"] == current["release"], "same exact package release required")
        data, marker = home / "data", home / "control/restore-dormant.json"
        require(not marker.exists() and not marker.is_symlink(), "restore receipt already exists")
        require(not any(data.iterdir()), "restore target data directory must be empty")
        # Marker precedes any copy: interruption cannot permit launcher activation.
        write_json(marker, {"format": "orkestr-v2-dormant-restore-v1", "release": current["release"],
                            "database_sha256": manifest["files"]["core.sqlite3"],
                            "activation": "unsupported; rollback only", "auth": "opaque database preserved; target bootstrap unchanged"})
        import shutil
        import os
        stage = data / ".restore-stage"
        try:
            shutil.copyfile(root / "core.sqlite3", stage)
            stage.chmod(0o600)
            require(sha256(stage) == manifest["files"]["core.sqlite3"], "restore copied database checksum mismatch")
            with closing(readonly(stage, immutable=True)) as database:
                integrity(database)
            os.replace(stage, data / "core.sqlite3")
        finally:
            if stage.exists():
                stage.unlink()
    return {"status": "restored dormant; activation prohibited", "compatibility": "same exact package only"}


def restore_rollback(raw_home):
    """Undo only an untouched dormant apply, returning the previously empty data dir."""
    unprivileged()
    home = private_home(raw_home)
    with locked(home):
        marker = home / "control/restore-dormant.json"
        require(marker.is_file() and not marker.is_symlink(), "regular dormant restore receipt required")
        receipt = json.loads(marker.read_text())
        require(receipt.get("format") == "orkestr-v2-dormant-restore-v1" and
                receipt["release"] == config(home)["release"], "dormant receipt release mismatch")
        data = home / "data"
        contents = set(path.name for path in data.iterdir())
        require(contents <= {"core.sqlite3"}, "unexpected data files; rollback refused")
        database = data / "core.sqlite3"
        if contents:
            require(not database.is_symlink() and sha256(database) == receipt["database_sha256"],
                    "restored database changed; rollback refused")
            database.unlink()
        marker.unlink()
    return {"status": "dormant restore rolled back; original empty target retained"}
