"""Read-only projections of existing disposable workflow assertions.

No admission, filesystem probe, provider call or extra test input occurs here.
"""
import hashlib
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3

EXPORT_SCOPE='conversation_export_filesystem'
ROUTING_SCOPE='standing_policy_handoff_no_excluded_provider_replay'


def digest(raw):return hashlib.sha256(raw).hexdigest()


@contextmanager
def connect(case):
    db=sqlite3.connect((case.package.data/'core.sqlite3').as_uri()+'?mode=ro',uri=True)
    db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
    try:yield db
    finally:db.close()


def run(db,identifier):
    rows=db.execute("SELECT r.id AS run_id,r.session_id,r.native_session_id,r.provider_kind AS provider,r.role,r.state,w.id AS window_id,w.generation AS window_generation,a.event_id AS acceptance_event_id FROM production_runs r JOIN execution_window_inputs i ON i.event_id=r.event_id AND i.message_id=r.message_id JOIN execution_windows w ON w.id=i.window_id JOIN production_acceptances a ON a.run_id=r.id WHERE r.id=?",(identifier,)).fetchall()
    assert len(rows)==1
    return dict(rows[0])


def attachment(case,identifier):
    with connect(case) as db:accepted=run(db,identifier)
    path=case.exports/case.conversation/'fixture.txt';info=path.stat()
    trace=(case.fixture.account/'sessions/synthetic-attachment-proof').read_text()
    lines=trace.splitlines()
    assert len(lines)==9 and lines[:4]==['begin','reference','read','matched'] and lines[6]=='readonly' and lines[8]=='scoped',lines
    def outcome(line,prefix):
        assert line.startswith(prefix+'=-1 errno=')
        return dict(result=-1,errno=int(line.split('errno=')[1]))
    return dict(covered_scope=EXPORT_SCOPE,run=accepted,conversation_id=case.conversation,
        foreign_conversation_id=case.other_export.name,authority_uid=case.package.authority_uid,
        executor_uid=case.package.executor_uid,
        export=dict(sha256=digest(path.read_bytes()),bytes=info.st_size,uid=info.st_uid,gid=info.st_gid,mode=info.st_mode&0o777),
        native_probe_trace=trace,native_probe=dict(read='matched',
            export_write=outcome(lines[4],'write'),canary_write=outcome(lines[5],'canary_write'),
            foreign_read=outcome(lines[7],'foreign_read')))


def routing(case,source,receipt,initial_epoch,old_turns,initial,current_run,message):
    with connect(case) as db:
        original=run(db,initial['core_run_id']);selected=run(db,current_run)
        rows=db.execute("SELECT h.id AS handoff_id,h.window_id,h.from_provider,h.to_provider,h.provider_generation,p.source_message_id,p.policy_sha256,p.source_commit,p.rule_ids_json FROM conversation_provider_handoffs h JOIN operator_provider_handoffs p ON p.handoff_id=h.id WHERE p.source_message_id=? AND p.source_commit=?",(receipt['message_id'],source)).fetchall()
        assert len(rows)==1
        handoff=dict(rows[0]);handoff['rule_ids']=json.loads(handoff.pop('rule_ids_json'))
        counts=dict(current_deep_runs=db.execute("SELECT count(*) FROM production_runs WHERE message_id=? AND role='deep'",(receipt['message_id'],)).fetchone()[0],
            source_deep_runs=db.execute("SELECT count(*) FROM production_runs WHERE message_id=(SELECT message_id FROM production_runs WHERE id=?) AND role='deep'",(initial['core_run_id'],)).fetchone()[0],
            policy_handoffs=len(rows))
        delivered=db.execute('SELECT turn_text FROM conversation_handoff_context_delivery WHERE run_id=?',(current_run,)).fetchone()[0]
    trace=case.fixture.root/'claude-workspace/claude-peer.jsonl'
    counts.update(excluded_turns_before=old_turns,excluded_turns_after=sum(json.loads(line)['kind']=='turn' for line in trace.read_text().splitlines()))
    assert '<historical_context>' in delivered and 'Current input:\n'+message in delivered
    return dict(covered_scope=ROUTING_SCOPE,input_message_id=receipt['message_id'],input_event_id=receipt['event_id'],
        source_run=original,selected_run=selected,handoff=handoff,prior_provider_generation=initial_epoch,
        counts=counts,quoted_turn_sha256=digest(delivered.encode()))
