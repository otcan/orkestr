"""Browser setup service for an unconfigured container. Runs as UID 10001.

Started only by runtime.py while /state/owner.json is absent and reachable only
through the setup proxy (nginx-setup.conf) at /api/v2/oss-setup/. Every request
must carry the signed-in owner's browser session; state-changing requests also
need the exact Origin and the session's CSRF token, verified against the local
server. Responses only ever contain booleans, a fixed state word, and for an
active provider login its official sign-in link and one-time device code: never
provider tokens, the bootstrap token or CLI output.

The root side is a closed request file (/state/setup/configure.json) that PID1
validates, re-checks and applies; this process has no capabilities.
"""
import http.server
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

STATE = Path('/state')
SETUP = STATE / 'setup'
SOCKET = SETUP / 'setup.sock'
PROVIDERS = Path('/opt/orkestr/providers')
SERVER = 'http://127.0.0.1:19822'
ORIGIN = 'http://127.0.0.1:19822'
PREFIX = '/api/v2/oss-setup/'
LOGIN_SECONDS = 15 * 60
START_INTERVAL = 30          # seconds between login starts, per provider
STARTS_PER_HOUR = 6          # per provider
OUTPUT_LIMIT = 64 * 1024
ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')
LINKS = {
    'codex': re.compile(r'https://auth\.openai\.com/[A-Za-z0-9/._-]{1,200}'),
    'claude': re.compile(r'https://claude\.com/cai/oauth/authorize\?[A-Za-z0-9%&=_.+~-]{1,4000}'),
}
DEVICE_CODE = re.compile(r'(?<![A-Z0-9-])[A-Z0-9]{4,8}-[A-Z0-9]{4,8}(?![A-Z0-9-])')
# A refused sign-in is reported as one fixed reason word, never as CLI output.
UPSTREAM_RATE_LIMITED = re.compile(r'\b429\b|too many requests|rate[ -]?limit', re.IGNORECASE)
CLAUDE_CODE = re.compile(r'[A-Za-z0-9#_.~-]{8,1024}')


def environment(provider):
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/credentials/home',
           'CODEX_HOME': '/credentials/codex', 'PYTHONDONTWRITEBYTECODE': '1', 'NO_COLOR': '1'}
    if provider == 'claude':
        env.update(CLAUDE_CONFIG_DIR='/credentials/claude', TERM='dumb', BROWSER='/bin/false')
    return env


def signed_in(provider):
    argv = [str(PROVIDERS / provider)] + (['login', 'status'] if provider == 'codex' else ['auth', 'status'])
    try:
        result = subprocess.run(argv, env=environment(provider), cwd='/credentials/home',
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return False
    if result.returncode != 0:
        return False
    if provider == 'claude':
        try:
            return json.loads(result.stdout).get('loggedIn') is True
        except (ValueError, AttributeError):
            return False
    return True


class Login:
    """One official CLI sign-in. Holds output privately; exposes link + code only."""

    def __init__(self, provider):
        self.provider = provider
        self.started = time.monotonic()
        self.output = ''
        self.state = 'starting'
        self.link = None
        self.code = None
        self.terminal = None
        self.reason = None
        argv = [str(PROVIDERS / provider)] + (['login', '--device-auth'] if provider == 'codex' else ['auth', 'login'])
        if provider == 'claude':
            # Claude asks for the browser's code at a prompt: give it a private pty.
            master, slave = os.openpty()
            self.terminal = master
            streams = {'stdin': slave, 'stdout': slave, 'stderr': slave}
        else:
            master = None
            streams = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.PIPE, 'stderr': subprocess.STDOUT}
        try:
            self.process = subprocess.Popen(argv, env=environment(provider), cwd='/credentials/home',
                                            start_new_session=True, close_fds=True, **streams)
        finally:
            if provider == 'claude':
                os.close(slave)
        source = master if provider == 'claude' else self.process.stdout.fileno()
        threading.Thread(target=self.read, args=(source,), daemon=True).start()

    def read(self, fd):
        while True:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            if len(self.output) < OUTPUT_LIMIT:
                self.output += data.decode('utf-8', 'replace')
                self.parse()
        self.process.wait()
        if self.state not in ('expired', 'cancelled'):
            self.state = 'finished' if self.process.returncode == 0 else 'failed'
            if self.state == 'failed' and UPSTREAM_RATE_LIMITED.search(ANSI.sub(' ', self.output)):
                self.reason = 'upstream_rate_limited'

    def parse(self):
        text = ANSI.sub(' ', self.output)
        if self.link is None:
            match = LINKS[self.provider].search(text)
            if match:
                self.link = match.group(0)
        if self.provider == 'codex' and self.code is None and self.link is not None:
            after = text[text.find(self.link) + len(self.link):]
            match = DEVICE_CODE.search(after)
            if match:
                self.code = match.group(0)
        if self.link is not None and (self.provider == 'claude' or self.code is not None) \
                and self.state == 'starting':
            self.state = 'waiting'

    def submit(self, code):
        if self.provider != 'claude' or self.state != 'waiting' or not CLAUDE_CODE.fullmatch(code):
            return False
        os.write(self.terminal, code.encode() + b'\r')
        self.state = 'verifying'
        return True

    def stop(self, state):
        if self.process.poll() is None:
            self.state = state
            try:
                os.killpg(self.process.pid, 9)
            except OSError:
                pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass

    def expire(self):
        if time.monotonic() - self.started > LOGIN_SECONDS:
            self.stop('expired')

    def public(self):
        self.expire()
        value = {'state': self.state}
        if self.state == 'failed' and self.reason:
            value['reason'] = self.reason
        if self.state in ('waiting', 'verifying'):
            value['link'] = self.link
            if self.code is not None:
                value['code'] = self.code
            value['expires_in'] = max(0, int(LOGIN_SECONDS - (time.monotonic() - self.started)))
        return value


class Setup:
    def __init__(self):
        self.lock = threading.Lock()
        self.logins = {}
        self.starts = {'codex': [], 'claude': []}
        self.signed = {}
        self.configuring = False

    def is_signed_in(self, provider, fresh=False):
        cached = self.signed.get(provider)
        if not fresh and cached and time.monotonic() - cached[1] < 5:
            return cached[0]
        value = signed_in(provider)
        self.signed[provider] = (value, time.monotonic())
        return value

    def status(self):
        error = SETUP / 'configure-error'
        value = {'configured': False, 'configuring': self.configuring,
                 'error': error.read_text()[:200] if error.is_file() else None, 'providers': {}}
        for provider in ('codex', 'claude'):
            login = self.logins.get(provider)
            active = login.public() if login else None
            value['providers'][provider] = {'signed_in': self.is_signed_in(provider, bool(
                active and active['state'] == 'finished')), 'login': active}
        return value

    def start(self, provider):
        with self.lock:
            now = time.monotonic()
            current = self.logins.get(provider)
            if current and current.process.poll() is None:
                return 409, {'error': 'login_in_progress'}
            recent = [t for t in self.starts[provider] if now - t < 3600]
            self.starts[provider] = recent
            if recent and now - recent[-1] < START_INTERVAL or len(recent) >= STARTS_PER_HOUR:
                return 429, {'error': 'rate_limited', 'retry_after': START_INTERVAL}
            if self.is_signed_in(provider, True):
                return 409, {'error': 'already_signed_in'}
            recent.append(now)
            self.logins[provider] = Login(provider)
            return 202, {'login': self.logins[provider].public()}

    def submit(self, code):
        login = self.logins.get('claude')
        if login is None or not isinstance(code, str) or not login.submit(code.strip()):
            return 400, {'error': 'code_refused'}
        return 202, {'login': login.public()}

    def cancel(self, provider):
        login = self.logins.get(provider)
        if login:
            login.stop('cancelled')
        return 200, {'cancelled': True}

    def configure(self, session, body, host):
        if not (isinstance(body.get('username'), str) and isinstance(body.get('password'), str)
                and 0 < len(body['username']) <= 256 and 0 < len(body['password']) <= 1024):
            return 400, {'error': 'credentials_required'}
        if not self.is_signed_in('codex', True):
            return 409, {'error': 'provider_login_required'}
        credentials = {'username': body['username'], 'password': body['password']}
        try:
            machine = server('POST', '/api/v2/machine/session', credentials, {'Host': host})
        except urllib.error.HTTPError as error:
            return (401, {'error': 'credentials_refused'}) if error.code in (401, 403) else (502, {'error': 'server_refused'})
        except (urllib.error.URLError, OSError, ValueError):
            return 502, {'error': 'server_refused'}
        if not isinstance(machine, dict) or not isinstance(machine.get('token'), str):
            return 502, {'error': 'server_refused'}
        # The typed credentials must be the same owner as the signed-in browser.
        if machine.get('global_conversation_id') != session['global_conversation_id']:
            return 403, {'error': 'owner_mismatch'}
        request = {'owner_id': session['owner_id'], 'conversation_id': session['global_conversation_id'],
                   'machine_token': machine['token']}
        (SETUP / 'configure-error').unlink(missing_ok=True)
        temporary = SETUP / ('.configure-' + uuid.uuid4().hex)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(request, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.rename(temporary, SETUP / 'configure.json')
        self.configuring = True
        return 202, {'configuring': True}


def server(method, path, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(SERVER + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json', **(headers or {})})
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'orkestr-setup'
    sys_version = ''

    def log_message(self, *_):
        pass  # Never log request lines, cookies or bodies.

    def address_string(self):
        return 'setup'

    def reply(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def session(self):
        """The owner's browser session, verified by the local server."""
        cookie = self.headers.get('Cookie')
        host = self.headers.get('Host')
        if not cookie or not host or self.headers.get('Authorization'):
            return None
        try:
            value = server('GET', '/api/v2/browser/session', None, {'Cookie': cookie, 'Host': host})
        except (urllib.error.URLError, OSError, ValueError):
            return None
        if not isinstance(value, dict) or not isinstance(value.get('csrf_token'), str):
            return None
        return value

    def dispatch(self, method):
        setup = self.server.setup
        if (STATE / 'owner.json').exists():
            return self.reply(410, {'configured': True})
        path = self.path.split('?', 1)[0]
        if not path.startswith(PREFIX):
            return self.reply(404, {'error': 'not_found'})
        route = path[len(PREFIX):]
        session = self.session()
        if session is None:
            return self.reply(401, {'error': 'sign_in_required'})
        if method == 'GET':
            return self.reply(200, setup.status()) if route == 'status' else self.reply(404, {'error': 'not_found'})
        if self.headers.get('Origin') != ORIGIN or self.headers.get('x-orkestr-csrf') != session['csrf_token']:
            return self.reply(403, {'error': 'csrf_rejected'})
        length = self.headers.get('Content-Length', '0')
        if not length.isdigit() or int(length) > 4096:
            return self.reply(413, {'error': 'body_too_large'})
        try:
            body = json.loads(self.rfile.read(int(length)) or b'{}')
        except ValueError:
            return self.reply(400, {'error': 'json_required'})
        if not isinstance(body, dict):
            return self.reply(400, {'error': 'json_required'})
        if setup.configuring:
            return self.reply(409, {'error': 'configuring'})
        routes = {
            'login/codex/start': lambda: setup.start('codex'),
            'login/claude/start': lambda: setup.start('claude'),
            'login/claude/code': lambda: setup.submit(body.get('code')),
            'login/codex/cancel': lambda: setup.cancel('codex'),
            'login/claude/cancel': lambda: setup.cancel('claude'),
            'configure': lambda: setup.configure(session, body, self.headers.get('Host')),
        }
        if route not in routes:
            return self.reply(404, {'error': 'not_found'})
        status, value = routes[route]()
        return self.reply(status, value)

    def do_GET(self):
        self.dispatch('GET')

    def do_POST(self):
        self.dispatch('POST')


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        connection, _ = super().get_request()
        connection.settimeout(30)
        return connection, ('setup', 0)


def main():
    if os.geteuid() == 0 or not sys.flags.isolated or not sys.dont_write_bytecode:
        raise SystemExit('setup service must run isolated as the provider UID')
    os.umask(0o077)
    SOCKET.unlink(missing_ok=True)
    httpd = Server(str(SOCKET), Handler)
    httpd.setup = Setup()
    httpd.serve_forever()


if __name__ == '__main__':
    main()
