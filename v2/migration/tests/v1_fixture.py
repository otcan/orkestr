"""Synthetic V1 data home (schema copied from packages/storage on main). Never a live home."""
import json
import os
from pathlib import Path
import sqlite3

SCHEMA = """
create table if not exists orkestr_thread_messages (
  thread_id text not null, id text not null, position integer not null, cursor integer not null,
  role text, state text, source text, phase text, connector text, chat_id text,
  parent_message_id text, event_id text, codex_thread_id text, codex_turn_id text, codex_item_id text,
  client_message_id text, external_id text, created_at text, updated_at text, data text not null,
  primary key(thread_id, id), unique(thread_id, position));
create table if not exists orkestr_thread_message_meta (
  thread_id text primary key, source_signature text not null default '',
  revision integer not null default 0, migrated_at text, updated_at text not null);
create table if not exists orkestr_thread_bridge_changes (
  id integer primary key autoincrement, thread_id text not null, data text);
"""
REGISTRY = """
create table if not exists orkestr_threads (
  id text primary key, name text, binding_name text, public_ref text, public_ref_assigned_at text,
  created_at text, updated_at text, data text not null);
create table if not exists orkestr_meta (key text primary key, value text not null);
"""
SECRET_MARKER = 'synthetic-private-chat-0000'
OTHER_TEXT = 'synthetic text of a non-selected thread'


class V1Home:
    """Holds an open writer so recent rows live only in the WAL during export."""

    def __init__(self, root):
        self.root = Path(root)
        for name in ('uploads', 'secrets', 'thread-messages'):
            (self.root / name).mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.root / 'thread-messages.sqlite', isolation_level=None)
        self.db.execute('pragma journal_mode=WAL')
        self.db.execute('pragma wal_autocheckpoint=0')
        self.db.executescript(SCHEMA)
        self.registry = sqlite3.connect(self.root / 'threads.sqlite', isolation_level=None)
        self.registry.execute('pragma journal_mode=WAL')
        self.registry.executescript(REGISTRY)
        self.positions = {}

    def thread(self, thread_id, name='Synthetic thread', migrated=True, **extra):
        record = {'id': thread_id, 'name': name, 'createdAt': '2026-01-01T00:00:00.000Z',
                  'executor': {'codexThreadId': 'synthetic-native'}, 'chatId': SECRET_MARKER,
                  'binding': {'route': SECRET_MARKER}, **extra}
        self.registry.execute('insert into orkestr_threads(id,name,created_at,updated_at,data) values(?,?,?,?,?)',
                              (thread_id, name, record['createdAt'], record['createdAt'], json.dumps(record)))
        if migrated:
            self.db.execute("insert into orkestr_thread_message_meta(thread_id,revision,updated_at) values(?,1,'x')",
                            (thread_id,))
        self.positions[thread_id] = 0

    def message(self, thread_id, role, text, state='completed', phase='', created=None, attachments=None,
                message_id=None):
        self.positions[thread_id] += 1
        position = self.positions[thread_id]
        message_id = message_id or f'{thread_id}-m{position}'
        created = created or f'2026-01-01T00:{position // 60:02d}:{position % 60:02d}.000Z'
        data = {'id': message_id, 'role': role, 'text': text, 'state': state, 'phase': phase,
                'createdAt': created, 'chatId': SECRET_MARKER, 'codexThreadId': 'synthetic-native'}
        if attachments is not None:
            data['attachments'] = attachments
        self.db.execute(
            'insert into orkestr_thread_messages(thread_id,id,position,cursor,role,state,source,phase,chat_id,'
            'created_at,updated_at,data) values(?,?,?,?,?,?,?,?,?,?,?,?)',
            (thread_id, message_id, position, position * 3, role, state, 'web', phase, SECRET_MARKER,
             created, created, json.dumps(data)))
        return message_id

    def upload(self, thread_id, name, data):
        directory = self.root / 'uploads' / thread_id
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / name
        path.write_bytes(data)
        return str(path)

    def legacy_json(self, thread_id, messages):
        (self.root / 'thread-messages' / f'{thread_id}.json').write_text(json.dumps(messages))

    def close(self):
        self.db.close()
        self.registry.close()


def source_fingerprint(root):
    """Byte content of every source file (including WAL/SHM) for unchanged-source assertions."""
    result = {}
    for path in sorted(Path(root).rglob('*')):
        if path.is_file() and not path.name.endswith('-shm'):
            result[str(path.relative_to(root))] = path.read_bytes()
    return result


def private(path):
    return os.stat(path).st_mode & 0o077 == 0
