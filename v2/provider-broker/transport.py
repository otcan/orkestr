"""Bounded nonblocking stdio pump; provider shares Runtime-owned process group."""
from reaping import become_subreaper, reap_owned, contained_command as lifetime_command
from collections import deque
import os
import signal
import time
import array
import socket
import selectors
import subprocess
from protocol import MAX_FRAME, Failure, Refused, decode, encode, require

MAX_PENDING = 8


def contained_command(command):
    """Lifetime wrapper plus a private minimal /dev: the root bind is nodev and
    Bun-based natives (the Claude CLI) abort without null/urandom."""
    argv = lifetime_command(command)
    at = argv.index("--proc")
    return argv[:at] + ["--dev", "/dev"] + argv[at:]


def adopted_children():
    """Live direct children of this subreaper process."""
    own, found = os.getpid(), []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat", "rb") as stat:
                fields = stat.read().rsplit(b") ", 1)[1].split()
        except OSError:
            continue
        if int(fields[1]) == own and fields[0] != b"Z":
            found.append(int(entry))
    return found


def reap_uncontained(child, timeout=2.0):
    """Host full access has no PID namespace. This broker spawned only the
    native, so every other live child is an adopted descendant of the owned
    tree (setsid tool shells included): kill it, then require ECHILD."""
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + timeout
    while True:
        for pid in adopted_children():
            if pid == child.pid:
                continue
            for kill in (os.killpg, os.kill):
                try:
                    kill(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        if pid == child.pid:
            child.returncode = os.waitstatus_to_exitcode(status)
        if pid == 0:
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)


def failure_exit(error, child, fallback=None):
    """Diagnostic-only exit80..217; never success or the exclusive reap exit73.

    Sample the original direct child before finally signals/reaps its group.
    WNOWAIT retains that original PID as cleanup authority. An unreadable status
    is unknown, not absence. No exception/provider text enters the result.
    """
    failure = error.failure if isinstance(error, Refused) else fallback
    if type(failure) is not Failure:
        failure = Failure.TRANSPORT_IO if isinstance(error, OSError) else Failure.INTERNAL
    state = 0  # no owned child was launched
    if child is not None:
        try:
            observed = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if observed is None:
                state = 1  # original not observed exited at this instant
            elif observed.si_code == os.CLD_EXITED:
                state = 2 if observed.si_status == 0 else 3
            elif observed.si_code in (os.CLD_KILLED, os.CLD_DUMPED):
                state = 4
            else:
                state = 5
        except (OSError, ValueError):
            state = 5
    return 80 + (int(failure) - 1) * 6 + state


class Pump:
    def __init__(self, config, channel, incoming=0, outgoing=1, handoff=None, diagnostics=False,
                 stderr_capture=None):
        require(type(diagnostics) is bool)
        self.config, self.channel = config, channel
        self.incoming, self.outgoing = incoming, outgoing
        self.child = None
        self.reaped = False
        self.parent_eof = False
        self.handoff = handoff
        self.buffers = {}
        self.queues = {outgoing: deque()}
        self.selector = selectors.DefaultSelector()
        # Only the selected service launcher opts in; unrelated brokers retain
        # their original failure exit and do not perform this extra observation.
        self.diagnostics = diagnostics
        self.failure_exit = 2
        self.failure_fallback = None
        self.stderr_capture = stderr_capture
        self.last_provider_frame_bytes = 0
        # Only the provider source may opt into a larger bound; parent input
        # and every broker output keep MAX_FRAME.
        self.provider_limit = getattr(config, "max_provider_frame", MAX_FRAME)
        require(type(self.provider_limit) is int and MAX_FRAME <= self.provider_limit <= 16 * 1024 * 1024)

    def limit(self, fd):
        return MAX_FRAME if fd == self.incoming else self.provider_limit

    def queue(self, fd, value):
        queue = self.queues[fd]
        require(len(queue) < MAX_PENDING)
        queue.append(encode(value))

    def launch(self):
        # A private native group can be killed without killing this subreaper.
        become_subreaper()
        command = self.config.command()
        if getattr(self.config, "uncontained", False) is not True:
            command = contained_command(command)
        self.child = subprocess.Popen(command, env=self.config.environment(),
                                      cwd=self.config.workspace, stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE if self.stderr_capture is not None else subprocess.DEVNULL,
                                      close_fds=True, process_group=0)
        if hasattr(self.config, "owned_spawned"):
            self.config.owned_spawned(self.child)
        for pipe in (self.child.stdin, self.child.stdout):
            os.set_blocking(pipe.fileno(), False)
        if self.stderr_capture is not None:
            os.set_blocking(self.child.stderr.fileno(), False)
            self.watch(self.child.stderr.fileno(), selectors.EVENT_READ)
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
        if fd != self.incoming:
            self.last_provider_frame_bytes = len(raw)
        try:
            value = decode(raw, self.limit(fd))
        except Refused as error:
            if self.diagnostics and fd == self.incoming:
                error.failure = Failure.PARENT_INPUT
            raise
        if fd == self.incoming:
            try:
                provider, response = self.channel.client(value)
            except Refused as error:
                if self.diagnostics:
                    error.failure = Failure.PARENT_INPUT
                raise
            if self.child is None:
                try:
                    self.launch()
                except Exception:
                    self.failure_fallback = Failure.LAUNCH
                    raise
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
            if fd != self.incoming:
                self.last_provider_frame_bytes = len(raw)
            require(bool(raw) and len(raw) <= self.limit(fd), Failure.FRAME_BOUND)
            self.line(fd, raw)
        if fd != self.incoming and buffer:
            self.last_provider_frame_bytes = len(buffer)
        require(len(buffer) <= self.limit(fd), Failure.FRAME_BOUND)
        self.buffers[fd] = buffer

    def read(self, fd):
        if (self.stderr_capture is not None and self.child is not None
                and self.child.stderr is not None and fd == self.child.stderr.fileno()):
            self.read_stderr(fd)
            return True  # Stderr EOF is never a provider EOF or readiness.
        self.drain_buffer(fd)
        if not self.capacity() or b"\n" in self.buffers[fd]:
            return True
        try:
            chunk = os.read(fd, min(self.limit(fd) + 1 - len(self.buffers[fd]), 1024 * 1024))
        except BlockingIOError:
            return True
        except OSError:
            if fd != self.incoming:
                self.failure_fallback = Failure.PROVIDER_READ_IO
            raise
        if not chunk:
            require(not self.buffers.get(fd), Failure.FRAME_TRUNCATED)
            if fd == self.incoming:
                self.parent_eof = True
                return False
            raise Refused("provider EOF; delivery may be unknown", Failure.PROVIDER_EOF)
        self.buffers[fd] += chunk
        self.drain_buffer(fd)
        return True

    def read_stderr(self, fd):
        try:
            chunk = os.read(fd, 4096)
        except BlockingIOError:
            return False
        except OSError:
            chunk = b''  # Optional diagnostics cannot poison protocol state.
        if chunk:
            try:
                self.stderr_capture.feed(chunk)
            except Exception:
                pass
            return True
        try:
            if fd in (self.selector.get_map() or {}):
                self.selector.unregister(fd)
        except (OSError, ValueError):
            pass
        return False

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
        except Exception as error:
            if self.diagnostics:
                self.failure_exit = failure_exit(error, self.child, self.failure_fallback)
            raise
        finally:
            try:
                if self.child is not None:
                    # A pipe close failure must not skip owned-child termination.
                    for pipe in (self.child.stdin, self.child.stdout):
                        try:
                            if pipe is not None:
                                pipe.close()
                        except OSError:
                            pass
                    if getattr(self.config, "uncontained", False) is True:
                        self.reaped = reap_uncontained(self.child)
                    else:
                        self.reaped = reap_owned(self.child)
            finally:
                try:
                    if self.stderr_capture is not None and self.child is not None and self.child.stderr is not None:
                        # A bounded, nonblocking drain cannot delay owned cleanup.
                        try:
                            fd = self.child.stderr.fileno()
                            # launch() may have failed before configuring pipes.
                            os.set_blocking(fd, False)
                            for _ in range(16):
                                if not self.read_stderr(fd):
                                    break
                        except (OSError, ValueError):
                            pass
                        finally:
                            self.child.stderr.close()
                finally:
                    self.selector.close()
