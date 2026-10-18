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
from protocol import require

PREFIX = b"codex-resume-v1\0"


def receive(descriptor=4):
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
            chunk = channel.recv(len(PREFIX)+513-len(record))
            if not chunk:
                break
            record.extend(chunk)
            require(len(record) <= len(PREFIX)+512)
        require(len(record) > len(PREFIX) and record.startswith(PREFIX))
        native = bytes(record[len(PREFIX):]).decode("utf-8")
        require(len(native) <= 512 and not any(ord(c) < 32 for c in native))
        return native
