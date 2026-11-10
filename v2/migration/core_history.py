"""Published Core history request producer. No I/O, credentials or apply authority."""
from copy import deepcopy
import uuid
from conversation_export import collect_pages
from history_digest import source_digest
from snapshot import fields, need


def prepare_import(pages, *, namespace):
    """Consume a complete stable-cut page sequence; preserve source IDs/order.

    Caller supplies one explicit target namespace and fresh target auth separately.
    This cannot establish the caller's page provenance or cross-store consistency.
    """
    need(type(namespace) is str, 'invalid_history_namespace')
    try:
        parsed = uuid.UUID(namespace)
        need(parsed.int != 0 and str(parsed) == namespace, 'invalid_history_namespace')
    except ValueError:
        need(False, 'invalid_history_namespace')
    snapshot, _ = collect_pages(pages)
    request = {'namespace': namespace, 'source_digest': '',
               'source_conversation_id': snapshot['conversation_id'],
               'source_scope': snapshot['scope'], 'source_watermark': snapshot['last_sequence'],
               'messages': snapshot['messages']}
    request['source_digest'] = source_digest(request)
    return request


def verify_import_receipt(receipt, request, *, target_owner):
    """Import replay always returns the original active revision1 receipt."""
    fields(receipt, ('schema_version', 'owner_id', 'namespace', 'source_digest',
                     'source_conversation_id', 'source_watermark', 'message_count',
                     'revision', 'active'))
    need(source_digest(request) == request['source_digest'], 'history_digest_mismatch')
    need(receipt['owner_id'] == target_owner, 'history_receipt_owner')
    need(type(receipt['source_watermark']) is int, 'history_receipt_watermark')
    for key in ('namespace', 'source_digest', 'source_conversation_id', 'source_watermark'):
        need(receipt[key] == request[key], 'history_receipt_source')
    need(type(receipt['message_count']) is int and receipt['message_count'] == len(request['messages']), 'history_receipt_count')
    need(type(receipt['schema_version']) is int and receipt['schema_version'] == 1 and
         type(receipt['revision']) is int and receipt['revision'] == 1 and
         receipt['active'] is True, 'history_receipt_state')
    return deepcopy(receipt)
