"""Rollback direction: archive V2-era conversation messages and append them to a V1 thread.

The appended V1 rows are inert history (`state=archived`, dedicated source).
They are never queued, never written to the bridge journal or outbox, and so
are neither replayed to a provider nor delivered to a connector. Imported
archived history is not part of the native conversation and is not exported.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from urllib.parse import quote

FORMAT = 'orkestr-v2-conversation-archive'
SOURCE = 'orkestr-v2-archive'
REMOVED = '(V2 reply text unavailable: payload removed or missing)'


class RollbackError(ValueError):
    pass


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def _digest(entries):
    return hashlib.sha256(_canonical(entries)).hexdigest()


def export_conversation(client, conversation, after_sequence=0, now=None):
    base = f'/api/v2/conversations/{conversation}'
    entries, cursor = [], after_sequence
    while True:
        page = client.get(base, {'after': cursor, 'limit': 100})
        for message in page['messages']:
            entries.append({'v2_sequence': message['sequence'], 'kind': 'input', 'role': 'user',
                            'v2_id': message['message_id'], 'actor_kind': message['actor_kind'],
                            'text': message['text'], 'text_available': True})
        if page.get('next_cursor') is None:
            break
        cursor = page['next_cursor']
    cursor = after_sequence
    while True:
        page = client.get(base + '/accepted-results', {'after_sequence': cursor, 'limit': 50})
        for result in page['results']:
            text = None
            if result.get('payload_id') and not result.get('payload_removed'):
                text = client.get(f"{base}/payloads/{result['payload_id']}").get('text')
            entries.append({'v2_sequence': result['acceptance_sequence'], 'kind': 'reply',
                            'role': 'assistant', 'v2_id': result['run_id'], 'actor_kind': 'assistant',
                            'text': text if text is not None else '', 'text_available': text is not None})
        if page.get('next_after_sequence') is None:
            break
        cursor = page['next_after_sequence']
    entries.sort(key=lambda e: e['v2_sequence'])
    if len({e['v2_sequence'] for e in entries}) != len(entries):
        raise RollbackError('duplicate_v2_sequence')
    return {
        'format': FORMAT, 'version': 1, 'conversation_id': conversation,
        'exported_at': (now or datetime.now(timezone.utc)).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'after_sequence': after_sequence,
        'watermark': entries[-1]['v2_sequence'] if entries else after_sequence,
        'entries': entries, 'digest': _digest(entries),
    }


def write_archive(archive, path):
    path = Path(path)
    if path.exists():
        raise RollbackError('archive_exists')
    with open(path, 'xb') as stream:
        os.chmod(path, 0o600)
        stream.write(_canonical(archive) + b'\n')
        stream.flush()
        os.fsync(stream.fileno())


def read_archive(path):
    with open(path, 'rb') as stream:
        archive = json.loads(stream.read())
    if archive.get('format') != FORMAT or archive.get('version') != 1:
        raise RollbackError('archive_format')
    if _digest(archive['entries']) != archive['digest']:
        raise RollbackError('archive_digest')
    return archive


def v1_row_id(conversation, entry):
    return f"v2-{conversation}-{entry['v2_sequence']}"


def append_to_v1(archive, v1_db, thread_id, apply=False, now=None):
    """Append archive entries to an existing, already-migrated V1 sqlite thread."""
    v1_db = Path(v1_db)
    if not v1_db.is_file():
        raise RollbackError('v1_sqlite_store_required')
    stamp = (now or datetime.now(timezone.utc)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    uri = f'file:{quote(str(v1_db.resolve()))}?mode={"rw" if apply else "ro"}'
    connection = sqlite3.connect(uri, uri=True, timeout=10, isolation_level=None)
    try:
        connection.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        meta = connection.execute('SELECT revision FROM orkestr_thread_message_meta WHERE thread_id=?',
                                  (thread_id,)).fetchone()
        if meta is None:
            # V1 rebuilds unmigrated threads from JSON and would drop appended rows.
            raise RollbackError('v1_thread_not_migrated')
        position, cursor = connection.execute(
            'SELECT coalesce(max(position),0),coalesce(max(cursor),0) FROM orkestr_thread_messages WHERE thread_id=?',
            (thread_id,)).fetchone()
        existing = {row[0] for row in connection.execute(
            'SELECT id FROM orkestr_thread_messages WHERE thread_id=? AND source=?', (thread_id, SOURCE))}
        conversation = archive['conversation_id']
        pending = [e for e in archive['entries'] if v1_row_id(conversation, e) not in existing]
        report = {'mode': 'apply' if apply else 'dry_run', 'conversation_id': conversation,
                  'thread_id': thread_id, 'archive_entries': len(archive['entries']),
                  'already_present': len(archive['entries']) - len(pending), 'appended': 0,
                  'first_position': position + 1 if pending else None,
                  'roles': {r: sum(e['role'] == r for e in pending) for r in ('user', 'assistant')},
                  'text_unavailable': sum(not e['text_available'] for e in pending)}
        if not apply:
            connection.execute('ROLLBACK')
            return report
        for entry in pending:
            position, cursor = position + 1, cursor + 1
            row_id = v1_row_id(conversation, entry)
            data = {'id': row_id, 'role': entry['role'], 'state': 'archived', 'source': SOURCE,
                    'text': entry['text'] if entry['text_available'] else REMOVED,
                    'createdAt': stamp, 'updatedAt': stamp, 'cursor': cursor, 'archived': True,
                    'v2Archive': {'conversationId': conversation, 'sequence': entry['v2_sequence'],
                                  'kind': entry['kind'], 'v2Id': entry['v2_id'],
                                  'archiveDigest': archive['digest']}}
            connection.execute(
                'INSERT INTO orkestr_thread_messages(thread_id,id,position,cursor,role,state,source,phase,'
                'connector,chat_id,parent_message_id,event_id,codex_thread_id,codex_turn_id,codex_item_id,'
                "client_message_id,external_id,created_at,updated_at,data) VALUES(?,?,?,?,?,'archived',?,'',"
                "'','','','','','','','','',?,?,?)",
                (thread_id, row_id, position, cursor, entry['role'], SOURCE, stamp, stamp,
                 json.dumps(data, ensure_ascii=False)))
        connection.execute('UPDATE orkestr_thread_message_meta SET revision=revision+1,updated_at=? WHERE thread_id=?',
                           (stamp, thread_id))
        connection.execute('COMMIT')
        report['appended'] = len(pending)
        return report
    except BaseException:
        if connection.in_transaction:
            connection.execute('ROLLBACK')
        raise
    finally:
        connection.close()
