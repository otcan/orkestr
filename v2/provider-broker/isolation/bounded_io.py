"""Bounded private control envelope and opaque byte transport; no TLS parsing."""
import errno
import select
import socket
import struct
import time

if __package__:
    from .bounded_budget import Refused
else:
    from bounded_budget import Refused


PRELUDE = struct.Struct("!8sQ")
MAGIC = b"ORKPX2\x00\x00"
ESTABLISHED = b"HTTP/1.1 200 Connection Established\r\n\r\n"


def peer_closed(endpoint):
    """Linux FIN detection without consuming queued CONNECT/payload bytes."""
    probe = select.poll()
    mask = select.POLLHUP | select.POLLERR | select.POLLNVAL | select.POLLRDHUP
    probe.register(endpoint, mask)
    return any(events & mask for _descriptor, events in probe.poll(0))


def wait(context, endpoint, writing=False):
    while True:
        context.check()
        reads, writes, _ = select.select([] if writing else [endpoint],
            [endpoint] if writing else [], [], .01)
        if reads or writes:
            return


def send(context, endpoint, data):
    view = memoryview(data)
    while view:
        wait(context, endpoint, True)
        try:
            count = endpoint.send(view)
        except BlockingIOError:
            continue
        if count <= 0:
            raise Refused("closed_write")
        view = view[count:]


def connect(context, endpoint, address):
    context.check()
    error = endpoint.connect_ex(address)
    if error not in (0, errno.EINPROGRESS, errno.EALREADY, errno.EWOULDBLOCK):
        raise Refused("connect")
    if error:
        wait(context, endpoint, True)
        if endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR):
            raise Refused("connect")
    context.check()


def header(context, endpoint):
    value = bytearray()
    while not value.endswith(b"\r\n\r\n"):
        wait(context, endpoint)
        try:
            chunk = endpoint.recv(1)
        except BlockingIOError:
            continue
        if not chunk:
            raise Refused("truncated_header")
        value.extend(chunk)
        if len(value) > 4096:
            raise Refused("header_bound")
    return bytes(value)


def read_prelude(context, blocking=True):
    """Peer/source authentication MUST precede this private-v2 parser.

    Same-host CLOCK_MONOTONIC is assumed; the timestamp is not authority. It
    can only shorten the receiver's own deadline. No CONNECT bytes are consumed
    here, including when envelope and CONNECT arrive in a single write.
    """
    while not context.prelude_read:
        context.check()
        if blocking:
            wait(context, context.client)
        try:
            data = context.client.recv(PRELUDE.size - len(context.prelude))
        except BlockingIOError:
            return False
        if not data:
            raise Refused("truncated_prelude")
        context.prelude.extend(data)
        if len(context.prelude) != PRELUDE.size:
            if not blocking:
                return False
            continue
        magic, accepted = PRELUDE.unpack(context.prelude)
        now = time.monotonic_ns()
        bound = int(context.budget.limits.setup_seconds * 1e9)
        if magic != MAGIC or not 0 < accepted <= context.accepted_ns or now - accepted >= bound:
            raise Refused("invalid_prelude")
        context.deadline = min(context.deadline, accepted / 1e9 + context.budget.limits.setup_seconds)
        context.prelude_read = True
    return True


def relay(context, upstream):
    """One charged chunk per read, both directions sharing the outer budget.

    Writes are cancellation/deadline aware, with at most one16KiB application
    chunk retained per relay. Header/envelope bytes have separate finite bounds.
    """
    client = context.client
    while True:
        context.check()
        readable, _, _ = select.select([client, upstream], [], [], .01)
        for source in readable:
            context.check()
            try:
                data = source.recv(16384)
            except BlockingIOError:
                continue
            if not data:
                return
            context.budget.reserve(context, len(data))
            send(context, upstream if source is client else client, data)
