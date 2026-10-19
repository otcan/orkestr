"""Synthetic SQL-valid retention fixture, not evidence of valid runtime authority."""
import hashlib
from pathlib import Path
import sqlite3
import subprocess

CORE = '006cca798e967fbd8deecd128933e46a2e0e94a8'
H = 'a' * 64


def migration_sources(root):
    prefix = 'v2/crates/store-sqlite/migrations/'
    names = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', CORE, prefix], text=True).splitlines()
    for name in names:
        (root / Path(name).name).write_bytes(subprocess.check_output(['git', 'show', CORE + ':' + name]))


def populate(path, migrations):
    db = sqlite3.connect(path)
    db.executescript('CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY,description TEXT NOT NULL,installed_on TEXT NOT NULL,success BOOLEAN NOT NULL,checksum BLOB NOT NULL,execution_time BIGINT NOT NULL);')
    for file in sorted(migrations.glob('*.sql')):
        sql = file.read_bytes()
        db.executescript(sql.decode())
        db.execute('INSERT INTO _sqlx_migrations VALUES(?,?,?,1,?,0)',
                   (int(file.name[:4]), file.stem[5:], '2000-01-01', hashlib.sha384(sql).digest()))
        db.commit()
    db.execute('PRAGMA foreign_keys=ON')
    def row(table, **values):
        columns = ','.join('"' + c + '"' for c in values)
        db.execute(f'INSERT INTO "{table}" ({columns}) VALUES ({",".join("?" for _ in values)})', list(values.values()))
    row('owners', id='owner-fake', username='synthetic-owner', password_hash='not-a-real-password-hash')
    row('conversations', id='conversation-fake', owner_id='owner-fake', sequence=20)
    for n in range(1, 6):
        row('messages', id=f'message-{n}', owner_id='owner-fake', conversation_id='conversation-fake', request_key=f'input-{n}', payload_digest=H, text=f'Synthetic delta {n}', actor_kind='owner', sequence=n)
        row('events', id=f'event-{n}', owner_id='owner-fake', conversation_id='conversation-fake', message_id=f'message-{n}', sequence=n)
        row('reasoning_inbox', conversation_id='conversation-fake', sequence=n, message_id=f'message-{n}', event_id=f'event-{n}', state='queued')
        row('outbox', event_id=f'event-{n}', state='pending')
    row('production_supervisors', context_id='context-fake', owner_id='owner-fake', provider_kind='codex', namespace='fake-provider', supervisor_key='fake-supervisor', incarnation_id='incarnation-fake', generation=1, lease_deadline_ms=1)
    for n, state in [(1, 'succeeded'), (2, 'blocked')]:
        row('session_bindings', id=f'session-{n}', owner_id='owner-fake', conversation_id='conversation-fake', role='deep', provider_kind='codex', provider_namespace='fake-provider', native_session_id=f'fake-native-{n}', state='retired')
        row('production_runs', id=f'run-{n}', context_id='context-fake', incarnation_id='incarnation-fake', owner_id='owner-fake', conversation_id='conversation-fake', session_id=f'session-{n}', native_session_id=f'fake-native-{n}', provider_kind='codex', binding_generation=1, message_id=f'message-{n}', event_id=f'event-{n}', scope_sequence=n, claim_generation=1, request_key=f'run-{n}', input_digest=H, lease_generation=1, dispatch_fence=1, lease_deadline_ms=1, attempt=1, state=state, dispatch_state='delivery_unknown')
    for eid, sequence, kind, version in [('completion', 6, 'provider_observed', 5), ('acceptance', 7, 'execution_accepted', 9), ('stop', 8, 'cancellation_requested', 6)]:
        row('events', id=eid, owner_id='owner-fake', conversation_id='conversation-fake', sequence=sequence, kind=kind, schema_version=version)
    row('production_observations', event_id='completion', run_id='run-1', run_sequence=1, semantic_digest=H, kind='completed_proposal', lease_generation=1, dispatch_fence=1, receipt_state='awaiting_acceptance')
    row('production_acceptances', run_id='run-1', owner_id='owner-fake', conversation_id='conversation-fake', completion_event_id='completion', event_id='acceptance', request_key='accept-fake', requested_revision=1, receipt_revision=2)
    row('production_run_leases', run_id='run-2', generation=1, lease_deadline_ms=1, dispatch_fence=1)
    row('production_cancellations', run_id='run-2', event_id='stop', request_key='stop-fake', lease_generation=1, dispatch_fence=1, lease_deadline_ms=1, receipt_state='cancel_requested', inflight_status='unknown')
    row('production_stop_boundaries', event_id='stop', owner_id='owner-fake', conversation_id='conversation-fake', run_id='run-2', through_scope_sequence=5)
    row('production_held_inputs', event_id='event-3', conversation_id='conversation-fake', scope_sequence=3, message_id='message-3', boundary_event_id='stop', reason='stop_boundary')
    row('worker_tasks', id='task-fake', owner_id='owner-fake', conversation_id='conversation-fake', parent_run_id='run-2', context_id='context-fake', incarnation_id='incarnation-fake', parent_control_revision=1, source_message_id='message-2', source_event_id='event-2', request_key='task-fake', request_digest=H, lifetime_ms=30000, created_at_ms=1000, state='held', execution_budget_ms=120000)
    # Budget retention is structural: expired parent/held task grant no execution.
    row('worker_running_budgets', run_id='run-2', task_id='task-fake', max_run_ms=180000, anchor_ms=1000, deadline_ms=121000, original_delegation_deadline_ms=31000)
    row('production_steering_turns', run_id='run-2', native_turn_id='fake-turn')
    for n, state in [(3, 'queued'), (4, 'delivery_unknown'), (5, 'acknowledged')]:
        row('production_steering', id=f'steering-{n}', owner_id='owner-fake', conversation_id='conversation-fake', run_id='run-2', request_key=f'steer-{n}', semantic_digest=H, browser_token_hash='fake-noncredential-hash', message_id=f'message-{n}', event_id=f'event-{n}', scope_sequence=n, disposition='queued_ordered', state=state, delivery_hash=None if n == 3 else H)
    row('worker_tool_delegations', id='tool-fake', owner_id='owner-fake', conversation_id='conversation-fake', parent_run_id='run-2', parent_session_id='session-2', context_id='context-fake', incarnation_id='incarnation-fake', parent_binding_generation=1, parent_lease_generation=1, parent_dispatch_fence=1, parent_deadline_ms=30001, operation='python_offline_v1', request_key='tool-fake', source_digest=H, source_text='synthetic inert text', requested_lifetime_ms=1000, expires_at_ms=1001, state='delivery_unknown', revision=2)
    row('worker_tool_results', delegation_id='tool-fake', parent_run_id='run-2', request_kind='text', request_id='fake-request', call_id='fake-call', native_thread='fake-thread', native_turn='fake-turn', call_digest=H, state='delivery_unknown', output_digest=H, response_text='synthetic retained result', response_digest=H, success=1, delivery_hash=H)
    row('history_imports', owner_id='owner-fake', namespace='history-fake', source_digest=H, source_conversation_id='source-fake', source_scope='global', source_watermark=1, message_count=1, revision=2, active=0, rolled_back_at=1)
    row('history_messages', owner_id='owner-fake', namespace='history-fake', ordinal=0, source_message_id='source-message-fake', source_sequence=1, actor_kind='owner', text='Synthetic retained inactive history')
    row('dormant_timers', owner_id='owner-fake', namespace='timer-fake', source_namespace='source-fake', source_timer_id='source-timer-fake', source_enabled=1, source_digest=H, schedule_json='{"kind":"interval","every_ms":86400000}', state='disabled', revision=3, generation=1, conversation_id='conversation-fake')
    row('dormant_timer_input_guards', owner_id='owner-fake', namespace='timer-fake', generation=1, conversation_id='conversation-fake', stop_sequence=0, request_key='enable-fake')
    row('durable_timer_authorities', owner_id='owner-fake', namespace='timer-fake', generation=1, authority_id='authority-fake', conversation_id='conversation-fake', request_key='enable-fake', expected_revision=1, instruction='Synthetic owner-created timer instructions', instruction_digest=H, stop_sequence=0)
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    db.commit()
    return db
