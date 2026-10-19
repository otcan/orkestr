"""Read-only authority checks for owned stopped synthetic upgrade databases."""
from contextlib import closing
import sqlite3


def snapshot(home):
    with closing(sqlite3.connect((home/'data/core.sqlite3').as_uri()+'?mode=ro',uri=True)) as db:
        tables={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        tasks={row[0]:tuple(row[1:]) for row in db.execute(
            'SELECT id,state,claim_hash,delegation_id FROM worker_tasks')} if 'worker_tasks' in tables else {}
        authority={}
        for table,columns in [('production_runs','id,state,dispatch_state'),
                              ('worker_provider_delegations','id,state,grant_hash,admitted_run_id')]:
            authority[table]={row[0]:tuple(row[1:]) for row in db.execute('SELECT '+columns+' FROM '+table)} if table in tables else {}
        ledgers={}
        for table in ('dormant_timers','worker_tool_results','durable_timer_authorities','production_steering','production_steering_turns'):
            ledgers[table]=sorted(db.execute('SELECT * FROM '+table).fetchall(),key=repr) if table in tables else []
        return {'tasks':tasks,'authority':authority,'ledgers':ledgers}


def verify(before, after):
    if set(before['tasks']) != set(after['tasks']):
        raise RuntimeError('upgrade changed task receipt inventory')
    held=0
    for key, prior in before['tasks'].items():
        expected=('held',None,prior[2]) if prior[0] in ('queued','claimed') else prior
        if after['tasks'][key] != expected:
            raise RuntimeError('upgrade failed to hold pending task or changed historical receipt')
        held += prior[0] in ('queued','claimed')
    for table, rows in before['authority'].items():
        current=after['authority'][table]
        if set(current)!=set(rows):
            raise RuntimeError('upgrade created or removed execution authority')
        for key, prior in rows.items():
            now=current[key]
            if table=='production_runs':
                # Startup can negatively fence an old run. It cannot activate an
                # inactive run or change an old delivery fence into a candidate.
                if (now[0] in ('starting','running','awaiting_acceptance') and now[0]!=prior[0]) or (now[1] in ('candidate','reserved') and now[1]!=prior[1]):
                    raise RuntimeError('upgrade reactivated run authority')
            elif now != prior:
                raise RuntimeError('upgrade changed historical delegation authority')
    for table in ('dormant_timers','worker_tool_results','durable_timer_authorities','production_steering','production_steering_turns'):
        if before.get('ledgers',{}).get(table,[]) != after.get('ledgers',{}).get(table,[]):
            raise RuntimeError('upgrade changed dormant timer or result authority ledger')
    return {'pending_tasks_held':held,'task_receipts_preserved':len(before['tasks']),
            'new_execution_authority':0,'scope':'stopped synthetic database rows; no provider activation proof'}
