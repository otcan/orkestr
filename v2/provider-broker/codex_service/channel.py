"""One bounded command from the exact source-pinned ordinary server process."""
from pathlib import Path
import select
import socket
import struct
import time

from codex_bounded.trust import exists, process
from .contract import HEADER, MAX_FRAME, MAX_BIND_MS, decode, encode, require


def bind_deadline(wall_deadline_ms, accepted, work_deadline):
    """Translate the caller's original bound once; no per-stage renewal."""
    require(type(wall_deadline_ms) is int and 0 < wall_deadline_ms < 2**53,
            "bind_deadline")
    now = time.monotonic()
    remaining_ms = wall_deadline_ms - time.time_ns() // 1_000_000
    require(0 < remaining_ms <= MAX_BIND_MS, "bind_deadline")
    deadline = min(accepted + MAX_BIND_MS / 1000,
                   now + remaining_ms / 1000, work_deadline)
    require(now < deadline, "bind_deadline")
    return deadline


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


def receive_control(connection, deadline):
    """Receive bounded ancillary rights without silently discarding descriptors."""
    import array
    import os
    descriptors=[]
    try:
        connection.setblocking(False)
        remaining=deadline-time.monotonic()
        require(remaining>0 and select.select([connection],[],[],remaining)[0], 'control_deadline')
        head,ancillary,flags,_=connection.recvmsg(HEADER.size,socket.CMSG_SPACE(5*4),socket.MSG_CMSG_CLOEXEC)
        valid=True
        for level,kind,data in ancillary:
            if level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS and len(data)%4==0:
                values=array.array('i');values.frombytes(data);descriptors.extend(values)
            else:
                valid=False
        require(valid,'control_ancillary_type')
        require(not flags & (socket.MSG_CTRUNC|socket.MSG_TRUNC),'control_ancillary_truncated')
        head+=read_exact(connection,HEADER.size-len(head),deadline)
        size=HEADER.unpack(head)[0]
        require(0<size<=MAX_FRAME,'frame_bound')
        request=decode(read_exact(connection,size,deadline))
        require((request['operation']=='launch_child' and len(descriptors)==(5 if request['mode']=='resume' else 4)) or
                (request['operation']=='workspace_attest' and len(descriptors)==1) or
                (request['operation']=='workspace_command' and len(descriptors)==4) or
                (request['operation'] not in ('launch_child','workspace_attest','workspace_command') and not descriptors), 'control_descriptor_count')
        readable,_,_=select.select([connection],[],[],0)
        if readable:require(not connection.recv(1,socket.MSG_PEEK),'control_trailing_bytes')
        return request,descriptors
    except BaseException:
        for fd in descriptors:os.close(fd)
        raise
