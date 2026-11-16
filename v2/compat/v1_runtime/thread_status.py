"""Read-only Core execution projection; model success is not task completion."""
import re
import time

from .rust_client import ClientError

PHASES = frozenset(('queued', 'starting', 'running', 'cancel_requested', 'cancelled',
                    'awaiting_acceptance', 'completed', 'failed', 'blocked'))
PROVIDERS = frozenset(('codex', 'claude'))
FAILURES = frozenset(('policy', 'authentication', 'quota', 'billing', 'provider', 'unknown'))
MODEL = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}')
RUN = re.compile(r'[A-Za-z0-9-]{1,64}')


def _int(value):
    return value if type(value) is int else None


def _model(models):
    """Provider and observed model of the run, when Core reported them."""
    if not isinstance(models, dict):
        return None, None
    provider = models.get('provider') if isinstance(models.get('provider'), str) and models['provider'] in PROVIDERS else None
    for key in ('actual_model', 'resolved_model'):
        value = models.get(key)
        if isinstance(value, str) and MODEL.fullmatch(value) and '..' not in value and '//' not in value:
            return provider, value
    return provider, None


def _role(client, conversation, route):
    # Core answers 204 when the role has no run (or no Fast role is
    # configured): nothing executing there. Any other answer, including a
    # 404 for the conversation, is no evidence and fails the whole read.
    status, value = client.request('GET', route, allowed=(200, 204))
    if status == 204:
        return None
    if (not isinstance(value, dict) or value.get('conversation_id') != conversation
            or value.get('phase') not in PHASES or type(value.get('observed_at_ms')) is not int):
        raise ClientError('invalid_execution_status')
    # Closed fields only: Core's payload, event and acceptance ids, resources
    # and capabilities stay in Core.
    provider, model = _model(value.get('models'))
    run, progress, failure = value.get('run_id'), value.get('progress'), value.get('failure')
    failure = failure.get('class') if isinstance(failure, dict) else None
    age_observed, age = _queue_age(value)
    return dict(phase=value['phase'], runId=run if isinstance(run, str) and RUN.fullmatch(run) else None,
                observedAtMs=value['observed_at_ms'], revision=_int(value.get('revision')),
                lastProgressAtMs=_int(progress.get('observed_at_ms')) if isinstance(progress, dict) else None,
                failure=failure if isinstance(failure, str) and failure in FAILURES else None, provider=provider, model=model,
                queueObserved=age_observed, queueAgeMs=age)


def _queue_age(value):
    """(observed, age) of Core's eligible pending input for the current Deep read.

    Core's `queue_age_ms` is the age of the conversation's oldest reasoning
    inbox input that is queued or claimed and not held (ordinary_input_holds);
    reserved steering has consumed its input, deferred steering stays queued.
    It is present (null when nothing is pending) even when the latest run
    decides the phase. It is an age, never a count. A missing or malformed
    field is unobserved, not "nothing pending"."""
    if 'queue_age_ms' not in value:
        return False, None
    age = value['queue_age_ms']
    if age is None:
        return True, None
    if type(age) is int and age >= 0:
        return True, age
    return False, None


def read(binding):
    client = getattr(binding.worker, 'client', None)
    if binding.state != 'enabled' or client is None:
        raise ClientError('binding_unavailable')
    conversation = binding.config['conversation_id']
    roles = {role: _role(client, conversation, route)
             for role, route in (('deep', '/execution'), ('fast', '/fast/execution'))}
    _, queue = client.request('GET', '/window/queue')
    if not isinstance(queue, dict) or queue.get('conversation_id') != conversation or not isinstance(queue.get('entries'), list):
        raise ClientError('invalid_execution_queue')
    entries = [dict(inputMessageId=row.get('input_message_id'), inputEventId=row.get('input_event_id'),
                    queuedAtMs=_int(row.get('queued_at_ms')), position=_int(row.get('position')))
               for row in queue['entries']
               if isinstance(row, dict) and row.get('state') == 'queued' and row.get('conversation_id', conversation) == conversation]
    return dict(version=1, source='core', publicThreadId=binding.config['public_thread_id'],
                conversationId=conversation, observedAtMs=int(time.time()*1000),
                roles=roles, queuedInputs=entries, taskOutcome='unknown')
