"""Count-only census of an explicitly supplied, independently consistent snapshot.

Never opens a source database through SQLite: bytes are deserialized in memory.
This adapter cannot establish snapshot consistency or authorize production access.
"""
import hashlib
from pathlib import Path
import sqlite3


TABLES = {
    "threads": ("orkestr_threads",),
    # Source: packages/core/src/personal-agent-memory-migration.js::tableName.
    # Count-only; never read content/provenance/consent or infer external memory.
    "personal_memory": ("personal_agent_memories",),
    "jobs": ("job_specs", "jobs", "runs", "attempts", "checkpoints", "effects",
             "approvals", "notifications", "trigger_audit", "schedule_state",
             "personal_agent_projects", "personal_agent_tasks"),
}
MAX_BYTES = 64 * 1024 * 1024


def count_snapshot(path, *, family, expected_sha256, consistency_receipt):
    """Return private aggregate metadata; missing tables are unknown, never zero.

    The caller supplies a reviewed snapshot receipt and digest. Receipt contents,
    paths, SQL definitions and records are never included in the report.
    """
    if family not in TABLES:
        raise ValueError("unsupported source family")
    if not isinstance(consistency_receipt, str) or not consistency_receipt.strip():
        raise ValueError("independent consistency receipt required")
    source = Path(path)
    if source.is_symlink() or not source.is_file():
        raise ValueError("regular snapshot file required")
    if any(Path(str(source) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise ValueError("standalone snapshot required")
    with source.open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("snapshot exceeds census size bound")
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ValueError("snapshot digest mismatch")
    db = sqlite3.connect(":memory:")
    try:
        db.deserialize(data)
        db.execute("PRAGMA trusted_schema=OFF")
        db.execute("PRAGMA query_only=ON")
        result = {}
        for table in TABLES[family]:
            # table_list inspects metadata without reading SQL definitions or rows.
            info = next((row for row in db.execute("PRAGMA main.table_list")
                         if row[1] == table), None)
            if info is None:
                result[table] = {"status": "absent", "count": None}
                continue
            if info[2] != "table":
                result[table] = {"status": "unsupported", "count": None}
                continue
            def authorize(action, arg1, arg2, _database, _trigger):
                if action == sqlite3.SQLITE_SELECT:
                    return sqlite3.SQLITE_OK
                if action == sqlite3.SQLITE_READ and arg1 == table and arg2 == "":
                    return sqlite3.SQLITE_OK
                if action == sqlite3.SQLITE_FUNCTION and arg2 == "count":
                    return sqlite3.SQLITE_OK
                return sqlite3.SQLITE_DENY
            db.set_authorizer(authorize)
            try:
                count = db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
            finally:
                db.set_authorizer(None)
            result[table] = {"status": "counted", "count": count}
        return {"format_version": 1, "family": family, "coverage": "partial",
                "counts": result, "exclusions": ["record contents", "identifiers",
                "credentials", "sessions", "routes", "profiles", "registry JSON",
                "other stores", "workflow usage semantics"]}
    finally:
        db.close()
