"""Proposed semantic aggregate projection; source review required before live use.

Only runs.state is read. No raw state value ever leaves SQLite.
"""
import sqlite3
from live_census import _read_transaction, _now

# packages/core/src/agent-job-store.js::RUN_ACTIVE_STATES/RUN_TERMINAL_STATES
RUN_STATES = ('pending', 'running', 'retrying', 'awaiting_approval',
              'succeeded', 'failed', 'cancelled', 'skipped')
RUN_QUERY = 'SELECT count(*), ' + ', '.join(
    'coalesce(sum(CASE WHEN source.state COLLATE BINARY = ? THEN 1 ELSE 0 END), 0)'
    for _ in RUN_STATES) + ' FROM main."runs" AS source'


def _authorize(action, arg1, arg2, database, trigger):
    if trigger is not None:
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_SELECT:
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_READ and arg1 == 'runs' and arg2 in ('', 'state') and database in (None, 'main'):
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_FUNCTION and arg2 in ('count', 'sum', 'coalesce'):
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def run_state_projection(path):
    """Private per-store observation of persisted state, not workflow coverage.

    Candidate edge only: no CLI/automatic runtime discovery or live invocation.
    """
    started = _now()
    with _read_transaction(path, 'jobs') as (db, metadata):
        if metadata.get('runs') != 'table':
            return {'format_version': 1, 'status': 'unavailable', 'coverage': 'partial'}
        db.set_authorizer(_authorize)
        values = db.execute(RUN_QUERY, RUN_STATES).fetchone()
    buckets = dict(zip(RUN_STATES, values[1:]))
    buckets['unknown'] = values[0] - sum(buckets.values())
    return {'format_version': 1, 'status': 'observed', 'coverage': 'partial',
            'started_at': started, 'finished_at': _now(),
            'consistency': 'single-store-read-transaction',
            'cross_store_consistency': False, 'buckets': buckets,
            'meaning': 'persisted run state; not verified current execution or workflow usage'}
