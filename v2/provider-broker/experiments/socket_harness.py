"""Owned local-stream oracle for admission experiments, never a product proxy.

Socket pairs stand in for the client and authorized upstream. No network host,
CONNECT parser, TLS, provider process, credential or real request is involved.
Virtual time controls policy deadlines; real bounded waits only join I/O work.
"""
import select
import socket
import threading
import time
from dataclasses import dataclass, field

from admission import Admission, Limits


CHUNK = 16384


@dataclass
class Channel:
    ticket: object
    client: socket.socket
    incoming: socket.socket
    upstream: socket.socket | None = None
    peer: socket.socket | None = None
    buffers: list = field(default_factory=lambda: [bytearray(), bytearray()])


class SocketHarness:
    def __init__(self, limits=Limits()):
        self.policy = Admission(limits=limits)
        self.channels = []
        self.condition = threading.Condition(threading.RLock())
        self.stopping = False
        self.forwarded = self.peak_owned_sockets = self.peak_buffered = 0
        self.failure = None
        self.thread = threading.Thread(target=self._run, name="admission-experiment")
        self.thread.start()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def request(self):
        with self.condition:
            ticket = self.policy.open(self.policy.now)
            if ticket is None:
                return None
            client, incoming = socket.socketpair()
            client.settimeout(2)
            incoming.setblocking(False)
            channel = Channel(ticket, client, incoming)
            self.channels.append(channel)
            self._sync()
            return channel

    def advance(self, now):
        with self.condition:
            self.policy.advance(now)
            self._sync()

    def cancel(self, channel):
        with self.condition:
            self.policy.finish(channel.ticket, self.policy.now, "cancelled")
            self._sync()

    def wait(self, predicate):
        with self.condition:
            ok = self.condition.wait_for(lambda: self.failure or predicate(), timeout=2)
            if self.failure:
                raise AssertionError("socket experiment failed") from self.failure
            if not ok:
                raise AssertionError("socket experiment wait expired")

    def close(self):
        with self.condition:
            self.stopping = True
            self.policy.close()
        self.thread.join(2)
        if self.thread.is_alive():
            raise AssertionError("socket experiment failed to join")
        for channel in self.channels:
            for endpoint in (channel.client, channel.incoming, channel.upstream, channel.peer):
                if endpoint is not None:
                    endpoint.close()
        if self.failure:
            raise AssertionError("socket experiment failed") from self.failure

    def _sync(self):
        for channel in self.channels:
            if channel.ticket.state == "active" and channel.upstream is None:
                channel.upstream, channel.peer = socket.socketpair()
                channel.upstream.setblocking(False)
                channel.peer.settimeout(2)
            elif channel.ticket.state not in ("active", "pending"):
                channel.incoming.close()
                if channel.upstream is not None:
                    channel.upstream.close()
                channel.buffers = [bytearray(), bytearray()]
        owned = sum(
            endpoint is not None and endpoint.fileno() >= 0
            for channel in self.channels
            for endpoint in (channel.incoming, channel.upstream)
        )
        self.peak_owned_sockets = max(self.peak_owned_sockets, owned)
        self.peak_buffered = max(self.peak_buffered, sum(
            sum(map(len, channel.buffers)) for channel in self.channels
        ))
        self.condition.notify_all()

    def _run(self):
        try:
            self._pump()
        except BaseException as error:
            with self.condition:
                self.failure = error
                self.policy.close("harness_failure")
                self._sync()
        finally:
            with self.condition:
                self.policy.close()
                self._sync()

    def _pump(self):
        while True:
            with self.condition:
                if self.stopping:
                    return
                self._sync()
                # Read only when this direction's bounded buffer is empty.
                reads, writes = {}, {}
                for channel in self.channels:
                    if channel.ticket.state == "pending":
                        continue  # No upstream socket or read before admission.
                    if channel.ticket.state != "active":
                        continue
                    for direction, pair in enumerate((
                        (channel.incoming, channel.upstream),
                        (channel.upstream, channel.incoming),
                    )):
                        source, destination = pair
                        if channel.buffers[direction]:
                            writes[destination] = (channel, direction)
                        else:
                            reads[source] = (channel, direction)
                try:
                    readable, writable, _ = select.select(reads, writes, [], 0)
                except (ValueError, OSError):
                    raise AssertionError("unexpected closed owned socket")
                for source in readable:
                    channel, direction = reads[source]
                    if channel.ticket.state != "active":
                        continue
                    data = source.recv(CHUNK)
                    if not data:
                        self.policy.finish(channel.ticket, self.policy.now)
                    elif self.policy.reserve(channel.ticket, len(data), self.policy.now):
                        channel.buffers[direction].extend(data)
                for destination in writable:
                    channel, direction = writes[destination]
                    if channel.ticket.state != "active":
                        continue
                    try:
                        count = destination.send(channel.buffers[direction])
                    except BlockingIOError:
                        continue
                    del channel.buffers[direction][:count]
                    self.forwarded += count
                self._sync()
            # No wall-clock sleep is used to manufacture a policy outcome.
            # This short yield only lets local socket peers and waiters run.
            time.sleep(0.001)
