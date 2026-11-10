"""Fixed, inert persisted activity projections; never an execution-health oracle.

Authorities: storage/thread-message-schema.js and thread-message-registry.js
messageColumns; core/threads.js createThread; core/reply-delivery-intent.js
whatsappReplyDeliveryBindingEligible; core/timers.js markDueTimersPass;
core/runtime-leases.js lease construction; browsers/desktop-lease-store.js.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import stat
import time
from registry_inventory import _object, MAX_BYTES, MAX_ROWS


def _stamp(value, now):
    if value is None or value == '':
        return 'missing'
    if type(value) is not str:
        return 'invalid'
    try:
        at = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if at.tzinfo is None:
            return 'invalid'
        seconds = (now - at).total_seconds()
    except (ValueError, OverflowError):
        return 'invalid'
    return 'future' if seconds < 0 else 'within_24h' if seconds <= 86400 else 'within_30d' if seconds <= 2592000 else 'older'


def project_registry(value, family, now):
    if family == 'desktop':
        if type(value) is not dict or type(value.get('desktopLeases')) is not list:
            raise ValueError('unsupported desktop registry shape')
        value = value['desktopLeases']
    if family not in ('desktop', 'runtime', 'timers') or type(value) is not list or len(value) > MAX_ROWS:
        raise ValueError('unsupported registry shape')
    fields = {'desktop': ('heartbeatAt', 'expiresAt', 'releasedAt'),
              'runtime': ('heartbeatAt', 'startedAt', 'endedAt'),
              'timers': ('lastRunAt', 'lastManualRunAt', 'lastErrorAt', 'nextRunAt')}[family]
    buckets = ('missing', 'invalid', 'future', 'within_24h', 'within_30d', 'older')
    counts = {field: dict.fromkeys(buckets, 0) for field in fields}
    counts.update(rows=len(value), non_objects=0, unreleased_or_unended=0, unreleased_or_unended_heartbeat_5m=0)
    for row in value:
        if type(row) is not dict:
            counts['non_objects'] += 1
            continue
        for field in fields:
            counts[field][_stamp(row.get(field), now)] += 1
        if family in ('desktop', 'runtime'):
            ending = 'releasedAt' if family == 'desktop' else 'endedAt'
            if row.get(ending) in (None, ''):
                counts['unreleased_or_unended'] += 1
                try:
                    age = (now-datetime.fromisoformat(str(row.get('heartbeatAt')).replace('Z', '+00:00'))).total_seconds()
                    counts['unreleased_or_unended_heartbeat_5m'] += int(0 <= age <= 300)
                except (ValueError, TypeError, OverflowError):
                    pass
    return {'counts': counts, 'meaning': 'persisted timestamps only; no process, connector, scheduler or lease validity proof'}


def read_registry(home, family, now):
    filename = {'desktop': 'desktop-leases.json', 'runtime': 'runtime-leases.json', 'timers': 'timers.json'}[family]
    directory = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return {'status': 'unavailable_missing_file'}
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_BYTES or before.st_nlink != 1:
                raise ValueError('unsupported registry file')
            data = bytearray()
            while len(data) <= MAX_BYTES:
                chunk = os.read(fd, min(65536, MAX_BYTES + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            if len(data) > MAX_BYTES or identity(before) != identity(os.fstat(fd)) or identity(before) != identity(os.stat(filename, dir_fd=directory, follow_symlinks=False)):
                raise ValueError('registry changed during read')
            value = json.loads(data, object_pairs_hook=_object,
                               parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
            return {'status': 'observed', **project_registry(value, family, now)}
        finally:
            os.close(fd)
    finally:
        os.close(directory)


# These expressions return only count values. All paths/constants are fixed.
_DOC = "CASE WHEN typeof(source.data)='text' AND json_valid(source.data) THEN source.data ELSE '{}' END"
THREAD = {
    'malformed_or_nontext': "typeof(source.data)<>'text' OR NOT json_valid(source.data)",
    'binding_object': "json_type(doc,'$.binding')='object'",
    'binding_disabled': "json_type(doc,'$.binding.enabled')='false'",
    'route_ineligible': "json_type(doc,'$.binding.routeEligible')='false'",
    'mirror_disabled': "json_type(doc,'$.binding.mirrorToWhatsApp')='false' OR json_type(doc,'$.binding.mirrorReplies')='false'",
    'binding_retired': "json_type(doc,'$.binding.retired')='true' OR json_type(doc,'$.binding.deprecated')='true'",
    'binding_whatsapp_explicit': "json_extract(doc,'$.binding.connector') COLLATE BINARY='whatsapp'",
    'local_repo_reference': "json_type(doc,'$.repoPath')='text' AND length(json_extract(doc,'$.repoPath'))>0",
    'worktree_reference': "json_type(doc,'$.worktreePath')='text' AND length(json_extract(doc,'$.worktreePath'))>0",
    'runtime_reference': "json_type(doc,'$.activeRuntimeLeaseId')='text' AND length(json_extract(doc,'$.activeRuntimeLeaseId'))>0",
    'state_running': "json_extract(doc,'$.state') COLLATE BINARY='running'",
    'updated_24h': "julianday(json_extract(doc,'$.updatedAt')) BETWEEN julianday(?)-1 AND julianday(?)",
    'updated_30d': "julianday(json_extract(doc,'$.updatedAt')) BETWEEN julianday(?)-30 AND julianday(?)",
}
MESSAGE = {
    'malformed_or_nontext': "typeof(source.data)<>'text' OR NOT json_valid(source.data)",
    'whatsapp': "source.connector COLLATE BINARY='whatsapp'",
    'owner_or_user': "source.role COLLATE BINARY IN ('owner','user')",
    'assistant': "source.role COLLATE BINARY='assistant'",
    'recent_24h': "julianday(source.created_at) BETWEEN julianday(?)-1 AND julianday(?)",
    'recent_30d': "julianday(source.created_at) BETWEEN julianday(?)-30 AND julianday(?)",
    'whatsapp_recent_30d': "source.connector COLLATE BINARY='whatsapp' AND julianday(source.created_at) BETWEEN julianday(?)-30 AND julianday(?)",
    'has_attachments': "json_type(doc,'$.attachments')='array' AND json_array_length(doc,'$.attachments')>0",
    'attachments_recent_30d': "json_type(doc,'$.attachments')='array' AND json_array_length(doc,'$.attachments')>0 AND julianday(source.created_at) BETWEEN julianday(?)-30 AND julianday(?)",
}


def database_projection(path, family, now):
    table, expressions, columns = {
        'threads': ('orkestr_threads', THREAD, ('', 'data')),
        'messages': ('orkestr_thread_messages', MESSAGE, ('', 'data', 'connector', 'role', 'created_at')),
    }[family]
    source = Path(path)
    if any(part.is_symlink() for part in (source, *source.parents)) or not source.is_file():
        raise ValueError('existing regular database required')
    db = sqlite3.connect(source.resolve().as_uri()+'?mode=ro', uri=True, isolation_level=None, timeout=2, cached_statements=0)
    try:
        deadline = time.monotonic()+8
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        db.enable_load_extension(False)
        db.execute('PRAGMA query_only=ON')
        db.execute('PRAGMA trusted_schema=OFF')
        db.execute('BEGIN')
        metadata = {row[1]: row[2] for row in db.execute('PRAGMA main.table_list') if row[0] == 'main'}
        if metadata.get(table) != 'table':
            return {'status': 'unavailable_missing_or_unsupported_table'}
        def authorize(action, arg1, arg2, database, trigger):
            if trigger is not None:
                return sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_SELECT:
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_READ and arg1 == table and arg2 in columns and database in ('main', None):
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_FUNCTION and arg2 in ('count', 'sum', 'coalesce', 'typeof', 'json_valid', 'json_type', 'json_extract', 'json_array_length', 'length', 'julianday'):
                return sqlite3.SQLITE_OK
            return sqlite3.SQLITE_DENY
        db.set_authorizer(authorize)
        values = ','.join('coalesce(sum(CASE WHEN '+expression+' THEN 1 ELSE 0 END),0)' for expression in expressions.values())
        params = [now.isoformat()] * sum(expression.count('?') for expression in expressions.values())
        # Keep qualified source columns, preventing SQLite double-quoted string fallback.
        selected = ','.join('source.'+column for column in columns if column)
        selected = selected + ',' if selected else ''
        input_source = f'main.{table}'
        if family == 'messages':
            allowed = ','.join(column for column in columns if column)
            input_source = f'(SELECT {allowed} FROM main.{table} LIMIT 10000)'
        query = f'SELECT count(*),{values} FROM (SELECT {selected}{_DOC} AS doc FROM {input_source} AS source) AS source'
        row = db.execute(query, params).fetchone()
        return {'status': 'observed', 'rows': row[0], 'counts': dict(zip(expressions, row[1:])),
                'meaning': 'persisted configuration and timestamped records; not current running work or delivery proof',
                'consistency': 'one pinned read-only transaction', 'cross_store_consistency': False,
                'coverage': 'bounded_first_10000_storage_rows_not_latest; counts are lower bounds' if family == 'messages' else 'all persisted thread rows'}
    finally:
        db.close()
