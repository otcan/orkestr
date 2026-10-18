"""Bounded nonblocking stdio pump; provider shares Runtime-owned process group."""
from collections import deque
import os
import selectors
import subprocess
from protocol import MAX_FRAME, Refused, decode, encode, require

MAX_PENDING = 8


class Pump:
    def __init__(self, config, channel, incoming=0, outgoing=1):
        self.config, self.channel = config, channel
        self.incoming, self.outgoing = incoming, outgoing
        self.child = None
        self.buffers = {}
        self.queues = {outgoing: deque()}
        self.selector = selectors.DefaultSelector()

    def queue(self, fd, value):
        queue = self.queues[fd]
        require(len(queue) < MAX_PENDING)
        queue.append(encode(value))

    def launch(self):
        # No new session/group: revoking the enclosing owned broker group must
        # also stop the trusted connector. Never daemonize/adopt a live session.
        self.child = subprocess.Popen(self.config.command(), env=self.config.environment(),
                                      cwd=self.config.workspace, stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                      close_fds=True)
        for pipe in (self.child.stdin, self.child.stdout):
            os.set_blocking(pipe.fileno(), False)
        self.queues[self.child.stdin.fileno()] = deque()
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
                self.queue(self.child.stdin.fileno(), provider)
            if response is not None:
                self.queue(self.outgoing, response)
        else:
            response = self.channel.provider(value)
            if response is not None:
                self.queue(self.outgoing, response)

    def read(self, fd):
        try:
            chunk = os.read(fd, MAX_FRAME)
        except BlockingIOError:
            return True
        if not chunk:
            require(not self.buffers.get(fd))  # truncated EOF is never replayed
            if fd == self.incoming:
                return False
            raise Refused("provider EOF; delivery may be unknown")
        buffer = self.buffers.get(fd, b"") + chunk
        while b"\n" in buffer:
            raw, buffer = buffer.split(b"\n", 1)
            require(bool(raw) and len(raw) <= MAX_FRAME)
            self.line(fd, raw)
        require(len(buffer) <= MAX_FRAME)
        self.buffers[fd] = buffer
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

    def run(self):
        try:
            for fd in (self.incoming, self.outgoing):
                os.set_blocking(fd, False)
            self.watch(self.incoming, selectors.EVENT_READ)
            while True:
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
                self.child.stdin.close()
                self.child.stdout.close()
                # Direct owned PID only, never a client-selected process. Runtime
                # remains the owner of the encompassing process-group kill/reaper.
                self.child.terminate()
                try:
                    self.child.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=1)
