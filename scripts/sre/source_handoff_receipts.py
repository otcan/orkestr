"""Typed, query-only handoff reconciliation and attributed source reports.

`lookup(conversation, query)` MUST call the authenticated Core receipt port.
There is deliberately no submit/replay callback and no business-completion
writer. Core lineage attests admission/model output, not external effects.
"""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import uuid


class ReceiptRefused(ValueError):
    pass


def require(value, reason):
    if not value:
        raise ReceiptRefused(reason)


def canonical_uuid(value):
    try:
        parsed = uuid.UUID(value)
        require(parsed.int != 0 and str(parsed) == value, 'noncanonical_identity')
    except (ValueError, TypeError, AttributeError):
        raise ReceiptRefused('noncanonical_identity') from None
    return value


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 2**63 - 1


def write(path, value):
    fd, name = tempfile.mkstemp(prefix='.handoff-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, sort_keys=True)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)


@contextmanager
def locked(root, key):
    require(type(key) is str and re.fullmatch('[0-9a-f]{64}', key), 'invalid_handoff_key')
    root = Path(root)
    require(root.is_absolute() and '..' not in root.parts, 'private_state_required')
    for part in (root, *root.parents):
        info = part.lstat()
        sticky = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, os.geteuid())
                and (not info.st_mode & 0o022 or sticky), 'private_state_required')
    require(stat.S_IMODE(root.lstat().st_mode) == 0o700, 'private_state_required')
    path = root / (key + '.json')
    # Reconciliation cannot create a new handoff or claim a new dispatch.
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    os.close(descriptor)
    lockfd = os.open(root / (key + '.lock'), os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(lockfd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid in (0, os.geteuid())
                and stat.S_IMODE(info.st_mode) == 0o600, 'private_lock_required')
        fcntl.flock(lockfd, fcntl.LOCK_EX)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        with os.fdopen(fd, 'r') as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid in (0, os.geteuid())
                    and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 512 * 1024,
                    'private_handoff_required')
            state = json.load(stream)
        yield path, state
    finally:
        os.close(lockfd)


def query_for(state, key):
    require(type(state) is dict and type(state.get('schema_version')) is int and state['schema_version'] == 1, 'handoff_schema')
    decision, body = state['decision'], state['body']
    require(sha(decision['request_id'] + '\n' + decision['decision_id']) == key
            and sha(json.dumps(decision, sort_keys=True)) == state['digest'], 'handoff_identity_changed')
    require('owner_id' in decision and 'source_provider' in decision, 'legacy_context_unproven')
    for name in ('owner_id', 'conversation_id', 'source_run_id'): canonical_uuid(decision[name])
    require(decision['source_provider'] in ('codex', 'claude') and integer(decision['provider_generation']), 'source_fence')
    require(body['client_message_id'] == 'approval-handoff-' + key and body['author'] == 'v1_agent'
            and body['continuation_source_run_id'] == decision['source_run_id']
            and body['expected_provider_generation'] == decision['provider_generation']
            and type(body['text']) is str and sha(body['text']) == state.get('text_sha256'), 'handoff_payload_changed')
    return dict(client_message_id=body['client_message_id'], text_sha256=state['text_sha256'],
                expected_provider_generation=decision['provider_generation'],
                continuation_source_run_id=decision['source_run_id'], source_native_session_id=decision['native_session_id'],
                source_provider=decision['source_provider'], author='v1_agent')


def evidence(state, query, projection):
    decision = state['decision']
    require(type(projection) is dict and set(projection) == {'schema_version', 'owner_id', 'conversation_id',
            'admission_state', 'admission', 'input_state', 'run', 'business_state', 'work_completed'}
            and type(projection.get('schema_version')) is int and projection['schema_version'] == 1
            and projection.get('owner_id') == decision['owner_id']
            and projection.get('conversation_id') == decision['conversation_id']
            and projection.get('business_state') == 'unverified'
            and projection.get('work_completed') is False, 'core_projection_scope')
    require(projection.get('admission_state') in ('missing', 'legacy_unproven', 'admitted'), 'core_projection_state')
    if projection['admission_state'] != 'admitted':
        require(projection.get('admission') is None and projection.get('run') is None, 'core_projection_state')
        return None
    proof = projection.get('admission')
    require(type(proof) is dict and set(proof) == set(query) | {'message_id', 'event_id', 'sequence',
            'source_binding_generation', 'authentication_kind', 'service_credential_id'}
            and all(proof.get(k) == v for k, v in query.items()), 'core_admission_fence')
    canonical_uuid(proof.get('message_id')); canonical_uuid(proof.get('event_id'))
    require(integer(proof.get('sequence'), 1) and integer(proof.get('source_binding_generation'), 1)
            and integer(proof.get('expected_provider_generation'))
            and proof.get('authentication_kind') in ('legacy', 'browser', 'machine', 'service_browser'), 'core_admission_receipt')
    if proof.get('service_credential_id') is not None: canonical_uuid(proof['service_credential_id'])
    if state.get('receipt'):
        require(all(state['receipt'].get(k) == proof[k] for k in ('message_id', 'event_id', 'sequence')), 'core_receipt_changed')
    return proof


def reconcile(root, key, lookup):
    """Query only a claimed/unknown send. Missing evidence never permits replay."""
    with locked(root, key) as (path, state):
        if state.get('status') not in ('unknown', 'claimed'):
            return {**state, 'work_completed': False}
        try:
            query = query_for(state, key)
            projection = lookup(state['decision']['conversation_id'], query)
            proof = evidence(state, query, projection)
        except ReceiptRefused:
            # Preserve old records exactly; no migration/backfill or guessed proof.
            raise
        except Exception:
            return {**state, 'reconciliation_state': 'lookup_unavailable', 'work_completed': False}
        if proof is None:
            return {**state, 'reconciliation_state': projection['admission_state'], 'work_completed': False}
        state.update(status='accepted', receipt={k: proof[k] for k in ('message_id', 'event_id', 'sequence')},
                     admission_proof=proof, reconciliation_state='core_admission_proven', work_completed=False)
        state['receipt']['status'] = 'accepted'
        write(path, state)
        return state


def ingest_report(root, key, lookup, report):
    """Record an immutable agent report plus separate Core lineage evidence.

    Reported success and even accepted model output never verify external work.
    A future domain-specific trusted attestor must supply business receipts;
    this function has no interface that can mark business work completed.
    """
    require(type(report) is dict and set(report) == {'report_id', 'reported_run_id', 'reported_state', 'text'}, 'report_fields')
    require(type(report['report_id']) is str and re.fullmatch('[A-Za-z0-9_.:-]{1,128}', report['report_id']), 'report_identity')
    canonical_uuid(report['reported_run_id'])
    require(report['reported_state'] in ('progress', 'completed', 'failed', 'blocked')
            and type(report['text']) is str and 0 < len(report['text'].encode()) <= 8192, 'report_bounds')
    report_digest = sha(json.dumps(report, sort_keys=True))
    with locked(root, key) as (path, state):
        require(state.get('status') == 'accepted', 'admission_not_reconciled')
        reports = state.get('source_reports', [])
        for prior in reports:
            if prior['report']['report_id'] == report['report_id']:
                require(prior['report_digest'] == report_digest, 'report_identity_changed')
                require(prior.get('work_completed') is False and prior.get('business_state') == 'unverified'
                        and prior.get('verified_business_receipt') is None, 'untrusted_business_claim')
                return prior
        require(len(reports) < 16, 'report_capacity')
        query = query_for(state, key)
        projection = lookup(state['decision']['conversation_id'], query)
        proof = evidence(state, query, projection)
        require(proof is not None, 'core_admission_unproven')
        run = projection.get('run')
        result = None
        if run is not None:
            require(type(run) is dict and set(run) == {'run_id', 'native_session_id', 'provider',
                    'binding_generation', 'state', 'dispatch_state', 'input_relation', 'completion_event_id',
                    'acceptance_event_id', 'payload_id', 'payload_sha256', 'payload_text'}
                    and projection.get('input_state') == 'consumed', 'core_run_projection')
            canonical_uuid(run.get('run_id'))
            for field in ('completion_event_id', 'acceptance_event_id', 'payload_id'):
                if run.get(field) is not None: canonical_uuid(run[field])
            require(run.get('input_relation') in ('exact_input', 'core_grouped_input')
                    and integer(run.get('binding_generation'), 1), 'core_run_lineage')
            text = run.get('payload_text')
            require((text is None and run.get('payload_sha256') is None)
                    or (type(text) is str and len(text.encode()) <= 8192 and run.get('payload_id') is not None
                        and sha(text) == run.get('payload_sha256')), 'core_payload_integrity')
            require(run.get('acceptance_event_id') is None or run.get('completion_event_id') is not None,
                    'core_acceptance_lineage')
            source_matches = (run.get('native_session_id') == query['source_native_session_id']
                              and run.get('provider') == query['source_provider']
                              and run['binding_generation'] == proof['source_binding_generation'])
            result = {k: run.get(k) for k in ('run_id', 'provider', 'binding_generation', 'state', 'dispatch_state',
                        'input_relation', 'completion_event_id', 'acceptance_event_id', 'payload_id', 'payload_sha256')}
            result.update(source_binding_matches=source_matches,
                          report_matches_core_payload=(source_matches and run['run_id'] == report['reported_run_id']
                                                       and sha(report['text']) == run.get('payload_sha256')))
        record = dict(report=dict(report), report_digest=report_digest, attribution='source_agent_report',
                      attribution_verified_by_core=bool(result and result['report_matches_core_payload']),
                      admission={k: proof[k] for k in ('message_id', 'event_id', 'sequence')},
                      core_result=result, verified_business_receipt=None, business_state='unverified', work_completed=False)
        reports.append(record); state['source_reports'] = reports; state['work_completed'] = False
        write(path, state)
        return record
