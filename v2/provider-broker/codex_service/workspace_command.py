"""Worker-only command scope from actual Core consumption, never native JSON.

Manager authenticates its exact original Core PID before this parser. The
source must be an immutable sealed FD matching the consumed Core digest; no
model-selected executable, directory, environment or Root PID is admitted.
"""
import fcntl
import hashlib
import os
import re
import stat
from types import SimpleNamespace

from codex_bounded.trust import exists, metadata
from .contract import require, identifier, generation, key, Refused


def capability(value):
    require(type(value) is dict and set(value) == {'operation_id', 'project_id', 'project_generation',
        'run_id', 'session_id', 'binding_generation', 'lease_generation', 'dispatch_fence',
        'context_id', 'incarnation', 'source_sha256', 'expires_at_ms'}, 'workspace_command_capability_fields')
    for field in ('operation_id', 'project_id', 'run_id', 'session_id'): identifier(value[field])
    for field in ('project_generation', 'binding_generation', 'lease_generation', 'dispatch_fence'): generation(value[field])
    require(min(value[field] for field in ('project_generation', 'lease_generation', 'dispatch_fence')) > 0,
            'workspace_command_generation')
    key(value['context_id']); key(value['incarnation'])
    require(type(value['source_sha256']) is str and re.fullmatch('[0-9a-f]{64}', value['source_sha256']) and
            type(value['expires_at_ms']) is int and 0 < value['expires_at_ms'] < 2**53, 'workspace_command_digest_deadline')
    return value


def operation(source):
    require(type(source) is str and 0 < len(source.encode()) <= 65536 and '\0' not in source,
            'workspace_command_source_bound')
    if not source.startswith('#!orkestr-job '):
        require(len(source.encode()) <= 32768, 'workspace_command_bound')
        return SimpleNamespace(kind='command', command=source, target=None)
    if source.startswith('#!orkestr-job start\n'):
        command = source[len('#!orkestr-job start\n'):]
        require(0 < len(command.encode()) <= 32768, 'workspace_command_bound')
        return SimpleNamespace(kind='start', command=command, target=None)
    rest = source[len('#!orkestr-job '):]
    action, separator, target = rest.partition(' ')
    require(separator and action in ('status', 'wait', 'cancel'), 'workspace_job_operation')
    identifier(target)
    return SimpleNamespace(kind=action, command=None, target=target)


def sealed_source(descriptor, cap):
    info = os.fstat(descriptor)
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 0 and 0 < info.st_size <= 65536,
            'workspace_command_source_fd')
    try: seals = fcntl.fcntl(descriptor, fcntl.F_GET_SEALS)
    except OSError: raise Refused('workspace_command_source_not_sealed') from None
    require(seals & 15 == 15, 'workspace_command_source_not_sealed')
    raw = os.pread(descriptor, info.st_size + 1, 0)
    require(len(raw) == info.st_size and hashlib.sha256(raw).hexdigest() == cap['source_sha256'],
            'workspace_command_source_digest')
    try: source = raw.decode('utf-8', 'strict')
    except UnicodeError: raise Refused('workspace_command_source_encoding') from None
    return source, operation(source)


def parent(launcher, request):
    cap = capability(request['capability']); matches = []
    for handle in launcher.children.values():
        record = metadata(handle.path, 16384); setup = record['setup']
        if (handle.window == request['window_id'] and handle.generation == request['generation'] and
            record.get('state') == 'spawned' and record.get('mode') == 'fresh' and record.get('workspace_worker') is True and
            handle.child.poll() is None and
            exists(handle.broker) and setup['owner_id'] == request['owner_id'] and
            setup['conversation_id'] == request['conversation_id'] and setup['role'] == 'worker' and
            setup['provider'] == 'codex' and setup['session_id'] == cap['session_id'] and
            setup['incarnation'] == cap['incarnation'] and cap['binding_generation'] >= setup['generation']):
            matches.append(handle)
    require(len(matches) == 1, 'workspace_command_worker_lineage')
    return matches[0]
