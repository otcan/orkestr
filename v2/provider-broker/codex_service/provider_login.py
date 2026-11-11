"""Owner-requested Claude and Codex sign-in, one install-wide login per provider.

Core asks over the peer-authenticated control socket; Root supervises through a
per-operation anchor; the provider's official CLI runs as the executor in a
private temporary home. Only a validated result replaces the working credential:
a failed, cancelled or abandoned sign-in never touches it. Credential bytes stay
in executor-identity children. Root, Core and the browser receive only the
sign-in link, the one-time device code and fixed state words.

The working credential may be a bind mount inside the manager's namespace
(`resource_namespace`): replacing such a file by rename fails with EBUSY, and
replacing the source path would leave running natives on the old inode, so the
bytes are rewritten in place. Elsewhere rename gives the same atomic result.
"""
import json
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import time

from codex_bounded.trust import metadata, process
from .contract import Refused, require
# Re-exported: the anchor and tests reach file operations through this module.
from .provider_login_files import (CODEX_SIGNED_OUT, commit_claude, commit_codex, in_place, prepare_home,
                                   replace_file, signout_codex, status_claude, status_codex)

PROVIDERS = ('codex', 'claude')
LOGIN_SECONDS = 15 * 60
STATUS_SECONDS = 30
SIGNOUT_SECONDS = 60
STATUS_TTL = 30
START_INTERVAL = 10
STARTS_PER_HOUR = 6
FINISHED_RETAIN = 10 * 60
MAX_FRAME = 8192
OUTPUT_LIMIT = 64 * 1024
TEMP_DIRECTORY = '.orkestr-provider-login'
TERMINAL = ('succeeded', 'failed', 'cancelled', 'expired')
REASONS = ('upstream_rate_limited', 'login_failed', 'credential_invalid', 'commit_failed',
           'superseded', 'timeout', 'internal')
ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')
LINKS = {
    'codex': re.compile(r'https://auth\.openai\.com/[A-Za-z0-9/._-]{1,200}'),
    'claude': re.compile(r'https://claude\.com/cai/oauth/authorize\?[A-Za-z0-9%&=_.+~-]{1,2000}'),
}
DEVICE_CODE = re.compile(r'(?<![A-Z0-9-])[A-Z0-9]{4,8}-[A-Z0-9]{4,8}(?![A-Z0-9-])')
RATE_LIMITED = re.compile(r'\b429\b|too many requests|rate[ -]?limit', re.IGNORECASE)
CLAUDE_CODE = re.compile(r'[A-Za-z0-9#_.~-]{8,1024}')

def provider(value):
    require(value in PROVIDERS, 'provider_login_provider')
    return value


def configuration(package, name):
    """Sealed package facts only: no caller selects a path, argument or home."""
    if name == 'codex':
        return dict(executable=str(package.root / 'native'),
                    auth_file=package.profile['auth_file'])
    if package.claude is None:
        return None
    value = metadata(package.root / 'claude-private.json')
    return dict(executable=value['executable'], account=value['account'], home=value['home'])


def available(package, name):
    if not package.identity_split or 'managed_host' not in package.beta:
        return False, 'unsupported'
    return (True, None) if configuration(package, name) is not None else (False, 'not_configured')


def link_allowed(name, link):
    return type(link) is str and LINKS[provider(name)].fullmatch(link) is not None


def code_allowed(name, code):
    return type(code) is str and (DEVICE_CODE.fullmatch(code) if name == 'codex'
                                  else CLAUDE_CODE.fullmatch(code)) is not None


class Parser:
    """Closed extraction from untrusted CLI output: link and device code only."""

    def __init__(self, name):
        self.name, self.raw, self.link, self.code, self.reported = name, '', None, None, False

    def feed(self, data):
        """Return one progress view the first time the prompt is complete."""
        if len(self.raw) < OUTPUT_LIMIT:
            self.raw += data.decode('utf-8', 'replace')
        text = ANSI.sub(' ', self.raw)
        if self.link is None and (match := LINKS[self.name].search(text)):
            self.link = match.group(0)
        if self.name == 'codex' and self.code is None and self.link is not None:
            after = text[text.find(self.link) + len(self.link):]
            if match := DEVICE_CODE.search(after):
                self.code = match.group(0)
        if not self.reported and self.link is not None and (self.name == 'claude' or self.code):
            self.reported = True
            return dict(state='waiting', link=self.link, code=self.code)
        return None

    def rate_limited(self):
        return RATE_LIMITED.search(ANSI.sub(' ', self.raw)) is not None


def login_command(config, name, home):
    if name == 'codex':
        return ([config['executable'], 'login', '--device-auth'],
                dict(base_environment(home), CODEX_HOME=str(home / 'codex')))
    return ([config['executable'], 'auth', 'login'],
            dict(base_environment(home), CLAUDE_CONFIG_DIR=str(home / 'claude'),
                 TERM='dumb', BROWSER='/bin/false'))


def base_environment(home):
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(home), 'NO_COLOR': '1'}


def claude_status_command(config):
    return ([config['executable'], 'auth', 'status', '--json'],
            dict(base_environment(config['home']), CLAUDE_CONFIG_DIR=config['account'],
                 BROWSER='/bin/false', TERM='dumb'))


def claude_signout_command(config):
    return ([config['executable'], 'auth', 'logout'],
            dict(base_environment(config['home']), CLAUDE_CONFIG_DIR=config['account'],
                 BROWSER='/bin/false', TERM='dumb'))


def encode(value):
    raw = json.dumps(value, separators=(',', ':'), allow_nan=False).encode()
    require(len(raw) <= MAX_FRAME, 'provider_login_frame')
    return struct.pack('!I', len(raw)) + raw


def now_ms():
    return time.time_ns() // 1_000_000


class Handle:
    def __init__(self, name, mode, child, identity, channel, deadline):
        self.name, self.mode, self.child, self.identity = name, mode, child, identity
        self.channel, self.deadline = channel, deadline
        self.started = time.monotonic()
        self.state, self.link, self.code, self.reason = 'starting', None, None, None
        self.buffer = bytearray()
        self.final = None
        self.cancel_requested = False

    def view(self):
        value = dict(state=self.state)
        if self.state in ('waiting', 'verifying') and self.link is not None:
            value.update(link=self.link, expires_in_s=max(0, int(self.deadline - time.monotonic())))
            if self.code is not None:
                value['code'] = self.code
        if self.reason is not None:
            value['reason'] = self.reason
        return value


class Operations:
    """One login per provider; never touches a credential from Root."""

    def __init__(self, package, spawn=None):
        require(os.geteuid() == 0 and package.identity_split, 'provider_login_root_split')
        self.package, self.spawn = package, spawn or self._spawn
        self.active, self.probes, self.status, self.finished = {}, {}, {}, {}
        self.starts = {name: [] for name in PROVIDERS}

    def _spawn(self, fd):
        parent = process(os.getpid())
        interpreter = str(Path('/usr/bin/python3').resolve())
        return subprocess.Popen([interpreter, '-I', '-S', '-B', str(self.package.root / 'codex_service/entry.py'),
                                 'provider-login-anchor', str(fd), str(parent['pid']), str(parent['start'])],
                                pass_fds=(fd,), cwd='/', env={'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1'},
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def _launch(self, name, mode, seconds):
        parent, child = socket.socketpair()
        handle = None
        try:
            handle = self.spawn(child.fileno())
            child.close()
            parent.sendall(encode(dict(provider=name, mode=mode,
                                       deadline_ns=time.monotonic_ns() + seconds * 1_000_000_000)))
            parent.setblocking(False)
            identity = process(handle.pid)
            require(identity is not None and identity['ppid'] == os.getpid() and identity['uid'] == 0,
                    'provider_login_anchor_identity')
            return Handle(name, mode, handle, identity, parent, time.monotonic() + seconds)
        except BaseException:
            parent.close()
            child.close()
            if handle is not None and handle.poll() is None:
                handle.kill()
                handle.wait()
            raise

    def children(self):
        return {(h.identity['pid'], h.identity['start'])
                for h in [*self.active.values(), *self.probes.values()] if h.identity}

    def start(self, name):
        if not available(self.package, name)[0]:
            return 'unavailable'
        if name in self.active:
            return 'in_progress'
        now = time.monotonic()
        recent = [at for at in self.starts[name] if now - at < 3600]
        self.starts[name] = recent
        if (recent and now - recent[-1] < START_INTERVAL) or len(recent) >= STARTS_PER_HOUR:
            return 'rate_limited'
        recent.append(now)
        self.finished.pop(name, None)
        self.active[name] = self._launch(name, 'login', LOGIN_SECONDS)
        return 'started'

    def submit(self, name, code):
        handle = self.active.get(name)
        if name != 'claude' or handle is None or handle.mode != 'login' or handle.state != 'waiting' \
                or not code_allowed(name, code):
            return 'refused'
        raw = code.encode()
        self._control(handle, b'S' + struct.pack('!I', len(raw)) + raw)
        handle.state = 'verifying'
        return 'accepted'

    def cancel(self, name):
        handle = self.active.get(name)
        if handle is None or handle.mode != 'login':
            return 'noop'
        if not handle.cancel_requested:
            handle.cancel_requested = True
            self._control(handle, b'C')
        return 'accepted'

    def sign_out(self, name):
        if not available(self.package, name)[0]:
            return 'unavailable'
        if name in self.active:
            return 'in_progress'
        self.finished.pop(name, None)
        self.active[name] = self._launch(name, 'signout', SIGNOUT_SECONDS)
        return 'started'

    def _control(self, handle, raw):
        try:
            handle.channel.send(raw)
        except OSError:
            pass  # The anchor's own deadline still ends the operation.

    def _probe(self, name):
        cached = self.status.get(name)
        if name in self.probes or name in self.active:
            return
        if cached is not None and time.monotonic() - cached['at'] < STATUS_TTL:
            return
        if not available(self.package, name)[0]:
            return
        try:
            self.probes[name] = self._launch(name, 'status', STATUS_SECONDS)
        except Exception:
            self.status[name] = dict(at=time.monotonic(), value=dict(signed_in=None), checked_at_ms=now_ms())

    def public(self, name):
        ok, reason = available(self.package, name)
        if not ok:
            return dict(provider=name, available=False, reason=reason)
        cached = self.status.get(name)
        result = dict(provider=name, available=True,
                      signed_in=cached['value'].get('signed_in') if cached else None,
                      method=cached['value'].get('method') if cached else None,
                      account=cached['value'].get('account') if cached else None,
                      subscription=cached['value'].get('subscription') if cached else None,
                      checked_at_ms=cached['checked_at_ms'] if cached else None, login=None)
        handle = self.active.get(name)
        if handle is not None and handle.mode == 'login':
            result['login'] = handle.view()
        elif name in self.finished and time.monotonic() - self.finished[name]['at'] < FINISHED_RETAIN:
            result['login'] = self.finished[name]['view']
        return result

    def overview(self, result):
        return dict(result=result, providers=[self.public(name) for name in PROVIDERS])

    def refresh(self):
        self.tick()
        for name in PROVIDERS:
            self._probe(name)

    def _frames(self, handle):
        while True:
            try:
                raw = handle.channel.recv(4096)
            except BlockingIOError:
                break
            except OSError:
                raw = b''
            if not raw:
                break
            handle.buffer += raw
            require(len(handle.buffer) <= 4 * MAX_FRAME, 'provider_login_frame')
            while len(handle.buffer) >= 4:
                length = struct.unpack('!I', handle.buffer[:4])[0]
                require(0 < length <= MAX_FRAME, 'provider_login_frame')
                if len(handle.buffer) < 4 + length:
                    break
                payload = bytes(handle.buffer[4:4 + length])
                del handle.buffer[:4 + length]
                self._frame(handle, json.loads(payload))

    def _frame(self, handle, value):
        require(type(value) is dict, 'provider_login_frame')
        if value.get('final') is True and handle.mode == 'status':
            status = value['status']
            require(type(status) is dict and type(status.get('signed_in')) is bool
                    and all(type(status.get(k)) in (str, type(None)) for k in ('method', 'account', 'subscription')),
                    'provider_login_status_shape')
            handle.final = dict(status=status)
        elif value.get('final') is True:
            require(value['state'] in TERMINAL and value.get('reason') in (None, *REASONS),
                    'provider_login_frame')
            # Applied by _finish only after the anchor has exited, so a terminal
            # state is never visible while this provider still counts as busy.
            handle.final = dict(state=value['state'], reason=value.get('reason'))
        elif value.get('state') == 'waiting':
            require(link_allowed(handle.name, value['link'])
                    and (value['code'] is None or code_allowed(handle.name, value['code'])), 'provider_login_frame')
            handle.state, handle.link, handle.code = 'waiting', value['link'], value['code']
        elif value.get('state') == 'verifying':
            handle.state = 'verifying'
        else:
            require(False, 'provider_login_frame')

    def tick(self):
        """Never lets one sign-in's fault reach the manager's own control loop."""
        for table in (self.active, self.probes):
            for name, handle in list(table.items()):
                try:
                    self._tick_one(table, name, handle)
                except Exception:
                    self._abandon(table, name, handle)

    def _tick_one(self, table, name, handle):
        self._frames(handle)
        if time.monotonic() >= handle.deadline and not handle.cancel_requested:
            handle.cancel_requested = True
            self._control(handle, b'C')
        if handle.child.poll() is None:
            if time.monotonic() >= handle.deadline + 30:
                handle.child.kill()
            return
        self._frames(handle)
        table.pop(name, None)
        handle.channel.close()
        self._finish(handle)

    def _finish(self, handle):
        if handle.mode == 'status':
            value = handle.final['status'] if handle.final else dict(signed_in=None)
            self.status[handle.name] = dict(at=time.monotonic(), value=value, checked_at_ms=now_ms())
            return
        self.status.pop(handle.name, None)
        final = handle.final or dict(state='failed', reason='internal')
        handle.state, handle.reason, handle.link, handle.code = final['state'], final['reason'], None, None
        if handle.mode == 'login':
            self.finished[handle.name] = dict(at=time.monotonic(), view=handle.view())

    def _abandon(self, table, name, handle):
        table.pop(name, None)
        try:
            handle.channel.close()
            if handle.child.poll() is None:
                handle.child.kill()
                handle.child.wait(timeout=2)
        except Exception:
            pass  # The orphan sweep still owns any remaining descendant.
        if handle.mode == 'login':
            handle.state, handle.reason, handle.link, handle.code = 'failed', 'internal', None, None
            self.finished[handle.name] = dict(at=time.monotonic(), view=handle.view())
        elif handle.mode == 'status':
            self.status[handle.name] = dict(at=time.monotonic(), value=dict(signed_in=None), checked_at_ms=now_ms())

    def close(self):
        for handle in [*self.active.values(), *self.probes.values()]:
            self._control(handle, b'C')
        until = time.monotonic() + 4
        while (self.active or self.probes) and time.monotonic() < until:
            self.tick()
            time.sleep(.02)
        survivors = [*self.active.values(), *self.probes.values()]
        for handle in survivors:
            try:
                handle.child.kill()
                handle.child.wait(timeout=2)
            except Exception:
                pass  # Shutdown reports the failure below and keeps closing.
        self.active.clear()
        self.probes.clear()
        return not survivors


def dispatch(manager, request):
    """Only the kernel-authenticated Core peer reaches this through Manager."""
    require(manager.package.identity_split, 'provider_login_unavailable')
    try:
        if manager.provider_login is None:
            manager.provider_login = Operations(manager.package)
        operations = manager.provider_login
        operation = request['operation']
        if operation == 'provider_login_status':
            operations.refresh()
            result = 'status'
        else:
            name = provider(request['provider'])
            if operation != 'provider_login_cancel':
                manager._package_preflight()
            if operation == 'provider_login_start':
                result = operations.start(name)
            elif operation == 'provider_login_code':
                result = operations.submit(name, request['code'])
            elif operation == 'provider_login_cancel':
                result = operations.cancel(name)
            else:
                result = operations.sign_out(name)
            operations.tick()
        return {'ok': True, 'receipt': manager.ledger.status(request['conversation_id']),
                'provider_login': operations.overview(result)}
    except Refused:
        raise
    except Exception:
        # Manager's control loop stops on anything but a Refused: a sign-in
        # fault must never take the service down with it.
        raise Refused('provider_login_internal') from None
