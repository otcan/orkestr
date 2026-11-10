"""Validated transfer envelope -> exact Store recovery request JSON. No I/O/apply."""
import hashlib
import uuid
from history_digest import source_bytes
from recovery_bundle import validate_bundle
from snapshot import canonical, need


def _uuid(value):
    need(type(value) is str, 'recovery_target_uuid')
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        need(False, 'recovery_target_uuid')
    need(parsed.int != 0 and str(parsed) == value, 'recovery_target_uuid')
    return parsed


def prepare_restore(encoded, *, restore_id, original_namespace, delta_namespace):
    """Fresh target identity is explicit; source credentials are never accepted."""
    ids = [_uuid(value) for value in (restore_id, original_namespace, delta_namespace)]
    need(ids[1] != ids[2], 'recovery_target_overlap')
    payload = validate_bundle(encoded)
    original = payload['ledger']['request']
    receipt = payload['ledger']['current_receipt']
    delta = payload['native_delta']
    digest = hashlib.sha256(b'orkestr-history-recovery-v1\0')
    digest.update(_uuid(receipt['owner_id']).bytes)
    for request in (original, delta):
        body = source_bytes(request)
        digest.update(_uuid(request['namespace']).bytes)
        digest.update(len(body).to_bytes(8, 'big'))
        digest.update(body)
    digest.update(receipt['revision'].to_bytes(8, 'big', signed=True))
    digest.update(bytes([receipt['active']]))
    return canonical({'restore_id': restore_id, 'original_namespace': original_namespace,
                      'delta_namespace': delta_namespace,
                      'bundle': {'schema_version': 1, 'original': original,
                                 'current_receipt': receipt, 'native_delta': delta,
                                 'bundle_digest': digest.hexdigest()}})
