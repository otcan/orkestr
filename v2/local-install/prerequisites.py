#!/usr/bin/env python3
"""Explicit Linux execution dependency probe; no installation or root fallback."""
import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import subprocess

BWRAP = Path('/usr/bin/bwrap')
MARKER = 'orkestr-install-namespace-ready'


class PrerequisiteError(RuntimeError):
    def __init__(self, code, detail):
        self.code = code
        super().__init__(f'{code}: {detail}')


def refuse(condition, code, detail):
    if not condition:
        raise PrerequisiteError(code, detail)


def trusted_binary():
    refuse(platform.system() == 'Linux' and platform.machine() == 'x86_64',
           'unsupported_target', 'execution prerequisites support Linux x86_64 only')
    for path in (Path('/'), Path('/usr'), Path('/usr/bin'), BWRAP):
        try:
            info = path.lstat()
        except OSError as error:
            raise PrerequisiteError('missing_dependency', f'{path}: {error}') from error
        refuse(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
               'untrusted_dependency', f'{path} must be root-owned, nonsymlink and not group/world writable')
    refuse(stat.S_ISREG(info.st_mode) and info.st_mode & 0o111 and not info.st_mode & 0o6000,
           'untrusted_dependency', 'bwrap must be a regular executable without setuid/setgid privileges')
    try:
        data = BWRAP.read_bytes()
    except OSError as error:
        raise PrerequisiteError('unreadable_dependency', str(error)) from error
    refuse(data[:6] == b'\x7fELF\x02\x01' and data[18:20] == b'\x3e\x00',
           'architecture_mismatch', 'bwrap must be native Linux x86_64 ELF')
    return {'path': str(BWRAP), 'sha256': hashlib.sha256(data).hexdigest(),
            'size': len(data), 'uid': info.st_uid, 'mode': stat.S_IMODE(info.st_mode)}


def check():
    binary = trusted_binary()
    command = [str(BWRAP), '--unshare-user', '--unshare-pid', '--die-with-parent',
               '--ro-bind', '/', '/', '--proc', '/proc', '--', '/usr/bin/printf', MARKER]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=10,
                                env={'PATH': '/usr/bin:/bin', 'LANG': 'C'}, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PrerequisiteError('namespace_probe_failed', str(error)) from error
    refuse(result.returncode == 0 and result.stdout == MARKER,
           'namespace_unavailable', f'exit={result.returncode}; stderr={result.stderr[:4096]!r}; stdout={result.stdout[:1024]!r}')
    refuse(trusted_binary() == binary, 'dependency_changed', 'bwrap changed during namespace probe')
    return {'format': 'orkestr-v2-execution-dependencies-v1', 'target': 'linux-x86_64',
            'bwrap': binary, 'user_namespace': True, 'pid_namespace': True,
            'die_with_parent_option': True,
            'scope': 'startup capability only; reaping, broker and executor qualification separate'}


if __name__ == '__main__':
    try:
        print(json.dumps(check(), sort_keys=True, indent=2))
    except PrerequisiteError as error:
        print(json.dumps({'ready': False, 'code': error.code, 'detail': str(error)}))
        raise SystemExit(1)
