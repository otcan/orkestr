"""Synthetic archive integration oracle; never touches application state."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import tempfile
import threading
import time

with tempfile.TemporaryDirectory(prefix='sqlite-backup-test-') as temporary:
    root = Path(temporary)
    home = root / 'state'
    home.mkdir()
    backups = root / 'deploy/backups'
    env = {'PATH': os.environ['PATH'], 'HOME': str(root), 'ORKESTR_HOME': str(home),
           'ORKESTR_ENV_FILE': str(root / 'missing.env'), 'ORKESTR_DEPLOY_ROOT': str(root / 'deploy'),
           'ORKESTR_DEPLOY_LOCK_FILE': str(root / 'lock'), 'ORKESTR_DEPLOY_BACKUP_KEEP': '1', 'ORKESTR_DEPLOY_BACKUP_COMPRESSOR': 'none',
           'ORKESTR_DEPLOY_BACKUP_EXCLUDES': 'run tmp worktrees/*/node_modules'}
    db = home / 'threads.sqlite'
    connection = sqlite3.connect(db)
    connection.execute('PRAGMA journal_mode=WAL')
    connection.execute('CREATE TABLE fixture(value INTEGER)')
    connection.execute('INSERT INTO fixture VALUES (7)')
    connection.commit()
    (home / 'uploads').mkdir()
    (home / 'uploads/keep').write_text('user bytes')
    cache = home / 'worktrees/example/node_modules'
    cache.mkdir(parents=True)
    (cache / 'omit').write_text('cache')
    stop = threading.Event()
    writes = []
    def writer():
        with closing(sqlite3.connect(db)) as active:
            while not stop.is_set():
                active.execute('UPDATE fixture SET value=value+1')
                active.commit()
                writes.append(1)
                time.sleep(.002)
    thread = threading.Thread(target=writer)
    thread.start()
    def backup(extra=None):
        return subprocess.run(['bash', 'scripts/deploy-git-release.sh', 'backup'],
                              env={**env, **(extra or {})}, capture_output=True, text=True, timeout=15)
    try:
        result = backup()
        assert result.returncode == 0, result.stderr
    finally:
        stop.set()
        thread.join()
    assert writes
    archive = Path(result.stdout.strip())
    original_archive = hashlib.sha256(archive.read_bytes()).hexdigest()
    restored = root / 'restored'
    restored.mkdir()
    subprocess.run(['tar', '-xf', archive, '-C', restored], check=True)
    manifest = json.loads((restored / 'state/.orkestr-sqlite-snapshots.json').read_text())
    assert manifest['complete'] and len(manifest['databases']) == 1
    record = manifest['databases'][0]
    restored_db = restored / 'state/threads.sqlite'
    assert record['original_relative_path'] == 'threads.sqlite'
    assert hashlib.sha256(restored_db.read_bytes()).hexdigest() == record['sha256']
    assert not (restored / 'state/threads.sqlite-wal').exists()
    assert not (restored / 'state/threads.sqlite-shm').exists()
    with closing(sqlite3.connect(restored_db)) as check:
        assert check.execute('PRAGMA integrity_check').fetchone() == ('ok',)
        assert 7 <= check.execute('SELECT value FROM fixture').fetchone()[0] <= 7 + len(writes)
    assert (restored / 'state/uploads/keep').read_text() == 'user bytes'
    assert not (restored / 'state/worktrees/example/node_modules').exists()
    for extra in ({'ORKESTR_DEPLOY_SQLITE_MAX_BYTES': '1'},
                  {'ORKESTR_THREAD_RESOURCE_POLICY_DB': str(root / 'outside.sqlite')}):
        failed = backup(extra)
        assert failed.returncode != 0
        assert sorted(backups.iterdir()) == [archive]
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == original_archive
    # A malformed canonical DB must fail before publishing any replacement.
    (home / 'agent-jobs.sqlite').write_bytes(b'not SQLite')
    assert backup().returncode != 0
    (home / 'agent-jobs.sqlite').unlink()
    assert sorted(backups.iterdir()) == [archive]
    # An explicitly excluded canonical DB is neither snapshotted nor copied raw.
    excluded = backup({'ORKESTR_DEPLOY_BACKUP_EXCLUDES': env['ORKESTR_DEPLOY_BACKUP_EXCLUDES'] + ' threads.sqlite'})
    assert excluded.returncode == 0, excluded.stderr
    excluded_archive = Path(excluded.stdout.strip())
    names = subprocess.check_output(['tar', '-tf', excluded_archive], text=True).splitlines()
    assert not any(n.startswith('state/threads.sqlite') for n in names)
    # Minimum retention keeps both verified recovery points, even with KEEP=1.
    expected_backups = sorted([archive, excluded_archive])
    archive = excluded_archive
    # Hold an exclusive lock in rollback mode so the backup API waits; terminate
    # the supervisor and require its trap to remove both private staging/partial.
    connection.close()
    locked = sqlite3.connect(db)
    locked.execute('PRAGMA journal_mode=DELETE')
    locked.execute('BEGIN EXCLUSIVE')
    timed = backup({'ORKESTR_DEPLOY_SQLITE_TIMEOUT_SECONDS': '1'})
    assert timed.returncode != 0 and 'deadline' in timed.stderr
    assert sorted(backups.iterdir()) == expected_backups
    process = subprocess.Popen(['bash', 'scripts/deploy-git-release.sh', 'backup'], env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        deadline = time.monotonic() + 5
        while not list(backups.glob('.sqlite-snapshots.*/snapshot-overlay')):
            assert time.monotonic() < deadline
            time.sleep(.01)
        # Bound the blocked helper too, so shell trap completion is deterministic.
        os.killpg(process.pid, signal.SIGTERM)
        locked.rollback()
        process.communicate(timeout=5)
        assert process.returncode != 0
        assert sorted(backups.iterdir()) == expected_backups
    finally:
        locked.close()
        if process.poll() is None:
            process.kill()
            process.communicate()
    print('all snapshot checks passed')
