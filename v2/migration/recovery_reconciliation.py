"""Private reconciliation of explicit frozen local-recovery copies, never a live exporter.

This supplements Installation's opaque same-package dormant backup. It cannot
activate a database, apply history, transfer auth or reverse-import into V1.
"""
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import struct

FORMAT = 'orkestr-v2-recovery-reconciliation-v1'
MAX_BYTES = 64 * 1024 * 1024
MAX_ROWS = 100_000
POLICY = {
    'history': 'retained with provenance; portable history-only Store recovery remains separate',
    'queued_held_unknown': 'opaque local recovery only; launcher must remain dormant',
    'steering_worker_budget_timer': 'retain exact evidence; never recreate issuer or enable rights',
    'auth': 'opaque sensitive local backup only; not a migration credential export',
    'rollback': 'untouched dormant target only; restore original old package+DB, never downgrade SQL',
}
# Fixed structural predicates. These are presence/state evidence, never use or
# permission to resume. No arbitrary columns, JSON, identities or payload output.
PROJECTIONS = {
    'queued_inputs': ('reasoning_inbox', "state='queued'"),
    'stop_held_inputs': ('production_held_inputs', '1'),
    'accepted_runs': ('production_acceptances', '1'),
    'unknown_runs': ('production_runs', "dispatch_state='delivery_unknown'"),
    'history_messages': ('history_messages', '1'),
    'held_tasks': ('worker_tasks', "state='held'"),
    'owner_budget_tasks': ('worker_tasks', 'execution_budget_ms IS NOT NULL'),
    'worker_budgets': ('worker_running_budgets', '1'),
    'steering_queued': ('production_steering', "state='queued'"),
    'steering_unknown': ('production_steering', "state='delivery_unknown'"),
    'steering_acknowledged': ('production_steering', "state='acknowledged'"),
    'worker_result_unknown': ('worker_tool_results', "state='delivery_unknown'"),
    'timer_grants': ('durable_timer_authorities', '1'),
}


def need(value, reason):
    if not value:
        raise ValueError(reason)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def encoded(value):
    # Typed, length-delimited row hashing avoids NULL/text/blob/float ambiguity.
    if value is None:
        return b'n'
    if isinstance(value, bytes):
        tag, data = b'b', value
    elif isinstance(value, str):
        tag, data = b's', value.encode('utf-8')
    elif isinstance(value, int):
        tag, data = b'i', str(value).encode()
    else:
        tag, data = b'f', struct.pack('>d', value)
    return tag + struct.pack('>Q', len(data)) + data


def inspect_frozen(database, expected_sha256, migrations):
    """Only a completed private backup/stopped copy, with an externally pinned hash.

    immutable=1 is intentionally restricted to a standalone copied file; never
    pass a changing WAL authority. The function neither initializes nor writes DBs.
    """
    path = Path(database).absolute()
    need(path.resolve() == path and path.is_file() and not path.is_symlink(), 'regular canonical frozen copy required')
    need(not any(Path(str(path) + suffix).exists() for suffix in ('-wal', '-shm', '-journal')), 'standalone frozen copy required')
    need(path.stat().st_size <= MAX_BYTES, 'database size bound')
    raw = path.read_bytes()
    need(sha(raw) == expected_sha256, 'database digest mismatch')
    connection = sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('PRAGMA trusted_schema=OFF')
        need(connection.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'integrity refusal')
        need(not connection.execute('PRAGMA foreign_key_check').fetchall(), 'foreign key refusal')
        versions = connection.execute('SELECT version,success,checksum FROM _sqlx_migrations ORDER BY version').fetchall()
        need(versions and [r[0] for r in versions] == list(range(1, versions[-1][0] + 1)), 'noncontiguous migrations')
        need(versions[-1][0] <= 36, 'unsupported future schema')
        migration_hashes = {}
        for version, success, checksum in versions:
            matches = list(Path(migrations).glob(f'{version:04d}_*.sql'))
            need(success == 1 and len(matches) == 1, 'migration source missing or failed')
            sql = matches[0].read_bytes()
            need(hashlib.sha384(sql).digest() == checksum, 'migration checksum mismatch')
            migration_hashes[str(version)] = sha(sql)
        schema = connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
        tables = [r[1] for r in schema if r[0] == 'table']
        need(len(tables) <= 256, 'table bound')
        result = {}
        total_bytes = 0
        for table in tables:
            columns = [r[1] for r in connection.execute('PRAGMA table_info(' + quote(table) + ')')]
            rows = []
            for row in connection.execute('SELECT * FROM ' + quote(table)):
                data = b''.join(encoded(value) for value in row)
                total_bytes += len(data)
                need(total_bytes <= MAX_BYTES and len(rows) < MAX_ROWS, 'reconciliation row/byte bound')
                rows.append(hashlib.sha256(data).digest())
            # Preserve multiplicity independently of storage order; no row hashes escape.
            result[table] = {'columns': columns, 'rows': len(rows), 'digest': sha(b''.join(sorted(rows)))}
        coverage = {}
        for label, (table, predicate) in PROJECTIONS.items():
            if table not in result or (label == 'owner_budget_tasks' and 'execution_budget_ms' not in result[table]['columns']):
                coverage[label] = {'status': 'schema_unavailable'}
            else:
                coverage[label] = {'status': 'observed', 'rows': connection.execute('SELECT count(*) FROM ' + quote(table) + ' WHERE ' + predicate).fetchone()[0]}
        return {'schema_version': versions[-1][0], 'database_sha256': expected_sha256,
                'schema_sha256': sha(canonical(schema)), 'migrations_sha256': migration_hashes,
                'tables': result, 'coverage': coverage}
    finally:
        connection.close()
        need(sha(path.read_bytes()) == expected_sha256, 'frozen copy changed')


def from_snapshot(snapshot, migrations):
    """Read Installation's already completed single-DB snapshot, not a home selector."""
    root = Path(snapshot).absolute()
    need(root.resolve() == root and root.is_dir(), 'canonical snapshot root required')
    manifest_path = root / 'manifest.json'
    need(not manifest_path.is_symlink() and manifest_path.stat().st_size <= 16384, 'bounded regular manifest required')
    def pairs(items):
        out = {}
        for key, value in items:
            need(key not in out, 'duplicate manifest key')
            out[key] = value
        return out
    source = json.loads(manifest_path.read_text(), object_pairs_hook=pairs)
    need(source.get('format') == 'orkestr-v2-local-recovery-v1', 'local recovery format required')
    need(set(source.get('files', {})) == {'core.sqlite3'}, 'single database inventory required')
    need(bool(re.fullmatch('[0-9a-f]{40}', source.get('source_commit', ''))), 'source commit required')
    digest = source['files']['core.sqlite3']
    need(bool(re.fullmatch('[0-9a-f]{64}', digest)), 'database checksum required')
    value = {'format': FORMAT, 'source_commit': source['source_commit'], 'source_release': source['source_release'],
             'policy': POLICY, 'cut': inspect_frozen(root / 'core.sqlite3', digest, migrations)}
    value['manifest_digest'] = sha(canonical(value))
    return value


def reconcile(expected, actual):
    """Exact private evidence comparison; changed state/payload/provenance refuses."""
    need(expected == actual, 'recovery reconciliation mismatch')
    unsigned = {key: value for key, value in expected.items() if key != 'manifest_digest'}
    need(expected.get('format') == FORMAT and expected.get('manifest_digest') == sha(canonical(unsigned)), 'invalid reconciliation manifest digest')
    return {'status': 'exact frozen-copy reconciliation', 'manifest_digest': expected['manifest_digest'],
            'activation': 'prohibited; dormant target only'}
