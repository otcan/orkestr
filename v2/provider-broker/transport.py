"""Bounded nonblocking stdio pump; provider shares Runtime-owned process group."""
from reaping import become_subreaper, reap_owned
from collections import deque
import os
import array
import socket
import selectors
import subprocess
from protocol import MAX_FRAME, Refused, decode, encode, require

MAX_PENDING = 8


class Pump:
    def __init__(self, config, channel, incoming=0, outgoing=1, handoff=None):
        self.config, self.channel = config, channel
        self.incoming, self.outgoing = incoming, outgoing
        self.child = None
        self.reaped = False
        self.parent_eof = False
        self.handoff = handoff
        self.buffers = {}
        self.queues = {outgoing: deque()}
        self.selector = selectors.DefaultSelector()

    def queue(self, fd, value):
        queue = self.queues[fd]
        require(len(queue) < MAX_PENDING)
        queue.append(encode(value))

    def launch(self):
        # A private native group can be killed without killing this subreaper.
        become_subreaper()
        self.child = subprocess.Popen(self.config.command(), env=self.config.environment(),
                                      cwd=self.config.workspace, stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                      close_fds=True, process_group=0)
        if hasattr(self.config, "owned_spawned"):
            self.config.owned_spawned(self.child)
        for pipe in (self.child.stdin, self.child.stdout):
            os.set_blocking(pipe.fileno(), False)
        if self.handoff is None:
            self.queues[self.child.stdin.fileno()] = deque()
        else:
            # Only the trusted parent receives the sole provider writer. No
            # provider request is ever buffered/written by this broker mode.
            writer = self.child.stdin
            try:
                rights = array.array("i", [writer.fileno()])
                sent = self.handoff.sendmsg([b"provider-stdin-v1"],
                    [(socket.SOL_SOCKET, socket.SCM_RIGHTS, rights)])
                require(sent == len(b"provider-stdin-v1"))
            finally:
                writer.close()
                self.handoff.close()
            self.child.stdin = None
        self.watch(self.child.stdout.fileno(), selectors.EVENT_READ)

    def watch(self, fd, events):
        try:
            self.selector.modify(fd, events)
        except KeyError:
            self.selector.register(fd, events)

    def line(self, fd, raw):
        value = decode(raw)
        if fd == self.incoming:
            provider, response = self.channel.client(value)
            if self.child is None:
                self.launch()
            if provider is not None:
                if self.handoff is None:
                    self.queue(self.child.stdin.fileno(), provider)
                else:
                    self.queue(self.outgoing, {"method": "BrokerPrepared", "params": {
                        "owned_handle": self.channel.handle, "request_id": value["id"]}})
            if response is not None:
                self.queue(self.outgoing, response)
        else:
            response = self.channel.provider(value)
            if response is not None:
                self.queue(self.outgoing, response)

    def capacity(self):
        # Every source operation emits at most one frame per sink. Pause source
        # processing at the existing bound; never turn a healthy burst into loss.
        return all(len(queue) < MAX_PENDING for queue in self.queues.values())

    def drain_buffer(self, fd):
        buffer = self.buffers.get(fd, b"")
        while b"\n" in buffer and self.capacity():
            raw, buffer = buffer.split(b"\n", 1)
            require(bool(raw) and len(raw) <= MAX_FRAME)
            self.line(fd, raw)
        require(len(buffer) <= MAX_FRAME)
        self.buffers[fd] = buffer

    def read(self, fd):
        self.drain_buffer(fd)
        if not self.capacity() or b"\n" in self.buffers[fd]:
            return True
        try:
            chunk = os.read(fd, MAX_FRAME + 1 - len(self.buffers[fd]))
        except BlockingIOError:
            return True
        if not chunk:
            require(not self.buffers.get(fd))
            if fd == self.incoming:
                self.parent_eof = True
                return False
            raise Refused("provider EOF; delivery may be unknown")
        self.buffers[fd] += chunk
        self.drain_buffer(fd)
        return True

    def write(self, fd):
        queue = self.queues[fd]
        try:
            count = os.write(fd, queue[0])
        except BlockingIOError:
            return
        require(count > 0)
        if count == len(queue[0]):
            queue.popleft()
        else:
            queue[0] = queue[0][count:]  # never replay the written prefix
        for source in list(self.buffers):
            self.drain_buffer(source)

    def run(self):
        try:
            for fd in (self.incoming, self.outgoing):
                os.set_blocking(fd, False)
            while True:
                sources = [self.incoming]
                if self.child is not None:
                    sources.append(self.child.stdout.fileno())
                for source in sources:
                    self.drain_buffer(source)
                    if self.capacity() and b"\n" not in self.buffers[source]:
                        self.watch(source, selectors.EVENT_READ)
                    elif source in self.selector.get_map():
                        self.selector.unregister(source)
                for fd, queue in self.queues.items():
                    if queue:
                        self.watch(fd, selectors.EVENT_WRITE)
                    elif fd in self.selector.get_map():
                        self.selector.unregister(fd)
                for key, events in self.selector.select():
                    if events & selectors.EVENT_READ and not self.read(key.fd):
                        return
                    if events & selectors.EVENT_WRITE:
                        self.write(key.fd)
        finally:
            self.selector.close()
            if self.child is not None:
                # A pipe close failure must not skip owned-child termination.
                for pipe in (self.child.stdin, self.child.stdout):
                    try:
                        if pipe is not None:
                            pipe.close()
                    except OSError:
                        pass
                self.reaped = reap_owned(self.child)
