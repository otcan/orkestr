"""One bounded command from the exact source-pinned ordinary server process."""
from pathlib import Path
import select
import socket
import struct
import time

from codex_bounded.trust import exists, process
from .contract import HEADER, MAX_FRAME, decode, encode, require


class ServerPeer:
    def __init__(self, identity, executable):
        self.identity = dict(identity)
        self.executable = Path(executable)
        info = self.executable.stat()
        self.inode = (info.st_dev, info.st_ino)

    def accepts(self, connection):
        try:
            pid, uid, _gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if pid != self.identity["pid"] or uid != self.identity["uid"] or not exists(self.identity):
                return False
            proc = Path("/proc") / str(pid)
            executable = proc / "exe"
            info = executable.stat()
            return (executable.resolve() == self.executable and (info.st_dev, info.st_ino) == self.inode
                    and (proc / "cmdline").read_bytes() == bytes(self.executable) + b"\0"
                    and exists(self.identity))
        except (OSError, ValueError):
            return False


def read_exact(connection, amount, deadline):
    data = bytearray()
    while len(data) < amount:
        remaining = deadline - time.monotonic()
        require(remaining > 0, "control_deadline")
        if not select.select([connection], [], [], remaining)[0]:
            require(False, "control_deadline")
        part = connection.recv(amount - len(data))
        require(part, "control_truncated")
        data.extend(part)
    return bytes(data)


def receive(connection, deadline):
    connection.setblocking(False)
    size = HEADER.unpack(read_exact(connection, HEADER.size, deadline))[0]
    require(0 < size <= MAX_FRAME, "frame_bound")
    value = decode(read_exact(connection, size, deadline))
    # One request per connection. Already queued extra bytes are never ignored.
    readable, _, _ = select.select([connection], [], [], 0)
    if readable:
        require(not connection.recv(1, socket.MSG_PEEK), "control_trailing_bytes")
    return value


def respond(connection, value, deadline):
    pending = memoryview(encode(value))
    while pending:
        remaining = deadline - time.monotonic()
        require(remaining > 0, "control_deadline")
        require(select.select([], [connection], [], remaining)[1], "control_deadline")
        count = connection.send(pending)
        require(count > 0, "control_closed")
        pending = pending[count:]
