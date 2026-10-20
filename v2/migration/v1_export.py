"""Consistent, read-only V1 thread history export into a private bundle.

SQLite sources are copied with the online backup API from a read-only
connection, so committed WAL frames are included and the live files are never
written. Only the selected threads' rows are extracted; the full backup copies
(which contain every thread) are deleted unless explicitly kept. Secrets,
OAuth state, browser profiles, routes and connector identities are never read.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
from urllib.parse import quote

import archive_digest
from v1_records import Skip, content_store, is_unsettled, message_of, safe_thread_id, thread_summary

FORMAT = 'orkestr-v1-thread-history'
EXCLUDED = ['secrets', 'oauth', 'browsers', 'credentials', 'connector routes and chat IDs',
            'provider sessions and executor bindings', 'outbox and bridge journals',
            'timers and jobs', 'non-selected threads']


class ExportError(ValueError):
    pass


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def _sha_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def _write(path, data):
    with open(path, 'xb') as stream:
        os.chmod(path, 0o600)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def backup(source, target):
    """Online backup from a read-only connection; includes committed WAL content."""
    src = sqlite3.connect(f'file:{quote(str(source))}?mode=ro', uri=True, timeout=30)
    try:
        dst = sqlite3.connect(target)
        try:
            src.backup(dst)
            info = {
                'page_count': dst.execute('PRAGMA page_count').fetchone()[0],
                'page_size': dst.execute('PRAGMA page_size').fetchone()[0],
                'user_version': dst.execute('PRAGMA user_version').fetchone()[0],
                'journal_mode': dst.execute('PRAGMA journal_mode').fetchone()[0],
            }
        finally:
            dst.close()
    finally:
        src.close()
    os.chmod(target, 0o600)
    info['backup_sha256'] = _sha_file(target)
    return info


def _rows(connection, sql, *args):
    connection.row_factory = sqlite3.Row
    return [dict(row) for row in connection.execute(sql, args)]


def _json_rows(path):
    with open(path, 'rb') as stream:
        value = json.loads(stream.read())
    rows = []
    for index, message in enumerate(value if isinstance(value, list) else [], start=1):
        if not isinstance(message, dict) or not str(message.get('id') or '').strip():
            continue
        cursor = message.get('cursor')
        rows.append({'id': str(message['id']).strip(), 'position': index,
                     'cursor': cursor if isinstance(cursor, int) and cursor > 0 else index,
                     'role': message.get('role') or message.get('kind'), 'state': message.get('state'),
                     'source': message.get('source'), 'phase': message.get('phase'),
                     'created_at': message.get('createdAt') or message.get('timestamp'),
                     'updated_at': message.get('updatedAt'), 'data': json.dumps(message)})
    return rows


def _registry(home, work, databases, thread_ids):
    db = home / 'threads.sqlite'
    found = {}
    if db.is_file():
        target = work / 'threads.sqlite'
        databases['threads.sqlite'] = backup(db, target)
        connection = sqlite3.connect(f'file:{quote(str(target))}?mode=ro', uri=True)
        try:
            for thread_id in thread_ids:
                for row in _rows(connection, 'SELECT data FROM orkestr_threads WHERE id=?', thread_id):
                    found[thread_id] = thread_summary(json.loads(row['data']))
        finally:
            connection.close()
        return 'threads.sqlite', found
    if (home / 'threads.json').is_file():
        with open(home / 'threads.json', 'rb') as stream:
            records = json.loads(stream.read())
        for record in records if isinstance(records, list) else []:
            if isinstance(record, dict) and record.get('id') in thread_ids:
                found[record['id']] = thread_summary(record)
        return 'threads.json', found
    return 'absent', found


def _select(rows, now, include_unsettled, window):
    """Contiguous settled prefix in position order; the rest is the unsettled tail."""
    if include_unsettled:
        return rows, []
    for index, row in enumerate(rows):
        if is_unsettled(row, now, window):
            return rows[:index], rows[index:]
    return rows, []


def _thread(home, out, connection, thread_id, now, include_unsettled, window, store):
    safe = safe_thread_id(thread_id)
    json_file = home / 'thread-messages' / f'{safe}.json'
    meta = _rows(connection, 'SELECT revision,migrated_at FROM orkestr_thread_message_meta WHERE thread_id=?',
                 thread_id) if connection else []
    evidence = None
    if meta:
        authority = 'sqlite'
        rows = _rows(connection, 'SELECT * FROM orkestr_thread_messages WHERE thread_id=? ORDER BY position', thread_id)
    elif json_file.is_file():
        authority, rows = 'json', _json_rows(json_file)
    else:
        raise ExportError('thread_history_not_found')
    if authority == 'sqlite' and json_file.is_file() and not os.access(json_file, os.R_OK):
        evidence = {'unreadable': True}
    elif authority == 'sqlite' and json_file.is_file():
        # Non-authoritative legacy copy: preserved as private evidence with divergence counts.
        copy = out / 'evidence' / f'{safe}.json'
        copy.parent.mkdir(mode=0o700, exist_ok=True)
        _write(copy, json_file.read_bytes())
        legacy = {row['id'] for row in _json_rows(copy)}
        current = {row['id'] for row in rows}
        evidence = {'file': f'evidence/{safe}.json', 'sha256': _sha_file(copy), 'messages': len(legacy),
                    'only_in_json': len(legacy - current), 'only_in_sqlite': len(current - legacy)}
    selected, tail = _select(rows, now, include_unsettled, window)
    messages, skipped, unavailable, roles, states = [], {}, {}, {}, {}
    for row in selected:
        try:
            message, reasons = message_of(row, home, thread_id, store)
        except (Skip, ValueError, TypeError) as error:
            reason = str(error) if isinstance(error, Skip) else 'invalid_row'
            skipped.setdefault(reason, []).append(str(row.get('id'))[:256])
            continue
        for reason in reasons:
            unavailable[reason] = unavailable.get(reason, 0) + 1
        roles[message['role']] = roles.get(message['role'], 0) + 1
        state = message['state'] or ''
        states[state] = states.get(state, 0) + 1
        messages.append(message)
    (out / 'threads').mkdir(mode=0o700, exist_ok=True)
    directory = out / 'threads' / safe
    directory.mkdir(mode=0o700)
    body = b''.join(_canonical(m) + b'\n' for m in messages)
    _write(directory / 'messages.jsonl', body)
    return {
        'thread_id': thread_id, 'directory': f'threads/{safe}', 'authority': authority,
        'meta_revision': meta[0]['revision'] if meta else None,
        'source_messages': len(rows), 'exported': len(messages),
        'watermark': selected[-1]['position'] if selected else 0,
        'unsettled_tail': len(tail), 'quarantined': {k: len(v) for k, v in sorted(skipped.items())},
        'quarantined_ids': {k: v for k, v in sorted(skipped.items())},
        'attachments': {'copied': sum(a['available'] for m in messages for a in m['attachments']),
                        'unavailable': dict(sorted(unavailable.items()))},
        'roles': dict(sorted(roles.items())), 'states': dict(sorted(states.items())),
        'messages_sha256': hashlib.sha256(body).hexdigest(),
        'checksum': archive_digest.checksum(messages), 'legacy_json': evidence,
    }


def _check_paths(home, output):
    home = Path(home).resolve(strict=True)
    if not home.is_dir():
        raise ExportError('home_not_directory')
    output = Path(output).absolute()
    if output.exists():
        raise ExportError('output_exists')
    parent = output.parent.resolve(strict=True)
    resolved = parent / output.name
    if resolved == home or home in resolved.parents or resolved in home.parents:
        raise ExportError('output_overlaps_source')
    return home, resolved


def export(home, thread_ids, output, source_instance, include_unsettled=False,
           settle_window=86400, now=None, keep_backups=False):
    if not thread_ids or len(set(thread_ids)) != len(thread_ids):
        raise ExportError('thread_selection')
    if not source_instance or len(source_instance) > 200 or not source_instance.isprintable():
        raise ExportError('source_instance')
    home, output = _check_paths(home, output)
    now = now or datetime.now(timezone.utc)
    work = Path(tempfile.mkdtemp(prefix='.v1-history-', dir=output.parent))
    backups = work / 'backups'
    backups.mkdir(mode=0o700)
    try:
        databases = {}
        connection = None
        if (home / 'thread-messages.sqlite').is_file():
            target = backups / 'thread-messages.sqlite'
            databases['thread-messages.sqlite'] = backup(home / 'thread-messages.sqlite', target)
            connection = sqlite3.connect(f'file:{quote(str(target))}?mode=ro', uri=True)
        try:
            store = content_store(work / 'uploads')
            threads = [_thread(home, work, connection, t, now, include_unsettled, settle_window, store)
                       for t in thread_ids]
        finally:
            if connection:
                connection.close()
        registry, summaries = _registry(home, backups, databases, thread_ids)
        for thread in threads:
            thread['registry'] = summaries.get(thread['thread_id'])
        identity = [source_instance] + [[t['thread_id'], t['messages_sha256'], t['watermark']] for t in threads]
        manifest = {
            'format': FORMAT, 'version': 1, 'source_instance': source_instance,
            'snapshot_id': 'v1-' + hashlib.sha256(_canonical(identity)).hexdigest()[:32],
            'exported_at': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'consistency': {'method': 'sqlite_online_backup_readonly', 'databases': databases,
                            'registry': registry, 'include_unsettled': include_unsettled,
                            'settle_window_seconds': settle_window},
            'exclusions': EXCLUDED, 'threads': threads,
        }
        if not keep_backups:
            shutil.rmtree(backups)
        manifest['files'] = {str(p.relative_to(work)): _sha_file(p)
                             for p in sorted(work.rglob('*')) if p.is_file()}
        _write(work / 'manifest.json', _canonical(manifest) + b'\n')
        os.rename(work, output)
        return manifest
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise


def load(bundle):
    """Verify every bundled file hash; return (manifest, {thread_id: [messages]})."""
    bundle = Path(bundle)
    with open(bundle / 'manifest.json', 'rb') as stream:
        manifest = json.loads(stream.read())
    if manifest.get('format') != FORMAT or manifest.get('version') != 1:
        raise ExportError('bundle_format')
    for relative, sha in manifest['files'].items():
        path = (bundle / relative).resolve()
        if bundle.resolve() not in path.parents or not path.is_file() or _sha_file(path) != sha:
            raise ExportError('bundle_file_mismatch')
    messages = {}
    for thread in manifest['threads']:
        with open(bundle / thread['directory'] / 'messages.jsonl', 'rb') as stream:
            rows = [json.loads(line) for line in stream.read().splitlines() if line]
        if archive_digest.checksum(rows) != thread['checksum'] or len(rows) != thread['exported']:
            raise ExportError('bundle_checksum')
        messages[thread['thread_id']] = rows
    return manifest, messages
