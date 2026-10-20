"""Plan and apply one bundled V1 thread into a V2 conversation as archived history.

Dry-run is the default and never writes. Apply sends only messages after the
target's per-source cursor (delta), in bounded ordered batches; the server is
idempotent and quarantines conflicting content. The report holds only counts,
identifiers and checksums, never message text.
"""
import hashlib
import json

import archive_digest
from v1_export import ExportError

BATCH_MESSAGES = 500
BATCH_BYTES = 4 * 1024 * 1024
TRANSPORT_MAX = 7 * 1024 * 1024


def request_key(source_instance, thread_id):
    digest = hashlib.sha256(f'{source_instance}\0{thread_id}'.encode('utf-8')).hexdigest()
    return f'v1-import-{digest[:40]}'


def _size(message):
    return len(json.dumps(message, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))


def batches(messages, max_messages=None, max_bytes=None):
    max_messages = max_messages or BATCH_MESSAGES
    max_bytes = max_bytes or BATCH_BYTES
    current, size = [], 0
    for message in messages:
        length = _size(message)
        if current and (len(current) >= max_messages or size + length > max_bytes):
            yield current
            current, size = [], 0
        current.append(message)
        size += length
    if current:
        yield current


def _source(status, source_instance, thread_id):
    for source in (status or {}).get('sources', []):
        if source['source_instance'] == source_instance and source['source_thread_id'] == thread_id:
            return source
    return None


def _path(conversation):
    return f'/api/v2/conversations/{conversation}/archived-history'


def import_thread(client, manifest, messages_by_thread, thread_id, conversation=None,
                  create_name=None, apply=False):
    if (conversation is None) == (create_name is None):
        raise ExportError('choose_conversation_or_create_name')
    thread = next((t for t in manifest['threads'] if t['thread_id'] == thread_id), None)
    if thread is None:
        raise ExportError('thread_not_in_bundle')
    instance, snapshot = manifest['source_instance'], manifest['snapshot_id']
    messages = messages_by_thread[thread_id]
    oversized = [m['source_message_id'] for m in messages if _size(m) > TRANSPORT_MAX]
    sendable = [m for m in messages if _size(m) <= TRANSPORT_MAX]
    report = {
        'mode': 'apply' if apply else 'dry_run', 'snapshot_id': snapshot,
        'source_instance': instance, 'thread_id': thread_id,
        'bundle': {'source_messages': thread['source_messages'], 'exported': thread['exported'],
                   'watermark': thread['watermark'], 'unsettled_tail': thread['unsettled_tail'],
                   'quarantined_local': thread['quarantined'], 'oversized_local': len(oversized),
                   'attachments': thread['attachments'], 'roles': thread['roles']},
        'expected_checksum': archive_digest.checksum(sendable),
    }
    created = False
    if conversation is None:
        if apply:
            summary = client.post('/api/v2/conversations', {
                'client_request_id': request_key(instance, thread_id), 'name': create_name})
            conversation, created = summary['conversation_id'], True
    report['conversation_id'] = conversation
    report['conversation_created_or_replayed'] = created
    before = _source(client.get(_path(conversation) + '/status'), instance, thread_id) if conversation else None
    cursor = before['cursor'] if before else 0
    delta = [m for m in sendable if m['source_position'] > cursor]
    planned = list(batches(delta))
    report['target_before'] = {k: before[k] for k in ('cursor', 'message_count', 'quarantined')} if before else None
    report['delta'] = {'messages': len(delta), 'batches': len(planned)}
    if not apply:
        return report
    inserted = duplicates = 0
    quarantined = {}
    quarantined_ids = []
    for batch in planned:
        receipt = client.post(_path(conversation), {
            'source_instance': instance, 'source_thread_id': thread_id,
            'snapshot_id': snapshot, 'messages': batch})
        inserted += receipt['inserted']
        duplicates += receipt['duplicates']
        for item in receipt['quarantined']:
            quarantined[item['reason']] = quarantined.get(item['reason'], 0) + 1
            quarantined_ids.append(item['source_message_id'])
    after = _source(client.get(_path(conversation) + '/status'), instance, thread_id)
    report['result'] = {'inserted': inserted, 'duplicates': duplicates,
                        'quarantined': quarantined, 'quarantined_ids': quarantined_ids}
    report['target_after'] = {k: after[k] for k in ('cursor', 'message_count', 'quarantined', 'checksum')} if after else None
    report['verified'] = verify(after, sendable)
    return report


def verify(after, messages):
    """Exact equality with the bundle, or a prefix match when the target is newer."""
    if not after:
        return 'nothing_imported' if not messages else 'missing_target_source'
    count = after['message_count']
    if count == len(messages) and after['checksum'] == archive_digest.checksum(messages):
        return 'exact_match'
    if count > len(messages):
        return 'target_ahead_of_bundle'
    if after['checksum'] == archive_digest.checksum(messages[:count]):
        return 'prefix_match'
    return 'checksum_mismatch'
