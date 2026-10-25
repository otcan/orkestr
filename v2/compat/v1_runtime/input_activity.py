"""Read-only, exact-input activity hints for the transport's fallback acknowledgement."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import time

MAX_AGE_MS = 5000


def record(data, statuses, own_runs, now=None):
    now = time.time() if now is None else now
    deep, fast = statuses.get('deep') or {}, statuses.get('fast') or {}
    data['transport_activity'] = dict(observed_at_ms=int(now*1000),
        deep_running=deep.get('run_id') in own_runs and deep.get('phase') == 'running',
        fast_ready=fast.get('run_id') in own_runs and fast.get('phase') in ('awaiting_acceptance','completed'),
        final_ready=deep.get('run_id') in own_runs and deep.get('phase') in ('awaiting_acceptance','completed'))


def read(ledger, public_id, enabled=True, now=None):
    now_ms = int((time.time() if now is None else now)*1000)
    with closing(sqlite3.connect(Path(ledger.path).as_uri()+'?mode=ro',uri=True)) as db:
        db.execute('PRAGMA query_only=ON')
        row = db.execute('SELECT data FROM inputs WHERE public_id=?',(public_id,)).fetchone()
    if not row:
        return None
    data=json.loads(row[0]);activity=data.get('transport_activity') or {}
    observed=activity.get('observed_at_ms')
    fresh=type(observed) is int and 0<=now_ms-observed<=MAX_AGE_MS
    ready=bool(activity.get('final_ready') or data.get('deep_final_ready_at') or data.get('phase')=='completed')
    return dict(publicMessageId=public_id,phase=data.get('phase'),observedAtMs=observed,
        active=bool(enabled and fresh and activity.get('deep_running') and data.get('phase')=='running'
                    and not data.get('absorbed_into') and not data.get('refused') and not ready),
        fastReady=bool(fresh and activity.get('fast_ready')),finalReady=ready)
