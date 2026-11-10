"""No-account local TCP/Unix harness for the actual candidate proxy modules."""
import os
import select
import socket
import struct
import tempfile
import threading
import time

from isolation.bounded_budget import Budget, Context, Limits
from isolation.bounded_io import connect
from isolation.bounded_pool import Pool
from isolation.bounded_proxy import Inner, outer


REQUEST = b"CONNECT fixture.example:443 HTTP/1.1\r\nHost: fixture.example:443\r\n\r\n"


class Fixture:
    def __init__(self, limits=Limits(), resolver=None, echo=True):
        self.temp = tempfile.TemporaryDirectory(prefix="bounded-proxy-test-")
        self.endpoint = self.temp.name + "/egress.sock"
        self.root = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.root.bind(self.endpoint)
        self.root.listen(16)
        self.root.settimeout(.01)
        self.target = socket.socket()
        self.target.bind(("127.0.0.1", 0))
        self.target.listen(16)
        self.target.setblocking(False)
        self.budget = Budget(limits)
        self.inner = Inner(("fixture.example",), self.endpoint, Budget(limits))
        self.contexts = []
        self.peers = []
        self.clients = []
        self.stopped = threading.Event()
        self.failures = []
        self.resolves = 0
        self.echo = echo

        def resolve(context, host):
            self.resolves += 1
            assert host == "fixture.example"
            if resolver:
                return resolver(context, host)
            return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ("93.184.216.34", 443))]

        def dial(context, endpoint, address):
            assert address == ("93.184.216.34", 443)
            connect(context, endpoint, self.target.getsockname())

        self.pool = Pool(lambda c: outer(c, ("fixture.example",), resolve, dial), self.budget, outer=True)
        self.threads = [threading.Thread(target=self._root_loop), threading.Thread(target=self._echo_loop)]
        for thread in self.threads:
            thread.start()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def client(self, request=REQUEST):
        # A real TCP accept supplies the timestamp, just like the supervisor.
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        client = socket.create_connection(listener.getsockname(), timeout=2)
        incoming, _ = listener.accept()
        accepted = time.monotonic_ns()
        listener.close()
        client.settimeout(3)
        self.clients.append(client)
        self.inner.admit(incoming, accepted)
        if request is not None:
            client.sendall(request)
        return client

    def response(self, client):
        value = bytearray()
        while not value.endswith(b"\r\n\r\n"):
            data = client.recv(1)
            if not data:
                return bytes(value)
            value.extend(data)
        return bytes(value)

    def poll(self):
        self.inner.poll()
        if self.failures:
            raise AssertionError("fixture worker failed") from self.failures[0]

    def until(self, predicate, seconds=3):
        deadline = time.monotonic() + seconds
        while not predicate():
            self.poll()
            if time.monotonic() >= deadline:
                raise AssertionError("fixture wait expired")
            time.sleep(.005)

    def replace_inner(self):
        self.inner.close()
        self.inner = Inner(("fixture.example",), self.endpoint, Budget(self.budget.limits))

    def _root_loop(self):
        try:
            while not self.stopped.is_set():
                self.pool.poll()
                try:
                    connection, _ = self.root.accept()
                except socket.timeout:
                    continue
                except OSError:
                    if self.stopped.is_set():
                        return
                    raise
                accepted = time.monotonic_ns()
                pid, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                assert pid == os.getpid() and uid == os.getuid()
                context = Context(connection, self.budget, accepted)
                self.contexts.append(context)
                self.pool.submit(context)
        except BaseException as error:
            self.failures.append(error)

    def _echo_loop(self):
        try:
            while not self.stopped.is_set():
                readable, _, _ = select.select([self.target] + (self.peers if self.echo else []), [], [], .01)
                for endpoint in readable:
                    if endpoint is self.target:
                        connection, _ = self.target.accept()
                        connection.settimeout(1)
                        self.peers.append(connection)
                    else:
                        data = endpoint.recv(16384)
                        if not data:
                            self.peers.remove(endpoint)
                            endpoint.close()
                        else:
                            endpoint.sendall(data)
        except BaseException as error:
            if not self.stopped.is_set():
                self.failures.append(error)

    def close(self):
        self.inner.close()
        self.stopped.set()
        self.root.close()
        for thread in self.threads:
            thread.join(3)
            assert not thread.is_alive()
        self.pool.close()
        self.target.close()
        for endpoint in self.peers + self.clients:
            endpoint.close()
        self.temp.cleanup()
        assert not self.failures, "fixture thread failed"
