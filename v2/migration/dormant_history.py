"""Deterministic history-only request/receipt adapter; no store or live intake.

Core owns the proposed atomic port and its enforcement. This module performs no
I/O; it is not a dormant Store implementation or authorization authority.
"""
from copy import deepcopy
from dataclasses import dataclass
import uuid
from conversation_export import collect_pages, _id
from snapshot import canonical, fields, need, sha

MAPPING_VERSION = 'conversation-history-v1'


@dataclass(frozen=True)
class HistoryPlan:
    # Immutable canonical bytes prevent a caller mutating a validated request.
    canonical_request: bytes

    def request(self):
        import json
        return json.loads(self.canonical_request)


def prepare_history(pages, *, target_owner, target_namespace, source_namespace):
    """Validate a complete export before producing any proposed apply input.

    Namespace/owner UUIDs are explicit caller inputs, never imported source auth.
    Source scope is provenance only, never a target grant/project authorization.
    """
    for value in (target_owner, target_namespace, source_namespace):
        _id(value)
    snapshot, digest = collect_pages(pages)
    namespace = uuid.UUID(target_namespace)
    conversation = str(uuid.uuid5(namespace, source_namespace + ':' + snapshot['conversation_id']))
    messages = [{
        'target_message_id': str(uuid.uuid5(namespace, source_namespace + ':' + m['message_id'])),
        'source_message_id': m['message_id'], 'sequence': m['sequence'],
        'actor_kind': m['actor_kind'], 'text': m['text'], 'source_digest': sha(m),
    } for m in snapshot['messages']]
    identity = {'mapping_version': MAPPING_VERSION, 'target_owner': target_owner,
                'target_namespace': target_namespace, 'source_namespace': source_namespace,
                'source_digest': digest}
    request = {**identity, 'batch_key': sha(identity),
               'source_conversation_id': snapshot['conversation_id'],
               'target_conversation_id': conversation,
               'source_scope': snapshot['scope'], 'source_watermark': snapshot['last_sequence'],
               'disposition': 'HISTORY_ONLY', 'messages': messages}
    return HistoryPlan(canonical(request))


def _receipt(receipt, request, *, state):
    fields(receipt, ('batch_key', 'target_owner', 'target_namespace', 'source_digest',
                     'target_conversation_id', 'message_count', 'revision', 'state'))
    for key in ('batch_key', 'target_owner', 'target_namespace', 'source_digest',
                'target_conversation_id'):
        need(receipt[key] == request[key], 'history_receipt_identity')
    need(type(receipt['message_count']) is int and
         receipt['message_count'] == len(request['messages']), 'history_receipt_count')
    need(type(receipt['revision']) is int and receipt['revision'] > 0, 'history_receipt_revision')
    need(receipt['state'] == state, 'history_receipt_incomplete_or_unsupported')
    return deepcopy(receipt)


def _validated_request(plan):
    need(type(plan) is HistoryPlan, 'history_plan_required')
    # Recompute the plan to refuse manually constructed or damaged plan bytes.
    request = plan.request()
    fields(request, ('mapping_version', 'target_owner', 'target_namespace',
                     'source_namespace', 'source_digest', 'batch_key',
                     'source_conversation_id', 'target_conversation_id', 'source_scope',
                     'source_watermark', 'disposition', 'messages'))
    page = {'conversation_id': request['source_conversation_id'],
            'scope': request['source_scope'], 'last_sequence': request['source_watermark'],
            'next_cursor': None, 'messages': []}
    for message in request['messages']:
        fields(message, ('target_message_id', 'source_message_id', 'sequence',
                         'actor_kind', 'text', 'source_digest'))
        page['messages'].append({'message_id': message['source_message_id'],
                                 **{k: message[k] for k in ('sequence', 'actor_kind', 'text')}})
    # Split into the actual published maximum page size, preserving watermark.
    pages = []
    for start in range(0, len(page['messages']), 100):
        part = {**page, 'messages': page['messages'][start:start + 100]}
        part['next_cursor'] = part['messages'][-1]['sequence'] if start + 100 < len(page['messages']) else None
        pages.append(part)
    expected = prepare_history(pages or [page], target_owner=request['target_owner'],
                               target_namespace=request['target_namespace'],
                               source_namespace=request['source_namespace'])
    need(plan == expected, 'history_plan_tampered')
    return request


def apply_history(plan, port, *, token):
    """Proposed Core port invocation, never IntakeStore.admit.

    Core must authenticate token/target owner, require a fresh namespace, atomically
    validate the full request, persist history/provenance and refuse conflicts.
    Invalid/partial receipts fail closed; reconciliation is then required, never
    blind retry with a different namespace. No production adapter is registered.
    """
    request = _validated_request(plan)
    receipt = port.import_dormant_history(token=token, request=deepcopy(request))
    return _receipt(receipt, request, state='DORMANT')


def rollback_history(plan, receipt, port, *, token):
    """Require Core's conditional revision-checked deactivation, never deletion."""
    request = _validated_request(plan)
    validated = _receipt(receipt, request, state='DORMANT')
    result = port.deactivate_dormant_history(token=token, target_owner=request['target_owner'],
        target_namespace=request['target_namespace'], batch_key=request['batch_key'],
        expected_revision=validated['revision'])
    result = _receipt(result, request, state='INACTIVE')
    need(result['revision'] >= validated['revision'], 'history_rollback_revision')
    return result
