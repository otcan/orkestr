"""Deterministic inert plan and quarantine decisions; no application-store writes."""
import uuid
from collections import Counter
from snapshot import KINDS, canonical, identity, need, sha

# Fixed public namespace belongs to this proposed interchange, not Core entity IDs.
NAMESPACE = uuid.UUID('cf9369d6-bd8d-5dc2-b11a-3db68609cf82')
PAUSED = {'run', 'timer', 'route', 'approval', 'automation', 'job'}
STATES = {
    'task': {'queued', 'running', 'blocked', 'needs_approval', 'succeeded', 'failed', 'cancelled'},
    'run': {'pending', 'running', 'retrying', 'awaiting_approval', 'succeeded', 'failed', 'cancelled', 'skipped'},
}


def map_key(instance, record):
    return canonical([instance, record['kind'], record['key']]).decode()


def empty_ledger():
    return {'version': 1, 'dispatch_allowed': False, 'entries': {}, 'conflicts': {}}


def validate_ledger(ledger):
    need(set(ledger) == {'version', 'dispatch_allowed', 'entries', 'conflicts'}, 'ledger_fields')
    need(ledger['version'] == 1 and ledger['dispatch_allowed'] is False, 'ledger_authority')
    need(isinstance(ledger['entries'], dict) and isinstance(ledger['conflicts'], dict), 'ledger_shape')
    for key, entry in ledger['entries'].items():
        need(set(entry) == {'target_id', 'digest', 'disposition', 'reasons', 'source_state',
                            'kind', 'origin', 'snapshot_digest'}, 'entry_fields')
        need(entry['target_id'] == str(uuid.uuid5(NAMESPACE, key)), 'mapping_changed')
        need(entry['disposition'] in {'QUARANTINED', 'PAUSED', 'HISTORY_ONLY'}, 'entry_authority')
        need(isinstance(entry['reasons'], list) and all(isinstance(v, str) for v in entry['reasons']), 'entry_shape')
        for field in ('digest', 'snapshot_digest'):
            need(isinstance(entry[field], str) and len(entry[field]) == 64
                 and all(c in '0123456789abcdef' for c in entry[field]), 'entry_digest')
        need(entry['origin'] in {'legacy', 'v2_delta'}, 'entry_origin')
        if entry['kind'] in PAUSED:
            need(entry['disposition'] in {'PAUSED', 'QUARANTINED'}, 'entry_not_paused')
        if entry['kind'] == 'effect':
            need(entry['disposition'] == 'QUARANTINED', 'effect_not_quarantined')
    return ledger


def classify(document, conflicted=()):
    records = {identity(r): r for r in document['records']}
    reasons = {key: ({'identity_content_conflict'} if key in conflicted else set())
               for key in records}
    edges = {key: [] for key in records}
    positions = {}
    artifact_paths = {a['path'] for a in document['artifacts']}
    for key, record in records.items():
        if record['kind'] not in KINDS:
            reasons[key].add('unsupported_kind')
        if not record['owner'] or not record['scope']:
            reasons[key].add('unresolved_owner_or_scope')
        if record['kind'] in STATES and record['source_state'] not in STATES[record['kind']]:
            reasons[key].add('unknown_source_state')
        if record['kind'] == 'artifact' and record['payload'].get('path') not in artifact_paths:
            reasons[key].add('missing_artifact_reference')
        if record['kind'] == 'effect':
            reasons[key].add('effect_history_requires_reconciliation')
        for ref in record['references']:
            target = identity(ref)
            if target not in records:
                reasons[key].add('missing_reference')
                continue
            other = records[target]
            if (other['owner'], other['scope']) != (record['owner'], record['scope']):
                reasons[key].add('cross_owner_or_scope')
            # Only causal/containment edges participate in cycle detection.
            if ref['relation'] in {'parent', 'depends_on'}:
                edges[key].append(target)
            elif ref['relation'] not in {'thread', 'project', 'run', 'result', 'resource', 'root'}:
                reasons[key].add('unsupported_relation')
        if record['kind'] == 'message':
            slot = (record['key'][0], record['payload']['position'])
            if slot in positions:
                reasons[key].add('duplicate_position')
                reasons[positions[slot]].add('duplicate_position')
            positions[slot] = key
            thread_ref = {'kind': 'thread', 'key': [record['key'][0]]}
            thread = records.get(identity(thread_ref))
            if thread is None:
                reasons[key].add('missing_thread')
            elif (thread['owner'], thread['scope']) != (record['owner'], record['scope']):
                reasons[key].add('cross_owner_or_scope')
            for ref in record['references']:
                if ref['relation'] == 'parent' and identity(ref) in records:
                    parent = records[identity(ref)]
                    if (parent['kind'] != 'message' or parent['key'][0] != record['key'][0]
                            or parent['payload'].get('position', -1) >= record['payload']['position']):
                        reasons[key].add('invalid_message_parent_order')
    # Iterative depth-first cycle detection, without repeated expansion of DAG paths.
    done = set()
    for start in records:
        if start in done:
            continue
        path, active = [], set()
        stack = [(start, False)]
        while stack:
            node, leaving = stack.pop()
            if leaving:
                active.remove(node)
                path.pop()
                done.add(node)
                continue
            if node in active:
                for item in path[path.index(node):]:
                    reasons[item].add('cyclic_lineage')
                continue
            if node in done:
                continue
            active.add(node)
            path.append(node)
            stack.append((node, True))
            stack.extend((parent, False) for parent in reversed(edges[node]))
    # Quarantine dependent records too; never present partial lineage as sound.
    changed = True
    while changed:
        changed = False
        for key, record in records.items():
            for ref in record['references']:
                if reasons.get(identity(ref)) and 'quarantined_reference' not in reasons[key]:
                    reasons[key].add('quarantined_reference')
                    changed = True
    return {key: sorted(value) for key, value in reasons.items()}


def reconcile(document, previous=None):
    """Return a new plan ledger. Same identity/body repeats; changed bodies quarantine.

    Ledger stores digests/decisions only. Raw source remains in its immutable bundle.
    Nothing here is authority to create Core entities or resume execution.
    """
    import copy
    ledger = copy.deepcopy(validate_ledger(previous) if previous is not None else empty_ledger())
    conflicted = {identity(record) for record in document['records']
                  if map_key(document['source_instance'], record) in ledger['entries']
                  and ledger['entries'][map_key(document['source_instance'], record)]['digest'] != sha(record)}
    reasons = classify(document, conflicted)
    outcomes = Counter()
    for record in sorted(document['records'], key=identity):
        key = map_key(document['source_instance'], record)
        fingerprint = sha(record)
        old = ledger['entries'].get(key)
        if old and old['digest'] != fingerprint:
            conflict_key = sha([key, old['digest'], fingerprint])
            ledger['conflicts'][conflict_key] = {
                'mapping_key': key, 'original_digest': old['digest'],
                'incoming_digest': fingerprint, 'disposition': 'QUARANTINED',
                'reason': 'identity_content_conflict',
            }
            old['disposition'] = 'QUARANTINED'
            old['reasons'] = sorted(set(old['reasons']) | {'identity_content_conflict'})
            outcomes['conflicts'] += 1
            continue
        if old:
            failures = reasons[identity(record)]
            if failures:
                old['disposition'] = 'QUARANTINED'
                old['reasons'] = sorted(set(old['reasons']) | set(failures))
            outcomes['duplicates'] += 1
            continue
        failures = reasons[identity(record)]
        disposition = ('QUARANTINED' if failures else
                       'PAUSED' if record['kind'] in PAUSED else 'HISTORY_ONLY')
        ledger['entries'][key] = {
            'target_id': str(uuid.uuid5(NAMESPACE, key)), 'digest': fingerprint,
            'disposition': disposition, 'reasons': failures,
            'source_state': record['source_state'], 'kind': record['kind'],
            'origin': document['origin'], 'snapshot_digest': document['digest'],
        }
        outcomes[disposition] += 1
    return ledger, dict(sorted(outcomes.items()))
