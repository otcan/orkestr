"""Canonical inert-ledger + native-delta transfer envelope. No I/O or apply API.

Recovery bodies must come from a separately authorized Store recovery export.
Two supplied components alone do not prove a shared cut or cross-store coherence.
"""
from copy import deepcopy
import json
from conversation_export import collect_pages
from core_history import verify_import_receipt
from history_digest import source_digest
from snapshot import canonical, fields, need, sha

MAX_BUNDLE_BYTES = 40 * 1024 * 1024


def _request(value):
    fields(value, ('namespace', 'source_digest', 'source_conversation_id',
                   'source_scope', 'source_watermark', 'messages'))
    from core_history import prepare_import
    # Reuse exact producer shape validation with bounded published-sized pages.
    page = {'conversation_id': value['source_conversation_id'], 'scope': value['source_scope'],
            'last_sequence': value['source_watermark'], 'next_cursor': None, 'messages': []}
    need(type(value['messages']) is list, 'recovery_messages')
    pages = []
    for start in range(0, len(value['messages']), 100):
        part = {**page, 'messages': value['messages'][start:start+100]}
        if start+100 < len(value['messages']):
            part['next_cursor'] = part['messages'][-1]['sequence']
        pages.append(part)
    expected = prepare_import(pages or [page], namespace=value['namespace'])
    need(expected == value, 'recovery_request_mismatch')
    return deepcopy(value)


def make_bundle(ledger_request, current_receipt, native_pages):
    """Package exact sources; no credential, native admission or execution state.

    Ordinary inactive history reads cannot supply retained text. Do not bypass
    that contract: the authorized recovery-export edge must provide this input.
    """
    ledger = _request(ledger_request)
    receipt = deepcopy(current_receipt)
    fields(receipt, ('schema_version', 'owner_id', 'namespace', 'source_digest',
                     'source_conversation_id', 'source_watermark', 'message_count', 'revision', 'active'))
    need((type(receipt['revision']) is int and receipt['revision'] == 1 and receipt['active'] is True)
         or (type(receipt['revision']) is int and receipt['revision'] == 2 and receipt['active'] is False),
         'recovery_source_state')
    verify_import_receipt({**receipt, 'revision': 1, 'active': True}, ledger, target_owner=receipt['owner_id'])
    native, _ = collect_pages(native_pages)
    delta = {
        'namespace': native['conversation_id'], 'source_digest': '',
        'source_conversation_id': native['conversation_id'], 'source_scope': native['scope'],
        'source_watermark': native['last_sequence'], 'messages': native['messages']}
    delta['source_digest'] = source_digest(delta)
    delta = _request(delta)
    need(not ({m['message_id'] for m in ledger['messages']} & {m['message_id'] for m in delta['messages']}),
         'recovery_source_identity_overlap')
    payload = {'format_version': 1, 'kind': 'inert_history_and_native_delta',
               'coherence': 'caller_supplied_not_attested',
               'ledger': {'request': ledger, 'current_receipt': receipt}, 'native_delta': delta}
    envelope = {'payload': payload, 'payload_sha256': sha(payload)}
    encoded = canonical(envelope)
    need(len(encoded) <= MAX_BUNDLE_BYTES, 'recovery_bundle_size')
    return encoded


def _unique(pairs):
    value = {}
    for key, item in pairs:
        need(key not in value, 'recovery_duplicate_key')
        value[key] = item
    return value


def validate_bundle(encoded):
    need(type(encoded) is bytes and len(encoded) <= MAX_BUNDLE_BYTES, 'recovery_bundle_size')
    try:
        envelope = json.loads(encoded, object_pairs_hook=_unique,
                              parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
    except (ValueError, UnicodeError, RecursionError):
        need(False, 'recovery_invalid_json')
    fields(envelope, ('payload', 'payload_sha256'))
    payload = envelope['payload']
    fields(payload, ('format_version', 'kind', 'coherence', 'ledger', 'native_delta'))
    need(type(payload['format_version']) is int and payload['format_version'] == 1 and
         payload['kind'] == 'inert_history_and_native_delta' and
         payload['coherence'] == 'caller_supplied_not_attested', 'recovery_version_or_coherence')
    need(sha(payload) == envelope['payload_sha256'], 'recovery_bundle_digest')
    fields(payload['ledger'], ('request', 'current_receipt'))
    delta = _request(payload['native_delta'])
    pages = []
    for start in range(0, len(delta['messages']), 100):
        rows = delta['messages'][start:start+100]
        pages.append({'conversation_id': delta['source_conversation_id'], 'scope': delta['source_scope'],
                      'last_sequence': delta['source_watermark'], 'messages': rows,
                      'next_cursor': rows[-1]['sequence'] if start+100 < len(delta['messages']) else None})
    page = {'conversation_id': delta['source_conversation_id'], 'scope': delta['source_scope'],
            'last_sequence': delta['source_watermark'], 'messages': [], 'next_cursor': None}
    expected = make_bundle(payload['ledger']['request'], payload['ledger']['current_receipt'], pages or [page])
    need(expected == encoded, 'recovery_noncanonical_or_changed')
    return deepcopy(payload)
