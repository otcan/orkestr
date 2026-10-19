"""Count-only recent message projection for the source thread-message schema.

Uses every indexed metadata prefix, then a bounded timestamp range; never a
storage-order sample. No bodies or identifiers leave SQLite. No initializers.
"""
from datetime import timedelta
from pathlib import Path
import sqlite3
import time

INDEX = 'idx_orkestr_thread_messages_recent_delivery'
TABLE = 'orkestr_thread_messages'
COLUMNS = ('thread_id', 'source', 'connector', 'role', 'state', 'created_at', 'data')
QUERY = f'''
WITH prefixes AS MATERIALIZED (
 SELECT DISTINCT thread_id,source,connector,role,state
 FROM {TABLE} INDEXED BY {INDEX}
), recent AS MATERIALIZED (
 SELECT m.created_at,m.connector,m.role,m.data
 FROM prefixes p CROSS JOIN {TABLE} m INDEXED BY {INDEX}
 WHERE m.thread_id=p.thread_id AND m.source IS p.source
 AND m.connector IS p.connector AND m.role IS p.role AND m.state IS p.state
 AND m.created_at>=? AND m.created_at<=?
)
SELECT count(*),
 coalesce(sum(created_at>=?),0),
 coalesce(sum(connector COLLATE BINARY='whatsapp'),0),
 coalesce(sum(role COLLATE BINARY IN ('user','owner')),0),
 coalesce(sum(role COLLATE BINARY='assistant'),0),
 coalesce(sum(CASE WHEN json_valid(data) THEN
 json_type(data,'$.attachments')='array' AND json_array_length(data,'$.attachments')>0 ELSE 0 END),0)
FROM recent
'''
KEYS = ('within_30d', 'within_24h', 'whatsapp_30d', 'owner_user_30d',
        'assistant_30d', 'attachment_messages_30d')


def recent_messages(path, now):
    """One coherent RO transaction; timestamp authority is source ISO UTC text."""
    path = Path(path)
    if not path.is_absolute() or any(p.is_symlink() for p in (path, *path.parents)) or not path.is_file():
        raise ValueError('existing absolute regular database required')
    if now.utcoffset() != timedelta(0):
        raise ValueError('UTC observation required')
    db = sqlite3.connect(path.as_uri()+'?mode=ro', uri=True, isolation_level=None,
                         timeout=2, cached_statements=0)
    try:
        db.enable_load_extension(False)
        db.execute('PRAGMA query_only=ON')
        db.execute('PRAGMA trusted_schema=OFF')
        deadline = time.monotonic()+15
        db.set_progress_handler(lambda: int(time.monotonic()>deadline), 1000)
        db.execute('BEGIN')
        if not any(r[1] == TABLE and r[2] == 'table' for r in db.execute('PRAGMA main.table_list')):
            raise ValueError('source table unavailable')
        index_columns = tuple(r[2] for r in db.execute(f'PRAGMA main.index_info({INDEX})'))
        if index_columns != ('thread_id','source','connector','role','state','created_at','position'):
            raise ValueError('source range index unavailable or changed')
        def authorize(action, first, second, database, origin):
            if action == sqlite3.SQLITE_SELECT:
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_READ and first == TABLE and second in COLUMNS and database == 'main':
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_FUNCTION and second in ('count','sum','coalesce','json_valid','json_type','json_array_length'):
                return sqlite3.SQLITE_OK
            return sqlite3.SQLITE_DENY
        db.set_authorizer(authorize)
        stamp = lambda t: t.isoformat(timespec='milliseconds').replace('+00:00','Z')
        params = (stamp(now-timedelta(days=30)), stamp(now), stamp(now-timedelta(days=1)))
        counts = dict(zip(KEYS, db.execute(QUERY, params).fetchone()))
        return {'status':'observed', 'counts':counts,
                'coverage':'all index prefixes; recent source UTC ISO timestamp ranges; no row sampling',
                'consistency':'single pinned read-only transaction',
                'limitations':['recorded activity is not execution or delivery proof',
                               'noncanonical/missing timestamps outside lexical UTC range unresolved',
                               'not a cross-authority cut']}
    finally:
        db.close()
