"""Synthetic restore/rebackup, exact tar namespace, and resolver regressions."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile

MANIFEST = '.orkestr-sqlite-snapshots.json'
VARIABLES = {
    'ORKESTR_AGENT_JOBS_DB': 'agent[literal]?*.sqlite',
    'ORKESTR_CONNECTOR_INBOX_DB': 'inbox[literal]?*.sqlite',
    # These three resolvers deliberately do NOT trim their configured paths.
    'ORKESTR_THREAD_RESOURCE_POLICY_DB': 'policy.sqlite ',
    'ORKESTR_CONNECTOR_OUTBOX_DB': 'outbox.sqlite ',
    'ORKESTR_BROKER_INSTANCES_DB': 'broker.sqlite ',
}
TRIMMED = {'ORKESTR_AGENT_JOBS_DB', 'ORKESTR_CONNECTOR_INBOX_DB'}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def environment(root, home):
    env = {'PATH': os.environ['PATH'], 'HOME': str(root), 'ORKESTR_HOME': str(home) + '/.',
           'ORKESTR_ENV_FILE': str(root / 'absent.env'), 'ORKESTR_DEPLOY_ROOT': str(root / 'deploy'),
           'ORKESTR_DEPLOY_LOCK_FILE': str(root / 'lock'), 'ORKESTR_DEPLOY_BACKUP_COMPRESSOR': 'none',
           'ORKESTR_DEPLOY_BACKUP_EXCLUDES': 'run tmp worktrees/*/node_modules'}
    for variable, name in VARIABLES.items():
        value = str(home / name)
        env[variable] = ' \t' + value + '\ufeff ' if variable in TRIMMED else value
    return env


def backup(root, home):
    return subprocess.run(['bash', 'scripts/deploy-git-release.sh', 'backup'],
                          env=environment(root, home), capture_output=True, text=True, timeout=10)


def restore(archive, destination, basename, names):
    destination.mkdir()
    with tarfile.open(archive) as stream:
        members = stream.getnames()
        assert members.count(basename + '/' + MANIFEST) == 1, members
        for name in names:
            assert members.count(basename + '/' + name) == 1, (name, members)
            for suffix in ('-wal', '-shm', '-journal'):
                assert basename + '/' + name + suffix not in members
            # A nested member with the same suffix must not be excluded.
            assert basename + '/projects/' + basename + '/' + name in members
            assert basename + '/' + name + '-wal-extra' in members
        assert not any('/node_modules/' in name for name in members)
    # Only this test's freshly generated synthetic archive is extracted.
    subprocess.run(['tar', '-xf', archive, '-C', destination], check=True)
    restored = destination / basename
    receipt = json.loads((restored / MANIFEST).read_text())
    assert receipt['complete'] and len(receipt['databases']) == len(names)
    for record in receipt['databases']:
        path = restored / record['original_relative_path']
        assert digest(path) == record['sha256']
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
            assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
    return restored, receipt


for basename in ('state', 'snapshot-overlay', 'state[literal]?*'):
    with tempfile.TemporaryDirectory(prefix='sqlite-backup-lifecycle-') as temporary:
        root = Path(temporary)
        home = root / basename
        home.mkdir()
        names = ['threads.sqlite', 'thread-messages.sqlite', *VARIABLES.values()]
        connections = []
        try:
            for name in names:
                db = sqlite3.connect(home / name)
                connections.append(db)
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE fixture(value INTEGER)')
                db.execute('INSERT INTO fixture VALUES (7)')
                db.commit()
                # Preserve near matches and nested same-basename project files.
                nested = home / 'projects' / basename / name
                nested.parent.mkdir(parents=True, exist_ok=True)
                nested.write_bytes(b'private synthetic project file')
                (home / (name + '-wal-extra')).write_bytes(b'unrelated suffix')
            cache = home / 'worktrees/example/node_modules'
            cache.mkdir(parents=True)
            (cache / 'excluded').write_text('regenerable cache')
            (home / 'uploads').mkdir()
            (home / 'uploads/keep').write_bytes(b'preserved upload')
            source_hashes = {str(path): digest(path) for name in names
                             for path in (home / name, home / (name + '-wal'))}
            first = backup(root, home)
            assert first.returncode == 0, first.stderr
            # Read-only source DB/WAL bytes remain identical, including padding cases.
            assert all(digest(Path(path)) == value for path, value in source_hashes.items())
            restored, old = restore(first.stdout.strip(), root / 'restore-one', basename, names)
            previous = (restored / MANIFEST).read_bytes()
            with closing(sqlite3.connect(restored / 'threads.sqlite')) as db:
                db.execute('UPDATE fixture SET value=42')
                db.commit()
            second = backup(root, restored)
            assert second.returncode == 0, second.stderr
            assert (restored / MANIFEST).read_bytes() == previous
            again, new = restore(second.stdout.strip(), root / 'restore-two', basename, names)
            assert new != old  # Receipt regenerated for the changed database, not copied.
            assert (again / 'uploads/keep').read_bytes() == b'preserved upload'
            with closing(sqlite3.connect(again / 'threads.sqlite')) as db:
                assert db.execute('SELECT value FROM fixture').fetchone() == (42,)
            # Recognize prior format only; do not overwrite arbitrary reserved paths.
            manifest_path = again / MANIFEST
            valid = manifest_path.read_bytes()
            backups = root / 'deploy/backups'
            before = {path.name: digest(path) for path in backups.iterdir()}
            malformed = [b'arbitrary user bytes', b'{}', valid[:-2],
                         valid.replace(b'"complete": true', b'"complete": false', 1),
                         valid.replace(b'"format": 1', b'"format": 1, "format": 1', 1),
                         b'x' * 65537]
            for value in malformed:
                manifest_path.write_bytes(value)
                result = backup(root, again)
                assert result.returncode != 0
                assert manifest_path.read_bytes() == value
                assert {path.name: digest(path) for path in backups.iterdir()} == before
            manifest_path.unlink()
            target = root / 'unrelated-receipt'
            target.write_bytes(valid)
            manifest_path.symlink_to(target)
            assert backup(root, again).returncode != 0
            assert manifest_path.is_symlink() and target.read_bytes() == valid
            manifest_path.unlink()
            os.mkfifo(manifest_path, 0o600)
            assert backup(root, again).returncode != 0
            assert manifest_path.is_fifo()
            manifest_path.unlink()
            manifest_path.mkdir()
            assert backup(root, again).returncode != 0
            assert manifest_path.is_dir()
            assert {path.name: digest(path) for path in backups.iterdir()} == before
        finally:
            for db in connections:
                db.close()
print('all lifecycle checks passed')
