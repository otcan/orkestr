"""Reviewed-edge candidate: fixed-table live SQLite counts, never store setup."""
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sqlite3

from census import TABLES


def _now():
    return datetime.now(timezone.utc).isoformat()


def _authorizer(tables):
    def authorize(action, arg1, arg2, database, trigger):
        if trigger is not None:
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_SELECT:
            return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_READ and database in (None, 'main') and arg1 in tables and arg2 == '':
            return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_FUNCTION and arg2 == 'count':
            return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_PRAGMA and arg1 == 'table_list' and arg2 is None:
            return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_TRANSACTION and arg1 in ('BEGIN', 'ROLLBACK'):
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY
    return authorize


@contextmanager
def _read_transaction(path, family):
    if family not in TABLES:
        raise ValueError('unsupported source family')
    source = Path(path)
    if any(part.is_symlink() for part in (source, *source.parents)) or not source.is_file():
        raise ValueError('existing regular database without symlink ancestors required')
    # URI encoding prevents path characters from becoming connection options.
    db = sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True,
                         isolation_level=None, timeout=2, cached_statements=0)
    try:
        db.enable_load_extension(False)
        db.execute('PRAGMA trusted_schema=OFF')
        db.execute('PRAGMA query_only=ON')
        db.set_authorizer(_authorizer(TABLES[family]))
        db.execute('BEGIN')
        # Reading schema pins the snapshot before any counts or concurrent commits.
        metadata = {row[1]: row[2] for row in db.execute('PRAGMA main.table_list')
                    if row[0] == 'main' and row[1] in TABLES[family]}
        yield db, metadata
    finally:
        # Closing always releases the transaction, including on partial failure.
        db.close()


def _count_table(db, table):
    return db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]


def count_live(path, *, family):
    """Private aggregate report; caller must review/authorize the exact store.

    SQLite mode=ro can use normal WAL/SHM coordination. No immutable shortcut,
    initializer, registry fallback, schema migration or cross-store claim.
    Errors abort the entire report; callers must not log raw SQLite exceptions.
    """
    started = _now()
    with _read_transaction(path, family) as (db, metadata):
        counts = {}
        for table in TABLES[family]:
            kind = metadata.get(table)
            if kind is None:
                counts[table] = {'status': 'absent', 'count': None}
            elif kind != 'table':
                counts[table] = {'status': 'unsupported', 'count': None}
            else:
                counts[table] = {'status': 'counted', 'count': _count_table(db, table)}
    return {'format_version': 1, 'family': family, 'coverage': 'partial',
            'consistency': 'single-store-read-transaction',
            'started_at': started, 'finished_at': _now(), 'counts': counts,
            'cross_store_consistency': False}
