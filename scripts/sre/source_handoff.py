"""Durable approval-to-source handoff; no owner impersonation or executor transfer.

Transport is injected. An accepted receipt proves admission, not work completion.
The caller must authenticate intake and protect this store from executors.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile


class HandoffRefused(ValueError):
    pass


def atomic(path, value):
    fd, name = tempfile.mkstemp(prefix='.handoff-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def deliver(root, decision, submit, dry=False):
    """Persist a scoped decision then submit once to its original conversation.

    A crash after claiming or an exception after submit is ambiguous. Subsequent
    calls return that durable state without resubmission. Reconciliation must be
    performed against an authenticated receipt by the operator, not by replay.
    """
    required = ('request_id', 'decision_id', 'conversation_id', 'source_run_id',
                'native_session_id', 'action', 'resource', 'verdict')
    if any(not isinstance(decision.get(k), str) or not decision[k].strip() for k in required):
        raise HandoffRefused('missing_source_or_scope')
    if decision['verdict'] not in ('approve', 'deny', 'revoke', 'rescope', 'escalate'):
        raise HandoffRefused('invalid_verdict')
    if type(decision.get('provider_generation')) is not int or decision['provider_generation'] < 0:
        raise HandoffRefused('missing_provider_fence')
    if decision['verdict'] == 'rescope' and not decision.get('scope'):
        raise HandoffRefused('missing_scope')
    # Explicit projection: callers cannot accidentally serialize credentials.
    frozen = {k: decision[k] for k in (*required, 'provider_generation')}
    if decision.get('scope'):
        frozen['scope'] = decision['scope']
    digest = hashlib.sha256(json.dumps(frozen, sort_keys=True).encode()).hexdigest()
    key = hashlib.sha256((frozen['request_id'] + '\n' + frozen['decision_id']).encode()).hexdigest()
    approved = frozen['verdict'] in ('approve', 'rescope')
    body = {'client_message_id': 'approval-handoff-' + key,
            'author': 'v1_agent',
            'expected_provider_generation': frozen['provider_generation'],
            'continuation_source_run_id': frozen['source_run_id'],
            'text': 'Approval decision for the originating executor; execution stays in this conversation.\n' +
                    json.dumps(frozen, sort_keys=True) + '\n' +
                    ('Continue only the recorded approved scope. Report execution separately.' if approved else
                     'Do not start the requested work. Apply this decision to the originating task; escalate any rollback requiring separate authority.')}
    state = {'schema_version': 1, 'digest': digest, 'decision': frozen,
             'grant': {'kind': 'scoped_decision_record', 'approved': approved,
                       'executor_native_session_id': frozen['native_session_id'],
                       'conversation_id': frozen['conversation_id'],
                       'scope': frozen.get('scope') or {'action': frozen['action'], 'resource': frozen['resource']},
                       'runtime_privileges_changed': False},
             'body': body, 'status': 'dry-run' if dry else 'claimed',
             'execution_owner': 'source', 'work_completed': False}
    if dry:
        return state
    root = Path(root)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = root / (key + '.json')
    fd = os.open(root / (key + '.lock'), os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if path.exists():
            prior = json.loads(path.read_text())
            if prior.get('digest') != digest:
                raise HandoffRefused('decision_identity_changed')
            return prior
        atomic(path, state)  # claim and scoped decision survive a process crash
        try:
            receipt = submit(frozen['conversation_id'], body)
            if not isinstance(receipt, dict) or not receipt.get('message_id') or not receipt.get('event_id'):
                raise HandoffRefused('invalid_admission_receipt')
            state['receipt'] = {k: receipt[k] for k in ('message_id', 'event_id')}
            state['status'] = 'accepted'
        except Exception:
            state['status'] = 'unknown'  # Never replay on transport error or malformed receipt.
        atomic(path, state)
        return state
