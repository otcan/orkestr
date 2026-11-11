"""Fixed per-operation Root subreaper for one provider sign-in, status or sign-out.

An anonymous Root-parent socket selects one provider and mode from a closed set.
Argv, environment and paths come from the sealed package. The CLI and every file
operation on a credential run under the executor identity, in a child of this
anchor, so no credential byte reaches Root, Core or a frame.
"""
import ctypes
import json
import os
from pathlib import Path
import select
import signal
import socket
import struct
import subprocess
import time

from codex_bounded.trust import process
from .contract import require
from . import provider_login as login

CONTROL_BOUND = 4096
TERMINAL_WAIT_SECONDS = 3


def nnp_and_parent_death():
    # Runs after Popen's setgroups/setresgid/setresuid, so the settings survive.
    libc = ctypes.CDLL(None)
    if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError('provider_login_child_limits')


def executor_identity(package):
    return dict(uid=package.executor_uid, gid=package.executor_gid)


def drop(identity):
    os.setgroups([])
    os.setresgid(identity['gid'], identity['gid'], identity['gid'])
    os.setresuid(identity['uid'], identity['uid'], identity['uid'])
    require(ctypes.CDLL(None).prctl(38, 1, 0, 0, 0) == 0, 'provider_login_no_new_privileges')


def dropped(identity, action):
    """Run one file action in a forked executor child; return its small JSON."""
    reader, writer = os.pipe2(os.O_CLOEXEC)
    pid = os.fork()
    if pid == 0:
        status = 1
        try:
            os.close(reader)
            if identity is not None:
                drop(identity)
            payload = json.dumps(action() or {}).encode()
            os.write(writer, payload)
            status = 0
        except BaseException:
            status = 2
        finally:
            os._exit(status)
    os.close(writer)
    try:
        raw = bytearray()
        while len(raw) <= 16384:
            part = os.read(reader, 16385 - len(raw))
            if not part:
                break
            raw.extend(part)
    finally:
        os.close(reader)
    _, wait = os.waitpid(pid, 0)
    if wait != 0 or len(raw) > 16384:
        raise RuntimeError('provider_login_dropped_action')
    return json.loads(raw) if raw else {}


class Custody:
    """Kernel custody of the CLI and anything it left behind, as desk anchors do."""

    def __init__(self, child):
        from .desk_anchor import Tree
        from .ownership import Process
        original = process(child.pid)
        require(original and original['ppid'] == os.getpid(), 'provider_login_owned_child')
        require(ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0, 'provider_login_subreaper')
        self.child, self.tree, self.known = child, Tree(), {(original['pid'], original['start'])}
        self.record = Process(original, any_uid=True)
        self.original = original

    def observe(self):
        from .ownership import Adopted
        self.tree.capture(self.known)
        for pid in Adopted.children(self.original):
            descendant = process(pid)
            if descendant and descendant['ppid'] == self.original['pid']:
                self.tree._remember(descendant)
        self.tree.observe()

    def kill(self):
        self.record.send(signal.SIGKILL)
        for descendant in self.tree.records.values():
            descendant.send(signal.SIGKILL)

    def finish(self):
        """After the original child is reaped, every left-behind process is ours."""
        clean = False
        until = time.monotonic() + TERMINAL_WAIT_SECONDS
        while time.monotonic() < until:
            self.tree.drain(set(), seconds=.05)
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                clean = True
                break
            if pid == 0:
                time.sleep(.01)
        return clean and all(p.gone() for p in self.tree.records.values())

    def close(self):
        self.record.close()
        self.tree.close()


class NoCustody:
    """Tests only: the fake CLI runs in a process group and is reaped by the test."""

    def __init__(self, child):
        self.child = child

    def observe(self):
        pass

    def kill(self):
        try:
            os.killpg(self.child.pid, signal.SIGKILL)
        except OSError:
            pass

    def finish(self):
        return True

    def close(self):
        pass


class Session:
    def __init__(self, config, name, deadline_ns, channel, identity, temp_root, custody=Custody):
        self.config, self.name, self.deadline_ns = config, name, deadline_ns
        self.channel, self.identity, self.temp_root = channel, identity, Path(temp_root)
        self.custody = custody
        self.cancelled = False

    def send(self, value):
        raw = login.encode(value)
        self.channel.setblocking(True)
        self.channel.settimeout(2)
        self.channel.sendall(raw)
        self.channel.setblocking(False)

    def _expired(self):
        return time.monotonic_ns() >= self.deadline_ns

    def run(self, mode):
        return {'login': self.login, 'status': self.status, 'signout': self.sign_out}[mode]()

    # A CLI run reads only its own output pipe; `control` handles Root's bytes.
    def _spawn(self, argv, env, cwd, stdio):
        if self.identity is None:
            return subprocess.Popen(argv, env=env, cwd=cwd, close_fds=True, start_new_session=True, **stdio)
        return subprocess.Popen(argv, env=env, cwd=cwd, close_fds=True, start_new_session=True,
                                user=self.identity['uid'], group=self.identity['gid'], extra_groups=[],
                                umask=0o077, preexec_fn=nnp_and_parent_death, **stdio)

    def login(self):
        home = Path(dropped(self.identity, lambda: dict(
            path=str(login.prepare_home(self.temp_root, self.name))))['path'])
        try:
            state, reason = self._login(home)
        except Exception:
            state, reason = 'failed', 'internal'
        finally:
            try:
                dropped(self.identity, lambda: _remove(home))
            except Exception:
                pass  # The next sign-in removes this residue before it starts.
        self.send(dict(final=True, state=state, reason=reason))

    def _login(self, home):
        argv, env = login.login_command(self.config, self.name, home)
        master = None
        if self.name == 'claude':
            # Claude asks for the browser's code at a prompt: give it a private pty.
            master, slave = os.openpty()
            streams = dict(stdin=slave, stdout=slave, stderr=slave)
        else:
            streams = dict(stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        try:
            child = self._spawn(argv, env, str(home), streams)
        finally:
            if master is not None:
                os.close(slave)
        output = master if master is not None else child.stdout.fileno()
        os.set_blocking(output, False)
        custody = self.custody(child)
        parser = login.Parser(self.name)
        control = bytearray()
        try:
            while child.poll() is None:
                if self._expired():
                    self.cancelled = True
                self._read_control(control, master)
                ready, _, _ = select.select([output], [], [], .05)
                if ready:
                    self._read_output(output, parser)
                custody.observe()
                if self.cancelled:
                    custody.kill()
            child.wait()
            while self._read_output(output, parser):
                pass
            custody.finish()
        except BaseException:
            custody.kill()
            custody.finish()
            raise
        finally:
            custody.close()
            if master is not None:
                os.close(master)
            if child.stdout is not None:
                child.stdout.close()
        if self.cancelled:
            return ('expired', 'timeout') if self._expired() else ('cancelled', None)
        if child.returncode != 0:
            return 'failed', 'upstream_rate_limited' if parser.rate_limited() else 'login_failed'
        return self._commit(home)

    def _commit(self, home):
        try:
            dropped(self.identity, lambda: _commit(self.config, self.name, home))
        except RuntimeError:
            return 'failed', 'commit_failed'
        return 'succeeded', None

    def _read_output(self, output, parser):
        try:
            data = os.read(output, 4096)
        except BlockingIOError:
            return False
        except OSError:
            return False  # A closed pty end reports EIO once the CLI has exited.
        if not data:
            return False
        progress = parser.feed(data)
        if progress is not None:
            self.send(progress)
        return True

    def _read_control(self, control, master):
        try:
            received = self.channel.recv(CONTROL_BOUND)
        except BlockingIOError:
            return
        except OSError:
            received = b''
        if not received:
            self.cancelled = True
            return
        control.extend(received)
        if len(control) > CONTROL_BOUND:
            self.cancelled = True
            control.clear()
            return
        while control and not self.cancelled:
            if control[0] == ord('C'):
                self.cancelled = True
                control.clear()
            elif control[0] == ord('S'):
                if len(control) < 5:
                    return
                length = struct.unpack('!I', control[1:5])[0]
                if length > 1024 or master is None:
                    self.cancelled = True
                    control.clear()
                    return
                if len(control) < 5 + length:
                    return
                code = bytes(control[5:5 + length])
                del control[:5 + length]
                os.write(master, code + b'\r')
                self.send(dict(state='verifying'))
            else:
                self.cancelled = True
                control.clear()

    def status(self):
        if self.name == 'codex':
            value = dropped(self.identity, lambda: login.status_codex(self.config['auth_file']))
        else:
            value = self._claude_status()
        self.send(dict(final=True, status=value))

    def _claude_status(self):
        argv, env = login.claude_status_command(self.config)
        output, code = self._capture(argv, env)
        if code is None:
            return dict(signed_in=None, method=None)
        value = login.status_claude(output)
        # A nonzero exit is the CLI's own "not signed in" answer.
        return value if code == 0 else dict(value, signed_in=False)

    def _capture(self, argv, env):
        child = self._spawn(argv, env, '/', dict(stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                                 stderr=subprocess.DEVNULL))
        custody = self.custody(child)
        output = bytearray()
        fd = child.stdout.fileno()
        os.set_blocking(fd, False)

        def drain():
            while len(output) <= login.OUTPUT_LIMIT:
                try:
                    part = os.read(fd, 4096)
                except BlockingIOError:
                    return
                if not part:
                    return
                output.extend(part)

        try:
            while child.poll() is None:
                if self._expired():
                    custody.kill()
                    child.wait()
                    return bytes(output), None
                custody.observe()
                if select.select([fd], [], [], .05)[0]:
                    drain()
            drain()
            custody.finish()
            return bytes(output), child.returncode
        finally:
            custody.close()
            child.stdout.close()

    def sign_out(self):
        try:
            if self.name == 'codex':
                dropped(self.identity, lambda: login.signout_codex(self.config['auth_file']))
            else:
                argv, env = login.claude_signout_command(self.config)
                output, code = self._capture(argv, env)
                if code != 0:
                    raise RuntimeError('provider_login_signout')
        except Exception:
            self.send(dict(final=True, state='failed', reason='commit_failed'))
            return
        self.send(dict(final=True, state='succeeded', reason=None))


def _commit(config, name, home):
    if name == 'codex':
        login.commit_codex(home, config['auth_file'])
    else:
        login.commit_claude(home, config['account'])


def _remove(home):
    import shutil
    shutil.rmtree(home, ignore_errors=True)


def main(package, arguments):
    require(os.geteuid() == 0 and package.identity_split and len(arguments) == 3,
            'provider_login_anchor_scope')
    fd, parent, start = map(int, arguments)
    identity = process(parent)
    require(fd > 2 and parent == os.getppid() and identity and identity['uid'] == 0
            and identity['start'] == start, 'provider_login_anchor_parent')
    with socket.socket(fileno=fd) as channel:
        pid, uid, _ = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        require(pid == parent and uid == 0, 'provider_login_anchor_socket')
        channel.settimeout(2)

        def read(size):
            data = bytearray()
            while len(data) < size:
                part = channel.recv(size - len(data))
                require(part, 'provider_login_anchor_eof')
                data.extend(part)
            return bytes(data)

        length = struct.unpack('!I', read(4))[0]
        require(0 < length <= login.MAX_FRAME, 'provider_login_anchor_bound')
        job = json.loads(read(length))
        require(type(job) is dict and set(job) == {'provider', 'mode', 'deadline_ns'}
                and job['provider'] in login.PROVIDERS and job['mode'] in ('login', 'status', 'signout')
                and type(job['deadline_ns']) is int, 'provider_login_anchor_fields')
        config = login.configuration(package, job['provider'])
        require(config is not None, 'provider_login_anchor_configuration')
        # Before any child exists, so even an instant double-fork stays ours.
        require(ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0, 'provider_login_subreaper')
        channel.setblocking(False)
        Session(config, job['provider'], job['deadline_ns'], channel, executor_identity(package),
                package.provider_home / login.TEMP_DIRECTORY).run(job['mode'])
    return 0
