"""Private local parent bootstrap, not a Core issuer or client protocol.

Runtime owns the non-Clone retired/reaped resume ticket and the issued accepted
metadata grant. It sends only the selected native identity over a new inherited
socketpair; the record is NOT serialized authority and is never accepted on stdio.
"""
import os
import select
import socket
import struct
import time
import uuid
from claude_resume import ResumeSpec, _SEAL
from protocol import require

PREFIX = b"claude-resume-v1\0"


def receive(config, descriptor=4):
    """Consume one private stream record and EOF within a bounded startup window."""
    with socket.socket(fileno=descriptor) as channel:
        require(channel.family == socket.AF_UNIX and channel.type == socket.SOCK_STREAM)
        pid, uid, _gid = struct.unpack("3i",channel.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        require(pid == os.getppid() and uid == os.geteuid())
        channel.setblocking(False)
        record = bytearray()
        deadline = time.monotonic()+1
        while True:
            remaining = deadline-time.monotonic()
            require(remaining > 0 and bool(select.select([channel],[],[],remaining)[0]))
            chunk = channel.recv(len(PREFIX)+37-len(record))
            if not chunk:
                break
            record.extend(chunk)
            require(len(record) <= len(PREFIX)+36)
        require(len(record) == len(PREFIX)+36 and record.startswith(PREFIX))
        native = bytes(record[len(PREFIX):]).decode("ascii")
        value = uuid.UUID(native)
        require(str(value) == native)
        return ResumeSpec(_SEAL,config,value)
