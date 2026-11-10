"""Review candidate: fixed attempt-provider and trigger-audit class aggregates.

No runtime discovery, raw grouping, identifiers or record payload projection.
"""
import sqlite3
from live_census import _read_transaction, _now

# agent-job-spec.js::AGENT_JOB_PROVIDERS/TEST_PROVIDERS/TRIGGER_TYPES
PROVIDERS = ('codex', 'claude-code', 'openai-compatible', 'simulated')
TRIGGERS = ('schedule', 'webhook', 'api', 'whatsapp')
PROJECTIONS = (
    ('attempt_provider', 'attempts', 'provider', PROVIDERS),
    ('trigger_audit_class', 'trigger_audit', 'trigger_type', TRIGGERS),
)


def _query(table, column, values):
    # All identifiers come from PROJECTIONS, never from caller input.
    return 'SELECT count(*), ' + ', '.join(
        f'coalesce(sum(CASE WHEN source."{column}" COLLATE BINARY = ? THEN 1 ELSE 0 END), 0)'
        for _ in values) + f' FROM main."{table}" AS source'


def _authorize(table, column):
    def authorize(action, arg1, arg2, database, trigger):
        if trigger is not None:
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_SELECT:
            return sqlite3.SQLITE_OK
        if (action == sqlite3.SQLITE_READ and arg1 == table and arg2 in ('', column)
                and database in (None, 'main')):
            return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_FUNCTION and arg2 in ('count', 'sum', 'coalesce'):
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY
    return authorize


def workflow_class_projection(path):
    """Private persisted observations, not distinct workflows or active usage.

    Independent source review is required before production invocation.
    Errors abort the complete report; do not publish raw database exceptions.
    """
    started = _now()
    reports = {}
    with _read_transaction(path, 'jobs') as (db, metadata):
        for name, table, column, values in PROJECTIONS:
            if metadata.get(table) != 'table':
                reports[name] = {'status': 'unavailable'}
                continue
            db.set_authorizer(_authorize(table, column))
            result = db.execute(_query(table, column, values), values).fetchone()
            buckets = dict(zip(values, result[1:]))
            buckets['unknown'] = result[0] - sum(buckets.values())
            reports[name] = {'status': 'observed', 'buckets': buckets}
    return {'format_version': 1, 'coverage': 'partial', 'reports': reports,
            'started_at': started, 'finished_at': _now(),
            'consistency': 'single-store-read-transaction',
            'cross_store_consistency': False,
            'meaning': 'persisted attempts and trigger audits; not workflow coverage or active execution'}
