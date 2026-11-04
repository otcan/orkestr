"""Explicit optional Core authority / provider executor identity contract.

Legacy service descriptors retain their existing single UID. A split descriptor
must provide every field, keep the legacy uid/gid as executor aliases, and select
an external private provider home. Selecting fields is not launch qualification.
"""
import ctypes
import os
from pathlib import Path
from .contract import require

FIELDS = frozenset(('authority_uid', 'authority_gid', 'executor_uid', 'executor_gid', 'provider_home'))


def bind(value):
    selected = FIELDS.intersection(value)
    require(not selected or selected == FIELDS, 'incomplete_identity_split')
    for key in ('uid', 'gid', *(('authority_uid', 'authority_gid', 'executor_uid', 'executor_gid') if selected else ())):
        require(type(value.get(key)) is int and 0 < value[key] < 2**31, 'service_identity')
    if not selected:
        return dict(split=False, authority_uid=value['uid'], authority_gid=value['gid'],
                    executor_uid=value['uid'], executor_gid=value['gid'],
                    provider_home=str(Path(value['home']) / 'provider-home'))
    require(value['executor_uid'] == value['uid'] and value['executor_gid'] == value['gid'],
            'executor_alias_mismatch')
    require(value['authority_uid'] != value['executor_uid'], 'authority_executor_identity_overlap')
    # The selected package, seal and manager IPC currently share a root-owned
    # group-readable closure. Distinct IPC groups need an explicit ACL contract.
    require(value['authority_gid'] == value['executor_gid'], 'split_ipc_group_unsupported')
    require(type(value['provider_home']) is str, 'provider_home_required')
    provider = Path(value['provider_home'])
    authority = Path(value['home'])
    require(type(value['provider_home']) is str and provider.is_absolute()
            and '..' not in provider.parts and provider != authority
            and authority not in provider.parents and provider not in authority.parents,
            'provider_authority_path_overlap')
    return dict(split=True, **{key: value[key] for key in FIELDS})


def enforce_no_new_privs():
    """Inherited by native, code-mode and every descendant; no sudoers mutation."""
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(38, 1, 0, 0, 0) == 0 and libc.prctl(39, 0, 0, 0, 0) == 1,
            'executor_no_new_privs')


def provider_privileges(package):
    if getattr(package, 'identity_split', False):
        require(os.geteuid() == package.executor_uid, 'split_executor_uid')
        enforce_no_new_privs()


_CONTEXT = None

def launch_context():
    return _CONTEXT


def receive_launch_context(package, descriptor=6):
    """One-use root-manager capsule; JSON alone is never accepted authority."""
    global _CONTEXT
    from codex_bounded.trust import digest
    if _CONTEXT is not None:
        require(_CONTEXT['manifest_sha256']==digest(package.root/'manifest.json') and
                _CONTEXT['owner_id']==package.owner,'launch_capsule_package_changed')
        return _CONTEXT
    import json
    import socket
    import struct
    from codex_bounded.trust import process
    require(package.identity_split and os.geteuid() == package.executor_uid, 'split_executor_uid')
    enforce_no_new_privs()
    with socket.socket(fileno=descriptor) as channel:
        require(channel.family == socket.AF_UNIX and channel.type == socket.SOCK_STREAM,
                'launch_capsule_socket')
        pid, uid, _ = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        require(uid == 0 and pid == os.getppid(), 'launch_capsule_parent')
        channel.settimeout(1)
        raw = bytearray()
        while True:
            chunk = channel.recv(4097 - len(raw))
            if not chunk:
                break
            raw.extend(chunk)
            require(len(raw) <= 4096, 'launch_capsule_bound')
    value = json.loads(bytes(raw))
    require(type(value) is dict and set(value) == {'server_pid', 'server_start', 'server_uid',
            'manager_pid', 'manager_start', 'owner_id', 'conversation_id', 'manifest_sha256',
            'window_id', 'generation', 'role', 'request_id'}, 'launch_capsule_fields')
    require(value['manager_pid'] == pid and value['server_uid'] == package.authority_uid,
            'launch_capsule_identity')
    manager=process(pid)
    require(manager and manager['uid']==0 and manager['start']==value['manager_start'],
            'launch_capsule_manager_changed')
    require(value['manifest_sha256']==digest(package.root/'manifest.json') and value['owner_id']==package.owner,
            'launch_capsule_package_changed')
    from .contract import identifier, generation
    for key in ('owner_id','conversation_id','window_id'):identifier(value[key])
    generation(value['generation'])
    server = process(value['server_pid'])
    require(server and server['start'] == value['server_start'] and server['uid'] == value['server_uid'],
            'launch_capsule_server_changed')
    require(value['role'] in ('deep', 'fast', 'worker-0', 'worker-1', 'worker-2', 'worker-3'), 'launch_capsule_role')
    _CONTEXT = value
    return value
