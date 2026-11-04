#!/usr/bin/env python3
"""Offline Core authority relocation: preflight by default; staging is not cutover.

Never changes the service unit or starts/stops a process. A separately reviewed
identity-split package and protected qualification receipt are prerequisites.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import tempfile


class Refused(ValueError):
    pass


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def protected(path):
    for part in (Path(path), *Path(path).parents):
        info = part.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise Refused('qualification_custody')


def atomic(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix='.custody-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def schema(path):
    uri = Path(path).resolve(strict=True).as_uri() + '?mode=ro'
    with sqlite3.connect(uri, uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise Refused('sqlite_integrity')
        return hashlib.sha256(json.dumps(db.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()).encode()).hexdigest()


def open_pids(paths, proc='/proc'):
    targets = {str(Path(p).resolve()) for p in paths}
    found = set()
    for pid in Path(proc).glob('[0-9]*'):
        try:
            for fd in (pid / 'fd').iterdir():
                try:
                    if os.readlink(fd).removesuffix(' (deleted)') in targets:
                        found.add(int(pid.name))
                except FileNotFoundError:
                    continue
        except FileNotFoundError:
            continue
        except PermissionError:
            raise Refused('open_descriptor_inventory_incomplete') from None
    return sorted(found)


def stopped(unit):
    result = subprocess.run(['systemctl', 'show', unit, '-p', 'ActiveState', '--value'],
                            capture_output=True, text=True, timeout=5)
    return result.returncode == 0 and result.stdout.strip() in ('inactive', 'failed')


def qualifying(config, qualification):
    if qualification.get('format') != 'core-identity-qualification-v1':
        raise Refused('identity_split_not_qualified')
    for key in ('source_core', 'target_root', 'service_uid', 'service_gid', 'agent_uid', 'unit'):
        if qualification.get(key) != config.get(key):
            raise Refused('qualification_scope_mismatch')
    required = ('separate_server_executor_identity', 'agent_core_read_denied', 'agent_core_write_denied',
                'provider_broker_smoke', 'startup_closure_verified', 'direct_consumers_reconciled',
                'authenticated_provenance_verified')
    if any(qualification.get(key) is not True for key in required):
        raise Refused('qualification_probe_missing')
    # Bind the protected attestation to the exact reviewed candidate descriptor.
    candidate = config.get('candidate_descriptor')
    if not candidate or sha(candidate) != qualification.get('candidate_sha256'):
        raise Refused('candidate_changed')


def validate(config):
    for key in ('source_core', 'target_root'):
        path = Path(config[key])
        if not path.is_absolute() or str(path) != str(path.resolve()):
            raise Refused('path_not_canonical')
    uid, gid, agent = (config.get(k) for k in ('service_uid', 'service_gid', 'agent_uid'))
    if any(type(v) is not int or v <= 0 for v in (uid, gid, agent)) or uid == agent:
        raise Refused('separate_service_identity_missing')
    source = Path(config['source_core'])
    root = Path(config['target_root'])
    if root == source.parent or root in source.parents or source.parent in root.parents:
        raise Refused('authority_path_not_separate')
    if root.exists():
        raise Refused('target_already_exists')
    # Ancestors must not let the agent replace the authority directory.
    parent = root.parent
    for item in (parent, *parent.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid not in (0, uid) or info.st_mode & 0o022:
            raise Refused('target_ancestor_writable')


def preflight(config, qualification=None, stop_check=stopped, descriptors=open_pids):
    blockers = []
    try:
        validate(config)
    except (KeyError, OSError, Refused) as error:
        blockers.append(str(error) if isinstance(error, Refused) else 'configuration_incomplete')
    if qualification is None:
        blockers.append('identity_split_not_qualified')
    else:
        try:
            qualifying(config, qualification)
        except (KeyError, OSError, Refused) as error:
            blockers.append(str(error) if isinstance(error, Refused) else 'candidate_unavailable')
    try:
        if not stop_check(config['unit']):
            blockers.append('service_not_stopped')
        core = config['source_core']
        if descriptors([core, core + '-wal', core + '-shm']):
            blockers.append('core_open_descriptors')
    except (KeyError, OSError, subprocess.SubprocessError, Refused):
        blockers.append('quiescence_not_proven')
    return {'ready_to_stage': not blockers, 'blockers': blockers,
            'changes_applied': False, 'service_cutover_performed': False}


def stage(config, qualification, receipt, stop_check=stopped, descriptors=open_pids):
    check = preflight(config, qualification, stop_check, descriptors)
    if not check['ready_to_stage']:
        raise Refused(','.join(check['blockers']))
    root = Path(config['target_root'])
    root.mkdir(mode=0o700)  # fail if another actor created the path after preflight
    target = root / 'core.sqlite3'
    # Journal first: a partial copy is not silently mistaken for a completed stage.
    state = {'format': 'core-custody-stage-v1', 'target_root': str(root), 'target_core': str(target),
             'source_core': config['source_core'], 'unit': config['unit'], 'state': 'staging',
             'source_unchanged': True, 'service_cutover_performed': False}
    atomic(receipt, state)
    original_schema = schema(config['source_core'])
    with sqlite3.connect(Path(config['source_core']).as_uri() + '?mode=ro', uri=True) as source:
        source.execute('PRAGMA query_only=ON')
        with sqlite3.connect(target) as destination:
            source.backup(destination)
    if schema(target) != original_schema:
        raise Refused('schema_changed')
    os.chmod(target, 0o600)
    os.chown(target, config['service_uid'], config['service_gid'])
    os.chown(root, config['service_uid'], config['service_gid'])
    state.update(state='staged', target_sha256=sha(target), schema_sha256=original_schema,
                 service_uid=config['service_uid'], service_gid=config['service_gid'])
    atomic(receipt, state)
    return state


def rollback(receipt, stop_check=stopped, descriptors=open_pids):
    value = json.loads(Path(receipt).read_text())
    if value.get('format') != 'core-custody-stage-v1' or value.get('state') != 'staged':
        raise Refused('stage_not_complete_operator_reconciliation_required')
    target = Path(value['target_core'])
    root = Path(value['target_root'])
    if target != root / 'core.sqlite3' or target.is_symlink() or root.is_symlink():
        raise Refused('stage_identity_changed')
    if not stop_check(value['unit']) or descriptors([str(target), str(target) + '-wal', str(target) + '-shm']):
        raise Refused('rollback_not_quiescent')
    if sorted(p.name for p in root.iterdir()) != ['core.sqlite3'] or sha(target) != value['target_sha256']:
        raise Refused('staged_data_changed_do_not_erase')
    target.unlink()
    root.rmdir()
    value['state'] = 'rolled_back'
    atomic(receipt, value)
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--qualification')
    parser.add_argument('--receipt')
    parser.add_argument('--mode', choices=('preflight', 'stage', 'rollback'), default='preflight')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    qualification = None
    if args.qualification:
        protected(args.qualification)
        qualification = json.loads(Path(args.qualification).read_text())
    if not args.apply or args.mode == 'preflight':
        print(json.dumps(preflight(config, qualification), indent=2))
        return
    if os.geteuid() != 0 or not args.receipt:
        raise Refused('root_and_receipt_required')
    protected(args.config)
    protected(Path(args.receipt).parent)
    if args.mode == 'stage':
        if Path(args.receipt).exists():
            raise Refused('receipt_already_exists')
        result = stage(config, qualification, args.receipt)
    else:
        protected(args.receipt)
        result = rollback(args.receipt)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
