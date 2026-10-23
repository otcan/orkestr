"""Audited local-admin suppression of one completed, never-transported export.

This is a negative disposition, not a delivery acknowledgement. It preserves
the complete input and export text and never calls Core, V1 or a provider.
Invoke with python3 -I -S -B; inspect is read-only and is the default action.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time


class Refused(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def connect(path, writable=False):
    path = Path(path)
    require(not path.is_symlink() and path.is_file(), "existing_regular_ledger_required")
    require(path.stat().st_uid == os.geteuid() and not path.stat().st_mode & 0o077,
            "ledger_permissions")
    require(path.parent.stat().st_uid == os.geteuid() and not path.parent.stat().st_mode & 0o022,
            "ledger_parent_permissions")
    mode = "rw" if writable else "ro"
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=" + mode, uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA synchronous=FULL")
    return db


def selected(db, export_id):
    schema = db.execute("SELECT value FROM ledger_meta WHERE key='schema'").fetchone()
    require(schema is not None and schema[0] == "2", "ledger_schema_unsupported")
    scope = db.execute("SELECT identity FROM ledger_scope WHERE singleton=1").fetchone()
    require(scope is not None, "ledger_scope_missing")
    row = db.execute("SELECT * FROM exports WHERE export_id=?", (export_id,)).fetchone()
    require(row is not None, "unknown_export")
    item = db.execute("SELECT * FROM inputs WHERE remote_id=?", (row['input_id'],)).fetchone()
    require(item is not None, "export_input_missing")
    return scope[0], row, item


def inspect(path, export_id):
    with connect(path) as db:
        db.execute("BEGIN")
        scope, row, item = selected(db, export_id)
        return {"read_only": True, "export_id": row['export_id'], "sequence": row['seq'],
                "input_id": row['input_id'], "kind": row['kind'], "outcome": row['outcome'],
                "ack_present": row['ack'] is not None, "phase": json.loads(item['data']).get('phase'),
                "scope_sha256": digest(scope), "message_sha256": digest(row['message'])}


def audit_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS export_admin_dispositions (
        request_key TEXT PRIMARY KEY, semantic_digest TEXT NOT NULL,
        export_id TEXT UNIQUE NOT NULL, input_id TEXT NOT NULL, scope_identity TEXT NOT NULL,
        full_export_message TEXT NOT NULL, full_input_data TEXT NOT NULL,
        reason TEXT NOT NULL, actor_uid INTEGER NOT NULL, disposed_at_ms INTEGER NOT NULL,
        receipt_json TEXT NOT NULL)""")
    for operation in ("UPDATE", "DELETE"):
        db.execute("CREATE TRIGGER IF NOT EXISTS export_admin_dispositions_no_%s BEFORE %s "
                   "ON export_admin_dispositions BEGIN SELECT RAISE(ABORT,'immutable_export_disposition'); END"
                   % (operation.lower(), operation))


def suppress(path, export_id, *, input_id, scope_sha256, message_sha256,
             request_key, reason, confirm_never_transported=False):
    require(confirm_never_transported is True, "never_transported_confirmation_required")
    require(isinstance(request_key, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", request_key), "invalid_request_key")
    require(isinstance(reason, str) and 1 <= len(reason.strip()) <= 2000 and '\0' not in reason, "invalid_reason")
    require(all(isinstance(x, str) and re.fullmatch(r"[a-f0-9]{64}", x)
                for x in (scope_sha256, message_sha256)), "exact_digests_required")
    decision = {"export_id": export_id, "input_id": input_id, "scope_sha256": scope_sha256,
                "message_sha256": message_sha256, "request_key": request_key,
                "reason": reason, "confirm_never_transported": True}
    semantic = digest(json.dumps(decision, sort_keys=True, separators=(',', ':')))
    with connect(path, writable=True) as db:
        db.execute("BEGIN IMMEDIATE")
        scope, row, item = selected(db, export_id)
        require(digest(scope) == scope_sha256, "scope_changed")
        require(row['input_id'] == input_id, "input_mismatch")
        require(digest(row['message']) == message_sha256, "export_changed")
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='export_admin_dispositions'").fetchone()
        previous = db.execute("SELECT semantic_digest,receipt_json FROM export_admin_dispositions WHERE request_key=?", (request_key,)).fetchone() if exists else None
        if previous:
            require(previous['semantic_digest'] == semantic, "request_key_conflict")
            require(row['outcome'] == 'suppressed' and row['ack'] is None, "disposition_changed")
            return dict(json.loads(previous['receipt_json']), duplicate=True)
        data = json.loads(item['data'])
        require(row['kind'] == 'final' and data.get('phase') == 'completed', "completed_final_required")
        require(row['outcome'] is None and row['ack'] is None and not data.get('settled'), "transport_or_disposition_already_recorded")
        require(not data.get('burst') and not data.get('absorbed_into'), "batched_input_refused")
        other = db.execute("SELECT count(*) FROM exports WHERE input_id=? AND export_id!=? AND (outcome IS NULL OR outcome='uncertain')",
                           (input_id, export_id)).fetchone()[0]
        require(other == 0, "other_pending_exports")
        audit_schema(db)
        at = int(time.time() * 1000)
        receipt = {"ok": True, "duplicate": False, "disposition": "suppressed",
                   "export_id": export_id, "input_id": input_id, "sequence": row['seq'],
                   "request_key": request_key, "reason": reason, "disposed_at_ms": at,
                   "acknowledged": False, "send_triggered": False, "full_text_retained": True}
        db.execute("INSERT INTO export_admin_dispositions VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                   (request_key, semantic, export_id, input_id, scope, row['message'], item['data'],
                    reason, os.geteuid(), at, json.dumps(receipt, sort_keys=True)))
        changed = db.execute("UPDATE exports SET outcome='suppressed' WHERE export_id=? AND outcome IS NULL AND ack IS NULL",
                             (export_id,)).rowcount
        require(changed == 1, "export_changed")
        # Do not call the transport settlement/pruning path. Both the current
        # records and immutable audit retain complete text; ACK stays NULL.
        data['settled'] = {"outcome": "suppressed", "atMs": at, "admin_request_key": request_key}
        db.execute("UPDATE inputs SET data=? WHERE remote_id=?", (json.dumps(data), input_id))
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['inspect', 'suppress'])
    parser.add_argument('--ledger', required=True, type=Path)
    parser.add_argument('--export-id', required=True)
    parser.add_argument('--input-id')
    parser.add_argument('--scope-sha256')
    parser.add_argument('--message-sha256')
    parser.add_argument('--request-key')
    parser.add_argument('--reason')
    parser.add_argument('--confirm-never-transported', action='store_true')
    args = parser.parse_args()
    try:
        if args.action == 'inspect':
            result = inspect(args.ledger, args.export_id)
        else:
            result = suppress(args.ledger, args.export_id, input_id=args.input_id,
                              scope_sha256=args.scope_sha256, message_sha256=args.message_sha256,
                              request_key=args.request_key, reason=args.reason,
                              confirm_never_transported=args.confirm_never_transported)
    except (Refused, sqlite3.Error, ValueError, OSError):
        # Never include private SQL, paths, payloads or values in an error.
        parser.exit(1, 'export_disposition_refused\n')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
