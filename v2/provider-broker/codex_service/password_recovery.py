"""Explicit stopped-service operator recovery. No HTTP reset or direct SQL."""
import argparse
import fcntl
import getpass
import json
import os
from pathlib import Path
import re
import select
import socket
import stat
import subprocess
import time

from codex_bounded.trust import protected
from .contract import require


def configuration(value):
    require(type(value) is dict and set(value) == {'unit', 'cgroup'}, 'operator_recovery_configuration')
    unit, cgroup = value['unit'], value['cgroup']
    require(type(unit) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,199}\.service', unit),
            'operator_recovery_unit')
    require(type(cgroup) is str and cgroup.startswith('/') and len(cgroup) <= 1024
            and not any(ord(c) < 32 for c in cgroup)
            and all(part not in ('', '.', '..') for part in cgroup.split('/')[1:])
            and cgroup.split('/')[-1] == unit, 'operator_recovery_cgroup')
    return dict(unit=unit, cgroup=cgroup)


def stopped(value, runner=subprocess.run, cgroup_root=Path('/sys/fs/cgroup')):
    selected = configuration(value)
    result = runner(['/usr/bin/systemctl', 'show', selected['unit'],
                     '--property=LoadState,ActiveState,MainPID,ControlGroup'],
                    env={'PATH':'/usr/bin:/bin', 'LANG':'C'}, capture_output=True,
                    text=True, timeout=5)
    require(result.returncode == 0, 'operator_recovery_unit_unknown')
    metadata = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    require(metadata.get('LoadState') == 'loaded' and 'ControlGroup' in metadata,
            'operator_recovery_unit_unknown')
    require(metadata.get('ActiveState') in ('inactive', 'failed') and metadata.get('MainPID') == '0'
            and metadata.get('ControlGroup', '') in ('', selected['cgroup']), 'operator_recovery_service_active')
    path = cgroup_root / selected['cgroup'].lstrip('/')
    if path.exists():
        require(path.resolve(strict=True) == path and path.is_dir(), 'operator_recovery_cgroup_alias')
        events = dict(line.split() for line in (path/'cgroup.events').read_text().splitlines())
        require(events.get('populated') == '0', 'operator_recovery_children_present')
    else:
        require(not path.is_symlink(), 'operator_recovery_cgroup_alias')


def manager_lock(directory):
    protected(directory, True)
    require(stat.S_IMODE(directory.stat().st_mode) == 0o700, 'operator_recovery_ledger_custody')
    path = protected(directory/'manager.lock')
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        named = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600
                and (info.st_dev,info.st_ino) == (named.st_dev,named.st_ino),
                'operator_recovery_lock_custody')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd, info
    except BaseException:
        os.close(fd)
        raise


def password(descriptor):
    if descriptor is None:
        value = getpass.getpass('New owner password: ')
        require(value == getpass.getpass('Confirm new owner password: '), 'operator_recovery_password_mismatch')
    else:
        require(descriptor == 0 or descriptor >= 3, 'operator_recovery_password_descriptor')
        info = os.fstat(descriptor)
        require(stat.S_ISFIFO(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_uid == 0
                and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600),
                'operator_recovery_password_descriptor')
        raw = bytearray(); deadline = time.monotonic()+5
        while len(raw) <= 1024:
            remaining = deadline-time.monotonic()
            require(remaining > 0 and select.select([descriptor],[],[],remaining)[0],
                    'operator_recovery_password_deadline')
            chunk = os.read(descriptor,1025-len(raw))
            if not chunk: break
            raw.extend(chunk)
        value = bytes(raw).decode('utf-8').removesuffix('\n')
    require(12 <= len(value.encode()) <= 1024 and not any(c in value for c in '\x00\r\n'),
            'operator_recovery_password_shape')
    return value


def recover(package, username, replacement, revoke_legacy=False, runner=subprocess.run,
            cgroup_root=Path('/sys/fs/cgroup')):
    require(os.geteuid() == 0 and package.runtime.get('password_rotation_ready') is True,
            'operator_recovery_requires_migrated_consumers')
    config = configuration(package.runtime.get('operator_recovery'))
    require(type(username) is str and 0 < len(username.encode()) <= 128,
            'operator_recovery_username')
    stopped(config,runner,cgroup_root)
    lock, info = manager_lock(package.ledger_directory)
    child = None
    try:
        stopped(config,runner,cgroup_root)
        data = {'owner_id':package.owner,'username':username,'password':replacement,
                'revoke_legacy':revoke_legacy,'lock_device':info.st_dev,'lock_inode':info.st_ino}
        raw = json.dumps(data).encode()
        require(len(raw) <= 4096, 'operator_recovery_request_bound')
        parent, channel = socket.socketpair()
        try:
            environment = {'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1',
                           'ORKESTR_V2_HOME':str(package.data),
                           'ORKESTR_V2_RECOVERY_LOCK_FD':str(lock)}
            child = subprocess.Popen([str(package.root/'server'),'--recover-owner-password'],
                cwd='/',env=environment,user=package.authority_uid,group=package.authority_gid,
                extra_groups=[],pass_fds=(lock,),stdin=channel,stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL)
            channel.close(); parent.settimeout(2)
            parent.sendall(raw); parent.shutdown(socket.SHUT_WR)
            output,_ = child.communicate(timeout=30)
            require(len(output) <= 4096, 'operator_recovery_receipt_bound')
            value = json.loads(output)
            require(type(value) is dict and value.get('status') in ('changed','refused'),
                    'operator_recovery_receipt_shape')
            require((child.returncode == 0) == (value['status'] == 'changed'),
                    'operator_recovery_receipt_outcome')
            if value['status'] == 'changed':
                require(value.get('browser_sessions_revoked') is True
                        and value.get('machine_credentials_preserved') is True,
                        'operator_recovery_receipt_shape')
            return value
        except Exception:
            raise RuntimeError('operator_recovery_outcome_unknown') from None
        finally:
            channel.close(); parent.close()
    finally:
        if child is not None and child.poll() is None:
            child.kill(); child.wait(timeout=3)
        os.close(lock)


def main(package, arguments):
    class Parser(argparse.ArgumentParser):
        def error(self, _message):
            # Never echo an accidentally supplied secret argument.
            raise RuntimeError('operator_recovery_arguments')
    parser = Parser(description=__doc__,allow_abbrev=False)
    parser.add_argument('--username',required=True)
    parser.add_argument('--password-fd',type=int)
    parser.add_argument('--revoke-legacy',action='store_true')
    try:
        args = parser.parse_args(arguments)
        require(os.geteuid() == 0 and package.runtime.get('password_rotation_ready') is True,
                'operator_recovery_requires_migrated_consumers')
        stopped(package.runtime.get('operator_recovery'))
        result = recover(package,args.username,password(args.password_fd),args.revoke_legacy)
        print(json.dumps(result,sort_keys=True))
        return 0 if result['status'] == 'changed' else 2
    except Exception as error:
        code=str(error)
        if not re.fullmatch('operator_recovery_[a-z_]+',code):code='operator_recovery_refused'
        print(json.dumps({'status':'refused','code':code},sort_keys=True))
        return 2
