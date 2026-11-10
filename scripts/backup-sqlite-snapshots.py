#!/usr/bin/env python3
"""Bounded, per-database SQLite backup API snapshots; never a global barrier."""
from contextlib import closing
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import resource
import stat
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
CONSISTENCY = 'per-database SQLite backup API; no cross-store writer barrier'
# ECMAScript String.trim(), used only by the two application resolvers that trim.
JS_SPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def canonical_path(home, default, variable):
    configured = os.environ.get(variable, '') if variable else ''
    if variable in ('ORKESTR_AGENT_JOBS_DB', 'ORKESTR_CONNECTOR_INBOX_DB'):
        configured = configured.strip(JS_SPACE)
    if variable == 'ORKESTR_CONNECTOR_INBOX_DB':
        # Unlike dataPaths, the inbox resolver also trims ORKESTR_HOME.
        inbox_home = os.environ.get('ORKESTR_HOME', str(home)).strip(JS_SPACE)
        fallback = Path(inbox_home) / default
    else:
        fallback = home / default
    return Path(os.path.abspath(configured or fallback))


def validate_previous_manifest(path):
    # A restored receipt is metadata, not current-DB integrity evidence: normal
    # application writes legitimately change its historical digests. Never edit it.
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        if path.is_symlink():
            raise ValueError('previous snapshot manifest is a symlink')
        return
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 65536:
            raise ValueError('previous snapshot manifest must be a bounded regular file')
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise ValueError('previous snapshot manifest exceeds byte limit')
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate previous snapshot manifest key')
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=unique_pairs)
    keys = {'format', 'complete', 'consistency', 'databases', 'snapshot_bytes'}
    if (not isinstance(value, dict) or set(value) != keys or type(value['format']) is not int
            or value['format'] != 1 or value['complete'] is not True
            or value['consistency'] != CONSISTENCY or not isinstance(value['databases'], list)
            or len(value['databases']) > len(CANONICAL)):
        raise ValueError('unrecognized previous snapshot manifest')
    total, seen = 0, set()
    for record in value['databases']:
        if not isinstance(record, dict) or set(record) != {'original_relative_path', 'bytes', 'sha256', 'complete'}:
            raise ValueError('invalid previous snapshot manifest database')
        relative = record['original_relative_path']
        if (not isinstance(relative, str) or not relative or Path(relative).is_absolute()
                or any(part in ('', '.', '..') for part in relative.split('/'))
                or relative == MANIFEST or relative in seen or '\x00' in relative):
            raise ValueError('invalid previous snapshot manifest relative path')
        seen.add(relative)
        size, digest = record['bytes'], record['sha256']
        if (type(size) is not int or size < 0 or size > 2**63 - 1 or record['complete'] is not True
                or not isinstance(digest, str) or len(digest) != 64
                or any(c not in '0123456789abcdef' for c in digest)):
            raise ValueError('invalid previous snapshot manifest completion/digest')
        total += size
    if type(value['snapshot_bytes']) is not int or value['snapshot_bytes'] != total:
        raise ValueError('invalid previous snapshot manifest byte total')



def fail_signal(signum, _frame):
    raise RuntimeError('snapshot interrupted or deadline exceeded: signal %d' % signum)


def positive(name, default):
    value = int(os.environ.get(name, default))
    if value <= 0:
        raise ValueError(name + ' must be positive')
    return value


def copy_snapshot(source, target, progress):
    """Pin a WAL read snapshot while copying, release it before verification.

    External writers otherwise cause the incremental backup to restart. WAL
    readers do not block commits, but pin checkpoint history: keep the existing
    global deadline and release the read transaction on every error path.
    Rollback-journal databases retain the original per-step locking behavior.
    """
    if source.in_transaction:
        raise ValueError('snapshot source already has a transaction')
    pinned = source.execute('PRAGMA journal_mode').fetchone()[0].lower() == 'wal'
    try:
        if pinned:
            source.execute('BEGIN')
            source.execute('SELECT rootpage FROM sqlite_schema LIMIT 1').fetchall()
        source.backup(target, pages=128, progress=progress, sleep=0.01)
    finally:
        if pinned and source.in_transaction:
            source.rollback()
    return pinned


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
    # Tar exclusions apply before name transformation: never share the live root.
    overlay_name = 'snapshot-overlay-1' if home.name == 'snapshot-overlay' else 'snapshot-overlay'
    (stage / 'source-home.nul').write_bytes(os.fsencode(home) + b'\0')
    overlay = stage / overlay_name
    (stage / 'overlay-name').write_text(overlay_name)
    pattern_base = ''.join('\\' + c if c in r'\\*?[]' else c for c in home.name)
    (stage / 'exclude-root-prefix').write_text(pattern_base)
    overlay.mkdir(mode=0o700)
    validate_previous_manifest(home / MANIFEST)
    budget = positive('ORKESTR_DEPLOY_SQLITE_MAX_BYTES', 8 * 1024**3)
    seconds = positive('ORKESTR_DEPLOY_SQLITE_TIMEOUT_SECONDS', 300)
    deadline = time.monotonic() + seconds
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM, signal.SIGXFSZ):
        signal.signal(sig, fail_signal)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    patterns = os.environ.get('ORKESTR_DEPLOY_BACKUP_EXCLUDES',
                              'run tmp whatsapp-bridge/sessions wa-skills/*/session wa-skills/*/state').split()
    exclusions, records = [MANIFEST], []
    total = 0
    seen = set()
    for default, variable in CANONICAL.items():
        started = time.monotonic()
        cpu_started = time.process_time()
        def report(phase, **fields):
            print(json.dumps({'kind': 'sqlite_snapshot', 'database': default, 'phase': phase,
                              'elapsed_seconds': round(time.monotonic() - started, 3),
                              'cpu_seconds': round(time.process_time() - cpu_started, 3), **fields}),
                  file=sys.stderr, flush=True)
        path = canonical_path(home, default, variable)
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
        last_report = [time.monotonic()]
        def progress(_status, _remaining, _pages):
            if time.monotonic() >= deadline:
                raise TimeoutError('SQLite snapshot deadline exceeded')
            if destination.stat().st_size > remaining:
                raise ValueError('SQLite snapshot byte budget exceeded')
            if time.monotonic() - last_report[0] >= 10:
                report('copy_progress', remaining_pages=_remaining, total_pages=_pages,
                       sqlite_status=_status, snapshot_bytes=destination.stat().st_size)
                last_report[0] = time.monotonic()
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=1)) as source:
            with closing(sqlite3.connect(destination)) as target:
                target.set_progress_handler(lambda: int(time.monotonic() >= deadline), 10000)
                report('copy_start', source_bytes=path.stat().st_size,
                       logical_pages=source.execute('PRAGMA page_count').fetchone()[0],
                       page_size=source.execute('PRAGMA page_size').fetchone()[0])
                pinned = copy_snapshot(source, target, progress)
                report('copy_complete', wal_read_snapshot=pinned, source_transaction_released=not source.in_transaction)
                report('integrity_start')
                if target.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise ValueError('snapshot integrity check failed')
                report('integrity_complete')
        size = destination.stat().st_size
        total += size
        if total > budget:
            raise ValueError('SQLite snapshot byte budget exceeded')
        digest = hashlib.sha256()
        report('hash_start', snapshot_bytes=size)
        with destination.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        digest = digest.hexdigest()
        report('complete', snapshot_bytes=size)
        records.append({'original_relative_path': relative, 'bytes': size, 'sha256': digest, 'complete': True})
    # The caller applies --anchored --no-wildcards only to these exclusions.
    (stage / 'excludes.nul').write_bytes(b''.join((home.name + '/' + p).encode() + b'\0' for p in exclusions))
    manifest = {'format': 1, 'complete': True, 'consistency': CONSISTENCY,
                'databases': records, 'snapshot_bytes': total}
    encoded = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    if len(encoded) > 65536:
        raise ValueError('generated snapshot manifest exceeds byte limit')
    (overlay / MANIFEST).write_bytes(encoded)
    signal.setitimer(signal.ITIMER_REAL, 0)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        prepare(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception as error:
        print('SQLite snapshot stage failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
