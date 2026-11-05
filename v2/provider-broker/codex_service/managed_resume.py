"""One-use native bootstrap from the exact authority process attested by Root.

The selected metadata binding, provider and native identity are fenced by Core;
Root validates the original source-created descriptor before transfer. Neither
stdio JSON, an ambient bearer nor a caller-selected parent can substitute it.
"""
import select
import socket
import struct
import time
import uuid
from codex_bounded.trust import process
from .contract import require
from .identity import launch_context


def receive(config=None, descriptor=4):
    context = launch_context()
    require(type(context) is dict, 'managed_resume_context')
    setup = context['setup']
    expected = setup.get('native_session_id')
    require(setup['role'] in ('deep', 'fast') and type(expected) is str,
            'managed_resume_binding')
    provider = setup['provider']
    require(provider in ('codex', 'claude') and (provider == 'claude') == (config is not None),
            'managed_resume_provider')
    source = {key: context['server_' + key] for key in ('pid', 'uid', 'start')}
    require(process(source['pid']) is not None, 'managed_resume_source')
    prefix = (provider + '-resume-v1\0').encode()
    record = bytearray()
    deadline = time.monotonic() + 1
    with socket.socket(fileno=descriptor) as channel:
        require(channel.family == socket.AF_UNIX and channel.type == socket.SOCK_STREAM,
                'managed_resume_socket')
        pid, uid, _ = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        require((pid, uid) == (source['pid'], source['uid']), 'managed_resume_peer')
        channel.setblocking(False)
        while True:
            remaining = deadline - time.monotonic()
            require(remaining > 0 and select.select([channel], [], [], remaining)[0],
                    'managed_resume_deadline')
            chunk = channel.recv(len(prefix) + 513 - len(record))
            if not chunk:
                break
            record.extend(chunk)
            require(len(record) <= len(prefix) + 512, 'managed_resume_bound')
    current = process(source['pid'])
    require(current and all(current[key] == value for key, value in source.items()),
            'managed_resume_source_changed')
    require(bytes(record) == prefix + expected.encode(), 'managed_resume_identity')
    if provider == 'codex':
        return expected
    from claude_resume import ResumeSpec, _SEAL
    return ResumeSpec(_SEAL, config, uuid.UUID(expected))
