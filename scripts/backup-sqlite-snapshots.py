#!/usr/bin/env python3
"""Bounded, per-database SQLite backup API snapshots; never a global barrier."""
from contextlib import closing
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import resource
import re
import signal
import sqlite3
import sys
import time

CANONICAL = {
    'threads.sqlite': None,
    'thread-messages.sqlite': None,
    'agent-jobs.sqlite': 'ORKESTR_AGENT_JOBS_DB',
    'thread-resource-policy.sqlite': 'ORKESTR_THREAD_RESOURCE_POLICY_DB',
    'connector-outbox.sqlite': 'ORKESTR_CONNECTOR_OUTBOX_DB',
    'broker-instances.sqlite': 'ORKESTR_BROKER_INSTANCES_DB',
    'data/connector-inbox.sqlite': 'ORKESTR_CONNECTOR_INBOX_DB',
}
MANIFEST = '.orkestr-sqlite-snapshots.json'


def fail_signal(signum, _frame):
    raise RuntimeError('snapshot interrupted or deadline exceeded: signal %d' % signum)


def positive(name, default):
    value = int(os.environ.get(name, default))
    if value <= 0:
        raise ValueError(name + ' must be positive')
    return value


def prepare(home, stage):
    if home.is_symlink():
        raise ValueError('state home must be a directory, not a symlink')
    home = home.resolve(strict=True)
    try:
        stage.resolve().relative_to(home)
    except ValueError:
        pass
    else:
        raise ValueError('snapshot staging must be outside state home')
    overlay = stage / 'snapshot-overlay'
    overlay.mkdir(mode=0o700)
    if (home / MANIFEST).exists() or (home / MANIFEST).is_symlink():
        raise ValueError('reserved snapshot manifest already exists in state')
    budget = positive('ORKESTR_DEPLOY_SQLITE_MAX_BYTES', 8 * 1024**3)
    seconds = positive('ORKESTR_DEPLOY_SQLITE_TIMEOUT_SECONDS', 300)
    deadline = time.monotonic() + seconds
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM, signal.SIGXFSZ):
        signal.signal(sig, fail_signal)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    patterns = os.environ.get('ORKESTR_DEPLOY_BACKUP_EXCLUDES',
                              'run tmp whatsapp-bridge/sessions wa-skills/*/session wa-skills/*/state').split()
    exclusions, records = [], []
    total = 0
    seen = set()
    for default, variable in CANONICAL.items():
        path = Path(os.environ.get(variable, '') or home / default) if variable else home / default
        # Relative configured paths follow application path.resolve semantics.
        path = path.absolute()
        relative = path.relative_to(home).as_posix()
        if any(p == '..' for p in Path(relative).parts):
            raise ValueError('canonical database escapes state root')
        if relative in seen:
            raise ValueError('canonical database paths overlap')
        seen.add(relative)
        if path.resolve() != path:
            raise ValueError('canonical database path contains a symlink')
        exclusions.extend(relative + suffix for suffix in ('', '-wal', '-shm', '-journal'))
        ancestors = [relative] + [p.as_posix() for p in Path(relative).parents if p.as_posix() != '.']
        if any(fnmatch.fnmatchcase(p, pattern) or fnmatch.fnmatchcase(str(home / p), pattern)
               for pattern in patterns for p in ancestors):
            continue
        if not path.exists():
            continue
        for suffix in ('-wal', '-shm', '-journal'):
            companion = Path(str(path) + suffix)
            if companion.is_symlink() or (companion.exists() and not companion.is_file()):
                raise ValueError('canonical database companion must be a regular file')
        if not path.is_file():
            raise ValueError('canonical database must be a regular file')
        destination = overlay / relative
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        remaining = budget - total
        if remaining <= 0:
            raise ValueError('SQLite snapshot byte budget exhausted')
        resource.setrlimit(resource.RLIMIT_FSIZE, (remaining, resource.getrlimit(resource.RLIMIT_FSIZE)[1]))
        def progress(_status, _remaining, _pages):
            if time.monotonic() >= deadline:
                raise TimeoutError('SQLite snapshot deadline exceeded')
            if destination.stat().st_size > remaining:
                raise ValueError('SQLite snapshot byte budget exceeded')
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=1)) as source:
            with closing(sqlite3.connect(destination)) as target:
                target.set_progress_handler(lambda: int(time.monotonic() >= deadline), 10000)
                source.backup(target, pages=128, progress=progress, sleep=0.01)
                if target.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise ValueError('snapshot integrity check failed')
        size = destination.stat().st_size
        total += size
        if total > budget:
            raise ValueError('SQLite snapshot byte budget exceeded')
        digest = hashlib.sha256()
        with destination.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        digest = digest.hexdigest()
        records.append({'original_relative_path': relative, 'bytes': size, 'sha256': digest, 'complete': True})
    # GNU tar wildcard exclusions must match literal configured DB paths.
    escaped = [re.sub(r'([\\*?\[\]])', r'\\\1', home.name + '/' + p) for p in exclusions]
    (stage / 'excludes.nul').write_bytes(b''.join(p.encode() + b'\0' for p in escaped))
    manifest = {'format': 1, 'complete': True, 'consistency': 'per-database SQLite backup API; no cross-store writer barrier',
                'databases': records, 'snapshot_bytes': total}
    (overlay / MANIFEST).write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    signal.setitimer(signal.ITIMER_REAL, 0)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        prepare(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception as error:
        print('SQLite snapshot stage failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
