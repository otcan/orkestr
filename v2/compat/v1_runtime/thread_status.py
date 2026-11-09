"""Read-only Core execution projection; model success is not task completion."""
import time

from .rust_client import ClientError

PHASES = frozenset(('queued', 'starting', 'running', 'cancel_requested', 'cancelled',
                    'awaiting_acceptance', 'completed', 'failed', 'blocked'))


def read(binding):
    client = getattr(binding.worker, 'client', None)
    if binding.state != 'enabled' or client is None:
        raise ClientError('binding_unavailable')
    conversation = binding.config['conversation_id']
    roles = {}
    for role, route in (('deep', '/execution'), ('fast', '/fast/execution')):
        status, value = client.request('GET', route, allowed=(200, 404))
        if status == 404:
            roles[role] = None
            continue
        if (not isinstance(value, dict) or value.get('conversation_id') != conversation
                or value.get('phase') not in PHASES or type(value.get('observed_at_ms')) is not int):
            raise ClientError('invalid_execution_status')
        roles[role] = dict(phase=value['phase'], runId=value.get('run_id'),
                           observedAtMs=value['observed_at_ms'], revision=value.get('revision'),
                           lastProgressAtMs=(value.get('progress') or {}).get('observed_at_ms'),
                           failure=(value.get('failure') or {}).get('class'))
    _, queue = client.request('GET', '/window/queue')
    if not isinstance(queue, dict) or queue.get('conversation_id') != conversation or not isinstance(queue.get('entries'), list):
        raise ClientError('invalid_execution_queue')
    entries = [dict(inputMessageId=row.get('input_message_id'), inputEventId=row.get('input_event_id'),
                    queuedAtMs=row.get('queued_at_ms'), position=row.get('position'))
               for row in queue['entries'] if row.get('state') == 'queued']
    return dict(version=1, source='core', publicThreadId=binding.config['public_thread_id'],
                conversationId=conversation, observedAtMs=int(time.time()*1000),
                roles=roles, queuedInputs=entries, taskOutcome='unknown')
