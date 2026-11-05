"""Explicit executor host access under the split UID/NNP launch contract.

The protected operator map selects cwd by Root-attested conversation. Core
never opens executor-private project trees or receives host credentials.
"""
import os
from pathlib import Path
import re
import stat
import struct
from .contract import require


def access(beta):
    return beta.get('managed_host', beta.get('host_full_access'))


def validate(package):
    value = package.beta.get('managed_host')
    if value is None:
        return
    require(package.identity_split and 'host_full_access' not in package.beta,
            'managed_host_identity')
    require(type(value) is dict and set(value) <= {'providers', 'environment', 'environment_files'}
            and type(value.get('providers', True)) is bool and type(value.get('environment')) is dict,
            'managed_host_fields')
    environment = value['environment']
    require({'HOME', 'PATH'} <= set(environment) and len(environment) <= 256
            and all(type(k) is str and re.fullmatch('[A-Za-z_][A-Za-z0-9_]*', k)
                    and type(v) is str and '\0' not in v and len(v) <= 16384
                    for k, v in environment.items()) and environment['HOME'].startswith('/'),
            'managed_host_environment')
    files = value.get('environment_files', [])
    require(type(files) is list and len(files) <= 8 and all(type(f) is str and f.startswith('/')
            and '\0' not in f and '..' not in Path(f).parts for f in files), 'managed_host_environment_files')
    if os.geteuid() == 0:
        for entry in package.beta.get('conversation_workspaces', {}).values():
            workspace_custody(package, entry)


def workspace_custody(package, entry):
    shared = type(entry) is dict
    require(not shared or set(entry) == {'path', 'shared'} and entry['shared'] is True,
            'managed_workspace_shape')
    raw = entry['path'] if shared else entry
    require(type(raw) is str and raw.startswith('/') and raw != '/' and '\0' not in raw
            and all(p not in ('', '.', '..') for p in raw.split('/')[1:]), 'managed_workspace_path')
    path = Path(raw)
    require(path.resolve(strict=True) == path and path != package.home
            and package.home not in path.parents and path not in package.home.parents,
            'managed_workspace_scope')
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        require(stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o002, 'managed_workspace_custody')
        if info.st_uid != package.executor_uid:
            require(shared, 'managed_workspace_owner')
            acl = os.getxattr(fd, 'system.posix_acl_access')
            require(len(acl) >= 4 and acl[:4] == struct.pack('<I', 2) and (len(acl)-4) % 8 == 0,
                    'managed_workspace_acl')
            entries = list(struct.iter_unpack('<HHI', acl[4:]))
            named = [perm for tag, perm, uid in entries if tag == 2 and uid == package.executor_uid]
            mask = [perm for tag, perm, _ in entries if tag == 16]
            require(named == [7] and mask == [7], 'managed_workspace_acl')
        after = path.stat(follow_symlinks=False)
        require((info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_uid, after.st_mode, after.st_ctime_ns),
                'managed_workspace_changed')
    finally:
        os.close(fd)
    return raw


def selected_workspace(package, fallback, role):
    if not getattr(package, 'identity_split', False) or role.startswith('worker-'):
        return fallback
    from .identity import launch_context
    context = launch_context()
    require(type(context) is dict and context['owner_id'] == package.owner,
            'managed_workspace_launch')
    entry = package.beta.get('conversation_workspaces', {}).get(context['conversation_id'])
    return fallback if entry is None else workspace_custody(package, entry)
