"""Durable V1 lineage of imported conversations (`PUT /api/v2/conversations/{id}/lineage`).

An imported V1 worker sub-thread keeps its V1 parent so the V2 sidebar can
group it under that parent, whether the parent is still on V1 or imported
too. Lineage is write-once on the server: an identical replay is `unchanged`,
a different one is a `conflict` and is never overwritten. Reports hold only
identifiers, never message text.
"""
import json
import sqlite3
from urllib.parse import quote

import v2_client

ID_MAX = 200
TASK_AGENT = 'task-agent'


def _thread_id(value):
    if not isinstance(value, str) or not 1 <= len(value) <= ID_MAX:
        return None
    return value if all(c.isascii() and (c.isalnum() or c in '._:-') for c in value) else None


def from_registry(source_instance, thread_id, record):
    """Lineage for `thread_id` from its (allowlisted) V1 registry record."""
    record = record if isinstance(record, dict) else {}
    parent = _thread_id(record.get('parentThreadId'))
    kind = record.get('threadKind') or record.get('kind')
    if parent == thread_id or kind == TASK_AGENT:
        parent = None
    return {'source_instance': source_instance, 'source_thread_id': thread_id,
            'source_parent_thread_id': parent}


def record(client, conversation, value):
    try:
        status, _ = client.put(f'/api/v2/conversations/{conversation}/lineage', value)
    except v2_client.ApiError as error:
        if error.status == 409:
            return 'conflict' if error.code == 'lineage_conflict' else 'source_not_imported'
        if error.status == 404 and error.code == 'not_found':
            return 'unsupported'
        raise
    return 'recorded' if status == 201 else 'unchanged'


def read_v1_registry(home, thread_ids):
    """Read-only lookup of V1 registry records (`threads.sqlite`)."""
    path = f'{home}/threads.sqlite'
    connection = sqlite3.connect(f'file:{quote(path)}?mode=ro', uri=True)
    try:
        found = {}
        for thread_id in thread_ids:
            row = connection.execute('SELECT data FROM orkestr_threads WHERE id=?', (thread_id,)).fetchone()
            if row:
                try:
                    found[thread_id] = json.loads(row[0])
                except ValueError:
                    continue
        return found
    finally:
        connection.close()


def _conversations(client):
    after = 0
    while True:
        page = client.get('/api/v2/conversations', {'after': after, 'limit': 100})
        for row in page['conversations']:
            yield row['conversation_id']
        if not page.get('next_cursor'):
            return
        after = page['next_cursor']


def backfill(client, v1_home, source_instance, conversations=None, apply=False):
    """Plan (and with `apply`, record) lineage for imported conversations.

    Each conversation's first archived source from `source_instance` is looked
    up in the V1 registry; a conversation without such a source is skipped.
    """
    plans = []
    for conversation in conversations or list(_conversations(client)):
        status = client.get(f'/api/v2/conversations/{conversation}/archived-history/status')
        source = next((s for s in status.get('sources', [])
                       if s['source_instance'] == source_instance), None)
        if source:
            plans.append((conversation, source['source_thread_id']))
    records = read_v1_registry(v1_home, [thread for _, thread in plans])
    report = {'mode': 'apply' if apply else 'dry_run', 'source_instance': source_instance,
              'conversations': []}
    for conversation, thread in plans:
        value = from_registry(source_instance, thread, records.get(thread))
        item = {'conversation_id': conversation, 'source_thread_id': thread,
                'parent_thread_id': value['source_parent_thread_id'],
                'v1_record': thread in records, 'state': 'planned'}
        if apply and thread in records:
            item['state'] = record(client, conversation, value)
        report['conversations'].append(item)
    report['with_parent'] = sum(1 for i in report['conversations'] if i['parent_thread_id'])
    return report
