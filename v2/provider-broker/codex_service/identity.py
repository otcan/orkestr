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
