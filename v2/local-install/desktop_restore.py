#!/usr/bin/env python3
"""Offline revoke-all preparation; never opens a live store or adopts a lock.

Operator must establish quiescence independently. Linux fresh-directory rename
is the only publication operation. Publication uncertainty is never rolled back.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import tempfile
from datetime import datetime, timezone

MAX_BYTES = 8 * 1024 * 1024


class RecoveryError(RuntimeError):
    pass


class PublicationUnknown(RecoveryError):
    pass


def private_parent(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise RecoveryError('absolute canonical path required')
    for part in [path, *path.parents]:
        if stat.S_ISLNK(part.lstat().st_mode):
            raise RecoveryError('symlink parent refused')
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RecoveryError('caller-owned private parent required')
    return path


def read_original(source):
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_BYTES:
            raise RecoveryError('bounded regular single-link source required')
        raw = b''
        while len(raw) <= MAX_BYTES:
            chunk = os.read(fd, min(65536, MAX_BYTES + 1 - len(raw)))
            if not chunk:
                break
            raw += chunk
        after = os.fstat(fd)
        fields = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if len(raw) > MAX_BYTES or fields(before) != fields(after) or len(raw) != after.st_size:
            raise RecoveryError('source changed or exceeded bound')
        return raw
    finally:
        os.close(fd)


def validate(state, identity):
    if not isinstance(state, dict) or state.get('lockIdentity') != identity:
        raise RecoveryError('old lock identity mismatch')
    counter = state.get('fencingCounter')
    if type(counter) is not int or not 0 <= counter <= 2**53 - 1 or not isinstance(state.get('desktopLeases'), list):
        raise RecoveryError('invalid state')
    ids, versions, active = set(), set(), set()
    text = lambda x: isinstance(x, str) and bool(x) and x.strip() == x
    canonical = lambda x: text(x) and re.fullmatch(r'[a-z0-9_.-]+', x)
    for lease in state['desktopLeases']:
        if not isinstance(lease, dict):
            raise RecoveryError('invalid lease')
        version = lease.get('fencingVersion')
        if (not all(text(lease.get(k)) for k in ('id', 'threadId', 'fencingToken', 'acquiredAt', 'heartbeatAt'))
                or not all(canonical(lease.get(k)) for k in ('ownerUserId', 'desktopSlug'))
                or lease.get('mode') not in ('exclusive', 'viewOnly', 'sharedRead')
                or type(version) is not int or not 1 <= version <= counter
                or any(k not in lease for k in ('expiresAt', 'releasedAt'))
                or any(lease.get(k) is not None and not text(lease.get(k)) for k in ('expiresAt', 'releasedAt'))):
            raise RecoveryError('invalid lease')
        key = (lease['ownerUserId'], lease['desktopSlug'])
        if lease['id'] in ids or version in versions or (not lease.get('releasedAt') and key in active):
            raise RecoveryError('duplicate lease authority')
        ids.add(lease['id'])
        versions.add(version)
        if not lease.get('releasedAt'):
            active.add(key)


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise RecoveryError('duplicate JSON key')
        result[key] = value
    return result


def rename_fresh(source, target):
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    if rename is None:
        raise RecoveryError('Linux renameat2 required')
    if rename(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def prepare(source, target, digest, old_identity, *, offline_confirmed=False, hook=lambda phase: None):
    if not offline_confirmed:
        raise RecoveryError('explicit offline source confirmation required; age is not quiescence')
    if not re.fullmatch(r'[0-9a-f]{64}', digest) or not re.fullmatch(r'[0-9]+:[0-9]+', old_identity):
        raise RecoveryError('explicit SHA256 and old dev:ino required')
    source, target = Path(source), Path(target)
    private_parent(source.parent)
    private_parent(target.parent)
    if source.name in ('', '.', '..') or target.name in ('', '.', '..') or os.path.lexists(target):
        raise RecoveryError('fresh target required')
    raw = read_original(source)
    if hashlib.sha256(raw).hexdigest() != digest:
        raise RecoveryError('source digest mismatch')
    state = json.loads(raw, object_pairs_hook=no_duplicates,
                       parse_constant=lambda value: (_ for _ in ()).throw(RecoveryError('nonfinite JSON')))
    validate(state, old_identity)
    if state['fencingCounter'] == 2**53 - 1:
        raise RecoveryError('generation exhausted; newer acquisition impossible')
    stamp = datetime.now(timezone.utc).isoformat()
    count = 0
    for lease in state['desktopLeases']:
        if not lease.get('releasedAt'):
            lease.update(releasedAt=stamp, updatedAt=stamp, releaseReason='offline-restore-revoked')
            count += 1
    del state['lockIdentity']
    output = (json.dumps(state, ensure_ascii=True, indent=2) + '\n').encode()
    if len(output) > MAX_BYTES:
        raise RecoveryError('revoked output exceeds bound')
    receipt = dict(format='desktop-offline-revocation-v1', source_sha256=digest,
                   old_lock_identity=old_identity, output_sha256=hashlib.sha256(output).hexdigest(),
                   revoked=count, fencing_counter=state['fencingCounter'],
                   authority='all-active-revoked; explicit-new-acquire-required')
    stage = Path(tempfile.mkdtemp(prefix='.desktop-recovery-', dir=target.parent))
    publishing = False
    try:
        for name, data in [('original.json', raw), ('leases.json', output),
                           ('receipt.json', (json.dumps(receipt, indent=2) + '\n').encode())]:
            with open(stage / name, 'xb') as file:
                os.chmod(stage / name, 0o600)
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
        fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        hook('prepared')
        publishing = True
        rename_fresh(stage, target)
        hook('published')
        fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        publishing = False
        return receipt
    except BaseException as error:
        if publishing:
            raise PublicationUnknown('publication uncertain: retain target/staging evidence; do not retry or activate') from error
        raise
    finally:
        if not publishing and stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--source-sha256', required=True)
    parser.add_argument('--old-lock-identity', required=True)
    parser.add_argument('--offline-source-confirmed', action='store_true')
    args = parser.parse_args()
    def interrupt(signum, frame):
        raise KeyboardInterrupt(f'interrupted by signal {signum}')
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupt)
    prepare(args.source, args.target, args.source_sha256, args.old_lock_identity,
            offline_confirmed=args.offline_source_confirmed)


if __name__ == '__main__':
    main()
