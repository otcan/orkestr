"""Closed managed command environment; Root-selected business keys only.

This never sources a shell file. Values are returned for the dropped child's
environment, never argv, logs, provider setup or a Core credential cache.
"""
import os
from pathlib import Path
import re
import stat

from .contract import require


def key(value):
    return type(value) is str and re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,127}', value) is not None and \
        not value.startswith(('LD_', 'PYTHON', 'ORKESTR_', 'CODEX_', 'CLAUDE_')) and value not in \
        ('BASH_ENV', 'ENV', 'IFS', 'SHELLOPTS', 'BASHOPTS')


def definition(value):
    require(type(value) is dict and {'environment'} <= set(value) <= {'environment', 'credentials'},
            'managed_workspace_environment_fields')
    environment = value['environment']
    require(type(environment) is dict and {'HOME', 'PATH'} <= set(environment) and len(environment) <= 128 and
            all(key(k) and type(v) is str and '\0' not in v and len(v) <= 16384
                for k, v in environment.items()) and environment['HOME'].startswith('/') and
            environment['HOME'] != '/' and all(p not in ('', '.', '..') for p in environment['HOME'].split('/')[1:])
            and 'PWD' not in environment, 'managed_workspace_environment')
    files = value.get('credentials', [])
    require(type(files) is list and len(files) <= 8, 'managed_workspace_credentials')
    names = set(environment)
    paths = set()
    for selected in files:
        require(type(selected) is dict and set(selected) == {'path', 'keys'}, 'managed_workspace_credential_fields')
        path, keys = selected['path'], selected['keys']
        require(type(path) is str and path.startswith('/') and 1 < len(path) <= 4096 and '\0' not in path and
                all(p not in ('', '.', '..') for p in path.split('/')[1:]) and path not in paths,
                'managed_workspace_credential_path')
        require(type(keys) is list and 0 < len(keys) <= 64 and all(key(k) and k not in ('HOME', 'PATH', 'PWD')
                and k not in names for k in keys) and len(set(keys)) == len(keys), 'managed_workspace_credential_keys')
        names.update(keys); paths.add(path)
    require(len(names) <= 256, 'managed_workspace_environment_bound')
    return value


def root_file(path):
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        parts = Path(path).parts[1:]
        for index, part in enumerate(parts):
            directory = index + 1 < len(parts)
            child = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK |
                            (os.O_DIRECTORY if directory else 0), dir_fd=descriptor)
            os.close(descriptor); descriptor = child
            meta = os.fstat(descriptor)
            require(meta.st_uid == 0 and meta.st_mode & 0o022 == 0 and
                    (stat.S_ISDIR(meta.st_mode) if directory else stat.S_ISREG(meta.st_mode) and
                     meta.st_nlink == 1 and stat.S_IMODE(meta.st_mode) == 0o600 and meta.st_size <= 65536),
                    'managed_workspace_credential_custody')
        raw = os.read(descriptor, 65537)
        require(len(raw) <= 65536, 'managed_workspace_credential_bound')
        return raw.decode('utf-8', 'strict')
    finally: os.close(descriptor)


def read_selected(text, keys):
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'): continue
        if line.startswith('export '): line = line[7:]
        name, separator, value = line.partition('='); name = name.strip(); value = value.strip()
        require(separator and re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,127}', name) and '\0' not in value,
                'managed_workspace_credential_syntax')
        if value.startswith(('"', "'")):
            require(len(value) >= 2 and value[-1] == value[0], 'managed_workspace_credential_syntax')
            value = value[1:-1]
        require(len(value) <= 16384, 'managed_workspace_credential_value_bound')
        if name in keys:
            require(name not in values, 'managed_workspace_duplicate_credential')
            values[name] = value
    require(set(values) == set(keys), 'managed_workspace_missing_credential')
    return values


def environment(value, protected, workspace):
    require(os.geteuid() == 0, 'managed_workspace_root_credentials')
    definition(value)
    result = dict(value['environment'])
    result['PWD'] = str(workspace)
    for selected in value.get('credentials', []):
        path = Path(selected['path'])
        require(all(path != other and path not in other.parents and other not in path.parents
                    for other in protected), 'managed_workspace_credential_scope')
        result.update(read_selected(root_file(path), selected['keys']))
    return result
