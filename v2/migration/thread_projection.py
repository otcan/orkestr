"""Fixed structural JSON aggregates for the primary persisted thread authority.

Review candidate: all JSON evaluation stays inside fixed SQLite expressions.
No arbitrary path, SQL, grouping key or raw value is accepted or returned.
"""
import sqlite3
from live_census import _read_transaction, _now

QUALITY = ('object', 'malformed_json', 'non_object', 'unsupported_storage')
ENUMS = {
    'role': ('$.threadKind', ('worker', 'task-agent')),
    'runtime_top': ('$.runtimeKind', ('codex-app-server', 'codex-tmux', 'claude-code', 'api-agent', 'raw-terminal')),
    'runtime_nested': ('$.runtime.runtimeKind', ('codex-app-server', 'codex-tmux', 'claude-code', 'api-agent', 'raw-terminal')),
    'runtime_metadata': ('$.executor.metadata.runtimeKind', ('codex-app-server', 'codex-tmux', 'claude-code', 'api-agent', 'raw-terminal')),
    'executor_type': ('$.executor.type', ('generic', 'codex', 'claude-code', 'api-agent')),
    'lifecycle': ('$.lifecycleState', ('active', 'retired')),
    'lifecycle_legacy': ('$.lifecycle', ('active', 'retired')),
    'state': ('$.state', ('sleeping', 'waking', 'running', 'blocked', 'retiring', 'retired')),
}
TEXT_FLAGS = {
    'parent_reference': '$.parentThreadId',
    'root_reference': '$.rootThreadId',
    'browser_reference': '$.browserSlug',
    'desktop_reference': '$.desktopSlug',
    'managed_desktop_reference': '$.managedDesktopSlug',
}
BOOL_FLAGS = {'retired_marker': '$.retired', 'archived_marker': '$.archived'}
# Object shape only: binding fields/connector/chat identifiers are never selected.
OBJECT_FLAGS = {'binding_object': '$.binding'}


def _invalid_ancestor(path):
    parts = path.split('.')
    checks = []
    for end in range(2, len(parts)):
        parent = '.'.join(parts[:end])
        checks.append(f"json_type(doc, '{parent}') NOT IN ('object', 'null')")
    return ' OR '.join(checks) or '0'


def _enum(path, values):
    kind, value = f"json_type(doc, '{path}')", f"(json_extract(doc, '{path}') COLLATE BINARY)"
    return (f"CASE WHEN quality <> 'object' THEN quality "
            f"WHEN ({_invalid_ancestor(path)}) THEN 'unsupported' "
            f"WHEN {kind} IS NULL OR {kind} = 'null' THEN 'missing' "
            f"WHEN {kind} <> 'text' THEN 'unsupported' "
            f"WHEN {value} = '' THEN 'empty' " + ''.join(
                f"WHEN {value} = '{v}' THEN '{v}' " for v in values) + "ELSE 'unknown' END",
            (*values, 'missing', 'empty', 'unknown', 'unsupported', *QUALITY[1:]))


def _flag(path, kind):
    typ = f"json_type(doc, '{path}')"
    base = (f"CASE WHEN quality <> 'object' THEN quality "
            f"WHEN {typ} IS NULL OR {typ} = 'null' THEN 'absent' ")
    if kind == 'text':
        body = (f"WHEN {typ} <> 'text' THEN 'unsupported' "
                f"WHEN length(trim(json_extract(doc, '{path}'))) = 0 THEN 'absent' "
                "ELSE 'present' END")
        buckets = ('present', 'absent', 'unsupported')
    elif kind == 'boolean':
        body = f"WHEN {typ} = 'true' THEN 'true' WHEN {typ} = 'false' THEN 'false' ELSE 'unsupported' END"
        buckets = ('true', 'false', 'absent', 'unsupported')
    else:
        body = f"WHEN {typ} = 'object' THEN 'present' ELSE 'unsupported' END"
        buckets = ('present', 'absent', 'unsupported')
    return base + body, (*buckets, *QUALITY[1:])


def _build():
    fields = {'quality': ('quality', QUALITY)}
    fields.update({name: _enum(path, values) for name, (path, values) in ENUMS.items()})
    for definitions, kind in ((TEXT_FLAGS, 'text'), (BOOL_FLAGS, 'boolean'), (OBJECT_FLAGS, 'object')):
        fields.update({name: _flag(path, kind) for name, path in definitions.items()})
    # Explicit CASE guards prevent malformed/non-text JSON from reaching JSON paths.
    source = """(
      SELECT CASE WHEN typeof(source.data) = 'text' THEN
                    CASE WHEN json_valid(source.data) THEN source.data ELSE 'null' END
                  ELSE 'null' END AS doc,
             CASE WHEN typeof(source.data) <> 'text' THEN 'unsupported_storage'
                  WHEN NOT json_valid(source.data) THEN 'malformed_json'
                  WHEN json_type(source.data) <> 'object' THEN 'non_object'
                  ELSE 'object' END AS quality
      FROM main.orkestr_threads AS source
    ) AS safe"""
    expressions, slots = [], []
    for name, (expression, buckets) in fields.items():
        for bucket in buckets:
            expressions.append(f"coalesce(sum(CASE WHEN ({expression}) = '{bucket}' THEN 1 ELSE 0 END), 0)")
            slots.append((name, bucket))
    return 'SELECT ' + ', '.join(expressions) + ' FROM ' + source, tuple(slots)


QUERY, SLOTS = _build()


def _authorize(action, arg1, arg2, database, trigger):
    if trigger is not None:
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_SELECT:
        return sqlite3.SQLITE_OK
    if (action == sqlite3.SQLITE_READ and arg1 == 'orkestr_threads'
            and arg2 in ('', 'data') and database in (None, 'main')):
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_FUNCTION and arg2 in (
            'sum', 'coalesce', 'typeof', 'json_valid', 'json_type', 'json_extract', 'length', 'trim'):
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def thread_metadata_projection(path):
    """Return only fixed bucket counts for persisted configuration, not activity."""
    started = _now()
    with _read_transaction(path, 'threads') as (db, metadata):
        if metadata.get('orkestr_threads') != 'table':
            return {'format_version': 1, 'status': 'unavailable', 'coverage': 'partial'}
        db.set_authorizer(_authorize)
        values = db.execute(QUERY).fetchone()
    buckets = {}
    for (name, bucket), value in zip(SLOTS, values):
        buckets.setdefault(name, {})[bucket] = value
    return {'format_version': 1, 'status': 'observed', 'coverage': 'partial',
            'started_at': started, 'finished_at': _now(), 'buckets': buckets,
            'consistency': 'single-store-read-transaction', 'cross_store_consistency': False,
            'meaning': 'persisted explicit metadata only; not current execution, effective runtime or capability availability'}
