"""Closed HTTP beta configuration grammar pinned to Runtime 1b2dc432b.

Shape validation grants no workspace, launcher, manager-peer or provider authority.
"""
import json
from pathlib import Path
import re
import uuid

from closure import require

FIELDS = {'schema_version', 'owner_id', 'conversation_id', 'manager_socket',
          'launcher', 'launcher_sha256', 'workspace', 'namespace', 'supervisor_key'}


TRUSTED_FLAGS = {'network', 'host_toolchain'}
TRUSTED_PATHS = {'workspace_target', 'home'}
TRUSTED_PATH_LISTS = {'path', 'toolchain_mounts', 'cache_mounts', 'credential_mounts',
                      'credential_env_files', 'skill_mounts'}
TRUSTED_NUMBERS = {'command_timeout_ms', 'command_output_bytes', 'job_timeout_ms',
                   'job_output_bytes', 'max_jobs', 'worker_run_ms', 'memory_bytes', 'pids',
                   'cpus', 'tmp_bytes', 'home_bytes', 'file_bytes', 'open_files'}


def absolute(path):
    return (type(path) is str and 0 < len(path.encode()) <= 4096 and '\x00' not in path and
            Path(path).is_absolute() and Path(path) != Path('/') and '..' not in Path(path).parts)


def trusted(value):
    """Shape only. Runtime owns overlap, ceiling and credential-default checks."""
    fields = TRUSTED_FLAGS | TRUSTED_PATHS | TRUSTED_PATH_LISTS | TRUSTED_NUMBERS | {'environment'}
    require(type(value) is dict and set(value) <= fields, 'closed trusted command profile required')
    for key in TRUSTED_FLAGS & set(value):
        require(type(value[key]) is bool, 'trusted profile flag required')
    for key in TRUSTED_PATHS & set(value):
        require(absolute(value[key]), 'trusted profile path required')
    for key in TRUSTED_PATH_LISTS & set(value):
        require(type(value[key]) is list and len(value[key]) <= 64 and
                all(absolute(path) for path in value[key]), 'trusted profile path list required')
    for key in TRUSTED_NUMBERS & set(value):
        require(type(value[key]) is int and value[key] > 0, 'trusted profile number required')
    environment = value.get('environment', {})
    require(type(environment) is dict and len(environment) <= 64 and all(
        type(k) is str and re.fullmatch(r'[A-Z_][A-Z0-9_]{0,127}', k) and type(v) is str
        and '\x00' not in v for k, v in environment.items()), 'trusted profile environment required')
    return value


def workspace_exec(value):
    fields = {'conversation_id', 'project_id', 'workspace', 'allowed_roots',
              'protected_roots', 'cgroup_root', 'toolchain_root'}
    require(type(value) is dict and set(value) - {'trusted'} == fields,
            'closed workspace execution profile required')
    if 'trusted' in value:
        trusted(value['trusted'])
    for key in ('conversation_id', 'project_id'):
        try:
            require(type(value[key]) is str and uuid.UUID(value[key]).int != 0,
                    'workspace execution UUID required')
        except ValueError:
            raise RuntimeError('workspace execution UUID required') from None
    require(value['allowed_roots'] == [value['workspace']], 'one exact workspace root required')
    protected = value['protected_roots']
    require(type(protected) is list and 1 <= len(protected) <= 55, 'bounded protected roots required')
    paths = [value[k] for k in ('workspace', 'cgroup_root', 'toolchain_root')]
    for path in [*paths, *protected]:
        require(type(path) is str and 0 < len(path.encode()) <= 4096 and '\x00' not in path and
                Path(path).is_absolute() and Path(path) != Path('/') and '..' not in Path(path).parts,
                'absolute bounded workspace profile path required')
    for index, path in enumerate(map(Path, paths)):
        for other in map(Path, paths[index + 1:]):
            require(path != other and path not in other.parents and other not in path.parents,
                    'workspace command roots must be separate')
    return value


def unique(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, 'duplicate beta config field')
        value[key] = item
    return value


def validate(raw):
    require(type(raw) is bytes and len(raw) <= 16384, 'bounded beta config required')
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique,
                       parse_constant=lambda _: (_ for _ in ()).throw(RuntimeError('invalid beta number')))
    require(type(value) is dict and set(value) - {'roles', 'workspace_exec'} == FIELDS, 'closed beta config fields required')
    require(type(value['schema_version']) is int and value['schema_version'] == 1, 'beta schema version')
    for name in ('owner_id', 'conversation_id'):
        text = value[name]
        require(type(text) is str, 'beta UUID required')
        try:
            identifier = uuid.UUID(text)
        except ValueError:
            raise RuntimeError('beta UUID required') from None
        require(identifier.int != 0, 'nonnil beta UUID required')
    for name in ('manager_socket', 'launcher', 'workspace'):
        text = value[name]
        require(type(text) is str and '\x00' not in text and Path(text).is_absolute(), 'absolute beta path required')
    for name in ('namespace', 'supervisor_key'):
        require(type(value[name]) is str and re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', value[name]), 'bounded beta identifier required')
    require(type(value['launcher_sha256']) is str and re.fullmatch('[0-9a-f]{64}', value['launcher_sha256']), 'beta launcher digest required')
    if 'roles' in value:
        roles=value['roles']
        require(type(roles) is dict and set(roles)=={'fast','workers'},'closed beta roles required')
        require(type(roles['workers']) is list and len(roles['workers'])==4,'four beta worker slots required')
        launchers=set()
        for role in [roles['fast'],*roles['workers']]:
            require(type(role) is dict and set(role)=={'launcher','launcher_sha256','workspace'},
                    'closed beta role fields required')
            for key in ('launcher','workspace'):
                require(type(role[key]) is str and '\x00' not in role[key] and Path(role[key]).is_absolute(),
                        'absolute beta role path required')
            require(type(role['launcher_sha256']) is str and re.fullmatch('[0-9a-f]{64}',role['launcher_sha256']),
                    'beta role launcher digest required')
            launchers.add(role['launcher'])
        require(len(launchers)==5 and value['launcher'] not in launchers,'distinct beta role launchers required')
    if 'workspace_exec' in value:
        require('roles' in value, 'workspace execution requires configured Worker roles')
        workspace_exec(value['workspace_exec'])
    return value
