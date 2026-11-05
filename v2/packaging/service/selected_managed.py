"""Shape and authoritative custody checks for explicitly managed projects."""
from pathlib import Path
import os

from closure import require


def profiles(value):
    return ([value['workspace_exec']] if 'workspace_exec' in value else []) + value.get('additional_workspace_exec', [])


def shape(value):
    require(type(value) is dict and {'environment'} <= set(value) <= {'environment', 'credentials'},
            'closed managed executor required')
    require(type(value['environment']) is dict and {'HOME', 'PATH'} <= set(value['environment'])
            and len(value['environment']) <= 128 and all(type(k) is str and type(v) is str
            and '\0' not in k + v for k, v in value['environment'].items()), 'managed executor environment required')
    files = value.get('credentials', [])
    require(type(files) is list and len(files) <= 8, 'managed executor credentials required')
    for item in files:
        require(type(item) is dict and set(item) == {'path', 'keys'} and type(item['path']) is str
                and type(item['keys']) is list and 0 < len(item['keys']) <= 64
                and all(type(k) is str for k in item['keys']), 'managed executor credential selection required')


def modes(value, split):
    if split:
        require('host_full_access' not in value, 'split legacy privileged mode refused')
    for profile in profiles(value):
        trusted = profile.get('trusted', {})
        managed = trusted.get('managed_executor')
        if split:
            require(type(managed) is dict and trusted.get('host_privileged', False) is False
                    and trusted.get('environment', {}) == {} and trusted.get('credential_env_files', []) == [],
                    'split workspace requires explicit managed executor')
        else:
            require(managed is None and 'project_owner_uid' not in profile,
                    'managed workspace requires split identity')


def project(profile, trust, identity):
    if not identity['split']:
        return trust.private(profile['workspace'], identity['executor_uid'], True)
    from codex_service.workspace_environment import definition
    from codex_service.workspace_custody import association, open_checked
    from codex_service.workspace_acl import owner
    definition(profile['trusted']['managed_executor'])
    project_owner = owner(profile, identity['executor_uid'])
    require(project_owner != identity['authority_uid'], 'project authority owner refused')
    path = Path(profile['workspace'])
    git, common = association(path, project_owner, identity['executor_uid'], identity['executor_gid'])
    for selected in (path, git, common):
        fd = open_checked(selected, project_owner, executor=identity['executor_uid'],
                          executor_gid=identity['executor_gid'])
        os.close(fd)
    return path


def validate_package(package):
    if not getattr(package, 'identity_split', False):
        return
    from codex_service.workspace_custody import Installation
    for profile in profiles(package.beta):
        installation = Installation(package, profile)
        installation.close()
