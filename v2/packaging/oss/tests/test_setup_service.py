"""Browser setup service: link + code only, rate limits, inert once configured."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('oss_' + name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


service = load('setup_service')


def parsed(provider, output):
    login = object.__new__(service.Login)
    login.provider, login.output, login.state, login.link, login.code = provider, output, 'starting', None, None
    login.parse()
    return login


class FakeProcess:
    pid = 0
    returncode = None
    def poll(self):
        return self.returncode
    def wait(self, timeout=None):
        self.returncode = -9


class FakeLogin:
    def __init__(self, provider):
        self.provider, self.state, self.process = provider, 'waiting', FakeProcess()
    def public(self):
        return {'state': self.state, 'link': 'https://auth.openai.com/codex/device', 'code': 'ABCD-EFGH1', 'expires_in': 900}
    def stop(self, state):
        self.state = state
        self.process.returncode = -9


class LoginParsingTests(unittest.TestCase):
    CODEX = ('Welcome to Codex [v\x1b[90m0.163.0\x1b[0m]\n1. Open this link in your browser and sign in\n'
             '   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n2. Enter this one-time code '
             '\x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mABCD-EFGH1\x1b[0m\n')

    def test_codex_device_link_and_code(self):
        login = parsed('codex', self.CODEX)
        self.assertEqual((login.link, login.code, login.state), ('https://auth.openai.com/codex/device', 'ABCD-EFGH1', 'waiting'))

    def test_codex_without_code_keeps_starting(self):
        self.assertEqual(parsed('codex', self.CODEX.split('2.')[0]).state, 'starting')

    def test_foreign_links_are_never_surfaced(self):
        login = parsed('codex', 'visit https://evil.example/codex/device code ABCD-EFGH\n')
        self.assertIsNone(login.link)
        login = parsed('claude', "visit: https://claude.com.evil.example/cai/oauth/authorize?x=1\n")
        self.assertIsNone(login.link)

    def test_claude_hyperlink_is_extracted_once(self):
        url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz'
        login = parsed('claude', f"If the browser didn't open, visit: \x1b]8;;{url}\x1b\\{url}\x1b]8;;\x1b\\\nPaste code here if prompted >")
        self.assertEqual((login.link, login.state), (url, 'waiting'))

    def test_public_view_has_only_state_link_code(self):
        login = parsed('codex', self.CODEX + 'secret-looking-output sk-abc\n')
        login.started = service.time.monotonic()
        login.process = FakeProcess()
        self.assertEqual(set(login.public()), {'state', 'link', 'code', 'expires_in'})
        self.assertNotIn('sk-abc', json.dumps(login.public()))


    def finished(self, output, returncode):
        login = parsed('codex', '')
        login.started, login.reason = service.time.monotonic(), None
        login.process = FakeProcess()
        login.process.wait = lambda timeout=None: setattr(login.process, 'returncode', returncode)
        read, write = os.pipe()
        os.write(write, output.encode())
        os.close(write)
        login.read(read)
        os.close(read)
        return login.public()

    def test_upstream_rate_limit_is_a_fixed_reason_only(self):
        value = self.finished('Error: request failed: 429 Too Many Requests (req-id abc123)\n', 1)
        self.assertEqual(value, {'state': 'failed', 'reason': 'upstream_rate_limited'})
        self.assertEqual(self.finished('Error: network unreachable\n', 1), {'state': 'failed'})
        self.assertEqual(self.finished('Successfully logged in\n', 0), {'state': 'finished'})

class SetupTests(unittest.TestCase):
    def setUp(self):
        self.setup = service.Setup()
        patcher = patch.object(service, 'Login', FakeLogin)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(service, 'signed_in', return_value=False)
        self.signed = patcher.start()
        self.addCleanup(patcher.stop)

    def test_one_login_at_a_time_and_rate_limited(self):
        self.assertEqual(self.setup.start('codex')[0], 202)
        self.assertEqual(self.setup.start('codex'), (409, {'error': 'login_in_progress'}))
        self.setup.cancel('codex')
        self.assertEqual(self.setup.start('codex')[0], 429)
        # Claude has its own budget.
        self.assertEqual(self.setup.start('claude')[0], 202)

    def test_hourly_cap(self):
        clock = [1000.0]
        with patch.object(service.time, 'monotonic', side_effect=lambda: clock[0]):
            for _ in range(service.STARTS_PER_HOUR):
                self.assertEqual(self.setup.start('codex')[0], 202)
                self.setup.cancel('codex')
                clock[0] += service.START_INTERVAL + 1
            self.assertEqual(self.setup.start('codex')[0], 429)
            clock[0] += 3600
            self.assertEqual(self.setup.start('codex')[0], 202)

    def test_signed_in_provider_needs_no_new_login(self):
        self.signed.return_value = True
        self.assertEqual(self.setup.start('codex'), (409, {'error': 'already_signed_in'}))

    def test_configure_requires_codex_and_matching_owner(self):
        session = {'owner_id': '7c0b5a59-58b2-4f0e-9d55-3a6b0a8c2f11', 'global_conversation_id': 'c-1', 'csrf_token': 'x'}
        body = {'username': 'owner', 'password': 'synthetic-password'}
        self.assertEqual(self.setup.configure(session, body, '127.0.0.1:19822')[0], 409)
        self.signed.return_value = True
        self.assertEqual(self.setup.configure(session, {}, '127.0.0.1:19822')[0], 400)
        with tempfile.TemporaryDirectory() as scratch, patch.object(service, 'SETUP', Path(scratch)):
            with patch.object(service, 'server', return_value={'global_conversation_id': 'other', 'token': 't' * 64}):
                self.assertEqual(self.setup.configure(session, body, '127.0.0.1:19822'), (403, {'error': 'owner_mismatch'}))
            self.assertFalse((Path(scratch) / 'configure.json').exists())
            with patch.object(service, 'server', return_value={'global_conversation_id': 'c-1', 'token': 't' * 64}):
                self.assertEqual(self.setup.configure(session, body, '127.0.0.1:19822')[0], 202)
            request = json.loads((Path(scratch) / 'configure.json').read_text())
            self.assertEqual(set(request), {'owner_id', 'conversation_id', 'machine_token'})
            self.assertNotIn('synthetic-password', json.dumps(request))
            self.assertEqual(os.stat(Path(scratch) / 'configure.json').st_mode & 0o777, 0o600)


class HandlerTests(unittest.TestCase):
    def handle(self, method, path, headers, body=b'', state=None, session=None):
        handler = object.__new__(service.Handler)
        handler.server = type('S', (), {'setup': service.Setup()})()
        handler.path, handler.headers = path, headers
        handler.rfile, handler.wfile = io.BytesIO(body), io.BytesIO()
        replies = []
        handler.reply = lambda status, value: replies.append((status, value))
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            if state:
                (root / 'owner.json').write_text('{}')
            with patch.object(service, 'STATE', root), patch.object(handler, 'session', return_value=session), \
                    patch.object(service, 'signed_in', return_value=False):
                handler.dispatch(method)
        return replies[0]

    SESSION = {'owner_id': 'o', 'global_conversation_id': 'c', 'csrf_token': 'csrf'}

    def test_inert_once_configured(self):
        self.assertEqual(self.handle('GET', '/api/v2/oss-setup/status', {}, state=True, session=self.SESSION)[0], 410)
        self.assertEqual(self.handle('POST', '/api/v2/oss-setup/login/codex/start', {}, state=True, session=self.SESSION)[0], 410)
        with patch.dict(service.os.environ, {'ORKESTR_OSS_LOCAL_BOOTSTRAP': 'synthetic-local-bootstrap'}):
            self.assertEqual(self.handle('POST', '/api/v2/oss-setup/account', {}, state=True)[0], 410)

    def test_local_account_is_disabled_by_default_before_session_check(self):
        with patch.dict(service.os.environ, {'ORKESTR_OSS_LOCAL_BOOTSTRAP': ''}):
            self.assertEqual(self.handle('GET', '/api/v2/oss-setup/account', {})[0], 404)

    def test_local_account_without_session_forwards_only_to_first_owner_setup(self):
        headers = {'Host': '127.0.0.1:19822', 'x-orkestr-local-setup': '1'}
        with patch.dict(service.os.environ, {'ORKESTR_OSS_LOCAL_BOOTSTRAP': 'synthetic-local-bootstrap'}), \
                patch.object(service, 'server', return_value={'setup_required': True}) as upstream:
            self.assertEqual(self.handle('GET', '/api/v2/oss-setup/account', headers),
                             (200, {'setup_required': True}))
            self.assertEqual(upstream.call_args.args[:2], ('GET', '/api/v2/setup'))

    def test_session_required(self):
        self.assertEqual(self.handle('GET', '/api/v2/oss-setup/status', {})[0], 401)

    def test_post_requires_origin_and_csrf(self):
        for headers in ({}, {'Origin': service.ORIGIN}, {'Origin': 'http://evil.example', 'x-orkestr-csrf': 'csrf'},
                        {'Origin': service.ORIGIN, 'x-orkestr-csrf': 'wrong'}):
            with self.subTest(headers=headers):
                self.assertEqual(self.handle('POST', '/api/v2/oss-setup/login/codex/start', headers,
                                             session=self.SESSION)[0], 403)

    def test_status_shape(self):
        status, value = self.handle('GET', '/api/v2/oss-setup/status', {}, session=self.SESSION)
        self.assertEqual(status, 200)
        self.assertEqual(set(value), {'configured', 'configuring', 'error', 'providers'})
        self.assertEqual(value['providers']['codex'], {'signed_in': False, 'login': None})

    def test_unknown_route_and_oversized_body(self):
        headers = {'Origin': service.ORIGIN, 'x-orkestr-csrf': 'csrf', 'Content-Length': '5000'}
        self.assertEqual(self.handle('POST', '/api/v2/oss-setup/configure', headers, session=self.SESSION)[0], 413)
        headers['Content-Length'] = '2'
        self.assertEqual(self.handle('POST', '/api/v2/oss-setup/shell', headers, b'{}', session=self.SESSION)[0], 404)


class BrowserConfigurationTests(unittest.TestCase):
    def run_request(self, value, uid=None, claude=False, codex=True):
        runtime = load('runtime')
        written = {}
        with tempfile.TemporaryDirectory() as scratch:
            setup = Path(scratch) / 'setup'
            setup.mkdir()
            (setup / 'configure.json').write_text(value if isinstance(value, str) else json.dumps(value))
            with patch.object(runtime, 'STATE', Path(scratch)), patch.object(runtime, 'SETUP', setup), \
                    patch.object(runtime, 'UID', os.getuid() if uid is None else uid), \
                    patch.object(runtime, 'logged_in', side_effect=lambda p: codex if p == 'codex' else claude), \
                    patch.object(runtime, 'write_private', side_effect=lambda path, value, uid=0: written.update({path.name: value})), \
                    patch('sys.stdout', new=io.StringIO()), patch('sys.stderr', new=io.StringIO()):
                self.assertTrue(runtime.browser_configuration())
                self.assertFalse((setup / 'configure.json').exists())
        return written

    GOOD = {'owner_id': '7c0b5a59-58b2-4f0e-9d55-3a6b0a8c2f11', 'conversation_id': 'c-1', 'machine_token': 'a' * 64}

    def test_valid_request_writes_owner_scope_and_decides_claude_itself(self):
        written = self.run_request(self.GOOD, claude=True)
        self.assertEqual(json.loads(written['owner.json']),
                         {'owner_id': self.GOOD['owner_id'], 'conversation_id': 'c-1', 'claude': True})
        self.assertEqual(written['timer.token'], 'a' * 64)

    def test_refusals_write_only_the_error(self):
        for value, kwargs in ((dict(self.GOOD, claude=True), {}), ({**self.GOOD, 'owner_id': 'not-a-uuid'}, {}),
                              ({**self.GOOD, 'machine_token': 'short'}, {}), ('not json', {}),
                              (self.GOOD, {'uid': os.getuid() + 1}), (self.GOOD, {'codex': False})):
            with self.subTest(value=value, kwargs=kwargs):
                self.assertEqual(set(self.run_request(value, **kwargs)), {'configure-error'})

    def test_no_request_is_a_no_op(self):
        runtime = load('runtime')
        with tempfile.TemporaryDirectory() as scratch, patch.object(runtime, 'SETUP', Path(scratch)):
            self.assertFalse(runtime.browser_configuration())


if __name__ == '__main__':
    unittest.main()
