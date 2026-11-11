"""Provider sign-in against a fake CLI: synthetic data, no real account or token."""
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from codex_service import provider_login as login
from codex_service import provider_login_anchor as anchor
from codex_service.contract import Refused, decode

OWNER = '11111111-1111-4111-8111-111111111111'
CHAT = '22222222-2222-4222-8222-222222222222'
TOKEN = 'synthetic-access-token-must-not-leak'
CODEX_AUTH = dict(OPENAI_API_KEY=None, last_refresh='2026-01-01T00:00:00Z',
                  tokens=dict(access_token=TOKEN, refresh_token='synthetic-refresh-must-not-leak',
                              id_token='synthetic-id', account_id='synthetic-account'))
CLAUDE_CREDENTIAL = dict(claudeAiOauth=dict(accessToken=TOKEN, refreshToken='synthetic-refresh-must-not-leak',
                                            expiresAt=9999999999000, scopes=['user:inference']))
FAKE_CLI = r'''#!/usr/bin/python3 -ISB
import json, os, sys, time
from pathlib import Path
scenario = Path(__file__).with_name('scenario').read_text().strip()
Path(__file__).with_name('argv').write_text(json.dumps({'argv': sys.argv[1:], 'uid': os.geteuid(), 'env': {
    k: v for k, v in os.environ.items() if k in ('HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'BROWSER')}}))
if sys.argv[1:] == ['login', '--device-auth']:
    print('Welcome to Codex\n1. Open this link\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m', flush=True)
    print('2. Enter this one-time code\n   \x1b[94mABCD-EFGH1\x1b[0m', flush=True)
    if scenario == 'hang':
        time.sleep(600)
    if scenario == 'fail':
        print('Error: request failed: 429 Too Many Requests', flush=True); sys.exit(1)
    if scenario == 'no-credential':
        sys.exit(0)
    if scenario == 'bad-credential':
        Path(os.environ['CODEX_HOME'], 'auth.json').write_text('{}'); sys.exit(0)
    Path(os.environ['CODEX_HOME'], 'auth.json').write_text(Path(__file__).with_name('codex-auth').read_text())
elif sys.argv[1:] == ['auth', 'login']:
    print("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc", flush=True)
    print('Paste code here if prompted > ', flush=True, end='')
    code = sys.stdin.readline().strip()
    if code != 'synthetic-browser-code':
        sys.exit(1)
    directory = Path(os.environ['CLAUDE_CONFIG_DIR'])
    (directory / '.credentials.json').write_text(Path(__file__).with_name('claude-credential').read_text())
    (directory / '.claude.json').write_text(json.dumps({'oauthAccount': {'emailAddress': 'owner@example.test'}}))
elif sys.argv[1:] == ['auth', 'status', '--json']:
    print(Path(__file__).with_name('claude-status').read_text())
    sys.exit(0 if scenario != 'signed-out' else 1)
elif sys.argv[1:] == ['auth', 'logout']:
    Path(os.environ['CLAUDE_CONFIG_DIR'], '.credentials.json').unlink(missing_ok=True)
'''
DRIVER = '''
import json, socket, sys
sys.path.insert(0, sys.argv[1])
from codex_service.provider_login_anchor import NoCustody, Session
from codex_service import provider_login as login
import struct
channel = socket.socket(fileno=int(sys.argv[2]))
def read(size):
    data = bytearray()
    while len(data) < size:
        data.extend(channel.recv(size - len(data)))
    return bytes(data)
job = json.loads(read(struct.unpack('!I', read(4))[0]))
channel.setblocking(False)
config = json.loads(sys.argv[3])
Session(config, job['provider'], job['deadline_ns'], channel, None, sys.argv[4], NoCustody).run(job['mode'])
'''


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='provider-login-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o755)
        self.cli = self.root / 'bin/fake-cli'
        self.cli.parent.mkdir()
        self.cli.write_text(FAKE_CLI)
        self.cli.chmod(0o755)
        self.scenario('ok')
        (self.cli.parent / 'codex-auth').write_text(json.dumps(CODEX_AUTH))
        (self.cli.parent / 'claude-credential').write_text(json.dumps(CLAUDE_CREDENTIAL))
        (self.cli.parent / 'claude-status').write_text(json.dumps(dict(
            loggedIn=True, authMethod='claude.ai', email='owner@example.test', orgName='Example Org',
            subscriptionType='max', accessToken=TOKEN)))
        self.temp = self.root / 'temp'
        self.codex_dir = self.root / 'codex-home'
        self.codex_dir.mkdir()
        self.auth = self.codex_dir / 'auth.json'
        self.auth.write_text(json.dumps(dict(tokens=dict(access_token='working-credential'))))
        self.auth.chmod(0o600)
        self.account = self.root / 'claude-account'
        self.account.mkdir()
        (self.account / '.credentials.json').write_text(json.dumps(dict(claudeAiOauth=dict(accessToken='working-credential'))))
        (self.account / '.claude.json').write_text(json.dumps(dict(projects=dict(kept=True))))
        self.codex_config = dict(executable=str(self.cli), auth_file=str(self.auth))
        self.claude_config = dict(executable=str(self.cli), account=str(self.account), home=str(self.root / 'claude-home'))
        Path(self.claude_config['home']).mkdir()

    def scenario(self, name):
        self.cli.with_name('scenario').write_text(name)

    def run_session(self, config, name, mode, seconds=20, actions=(), custody=anchor.NoCustody, identity=None):
        """Drive one Session; return its ordered frames and the Root-side frames sent."""
        ours, theirs = socket.socketpair()
        self.addCleanup(ours.close)
        theirs.setblocking(False)
        frames = []
        session = anchor.Session(config, name, time.monotonic_ns() + int(seconds * 1e9), theirs,
                                 identity, self.temp, custody)
        thread = threading.Thread(target=session.run, args=(mode,))
        thread.start()
        ours.settimeout(.1)
        pending = bytearray()
        done_actions = list(actions)
        deadline = time.monotonic() + seconds + 15
        final = False
        while not final and time.monotonic() < deadline:
            try:
                data = ours.recv(4096)
                if not data:
                    break
                pending += data
            except socket.timeout:
                pass
            while len(pending) >= 4:
                size = struct.unpack('!I', pending[:4])[0]
                if len(pending) < 4 + size:
                    break
                value = json.loads(pending[4:4 + size])
                del pending[:4 + size]
                frames.append(value)
                final = value.get('final') is True
                if done_actions and value.get('state') == 'waiting':
                    ours.send(done_actions.pop(0))
        thread.join(30)
        self.assertFalse(thread.is_alive(), 'the session must end')
        theirs.close()
        self.assertTrue(final, 'a terminal frame is always sent')
        return frames

    def assert_untouched(self):
        self.assertEqual(json.loads(self.auth.read_text())['tokens']['access_token'], 'working-credential')

    def assert_no_temp_left(self):
        if self.temp.exists():
            self.assertEqual([p.name for p in self.temp.iterdir()], [])

    def assert_no_secret(self, value):
        text = json.dumps(value)
        self.assertNotIn(TOKEN, text)
        self.assertNotIn('synthetic-refresh', text)


class ParserTests(unittest.TestCase):
    def test_official_links_and_code_only(self):
        parser = login.Parser('codex')
        progress = parser.feed(b'1. Open\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n2. Enter\n'
                               b'   \x1b[94mABCD-EFGH1\x1b[0m\nsk-synthetic-secret\n')
        self.assertEqual(progress, dict(state='waiting', link='https://auth.openai.com/codex/device', code='ABCD-EFGH1'))
        self.assertNotIn('sk-synthetic', json.dumps(progress))

    def test_foreign_links_are_never_surfaced(self):
        for name, output in (('codex', b'visit https://evil.example/codex/device code ABCD-EFGH\n'),
                             ('claude', b'visit: https://claude.com.evil.example/cai/oauth/authorize?x=1\n'),
                             ('claude', b'visit: http://claude.com/cai/oauth/authorize?x=1\n')):
            with self.subTest(output=output):
                parser = login.Parser(name)
                self.assertIsNone(parser.feed(output))
                self.assertIsNone(parser.link)

    def test_link_validation_is_exact_and_closed(self):
        self.assertTrue(login.link_allowed('codex', 'https://auth.openai.com/codex/device'))
        self.assertTrue(login.link_allowed('claude', 'https://claude.com/cai/oauth/authorize?code=true&state=abc'))
        for name, link in (('codex', 'https://auth.openai.com.evil.example/codex/device'),
                           ('codex', 'https://auth.openai.com/codex/device" onclick="x'),
                           ('codex', 'http://auth.openai.com/codex/device'),
                           ('claude', 'https://claude.com/other'),
                           ('claude', 'https://user:pw@claude.com/cai/oauth/authorize?x=1')):
            with self.subTest(link=link):
                self.assertFalse(login.link_allowed(name, link))


class CredentialTruthTests(Fixture):
    def test_status_needs_a_real_credential_not_the_cli_wording(self):
        # `codex login status` claims "Logged in using ChatGPT" for all of these.
        for raw in (b'{}', b'{"tokens":null,"OPENAI_API_KEY":null}', login.CODEX_SIGNED_OUT, b'not json', b''):
            with self.subTest(raw=raw):
                self.auth.write_bytes(raw)
                self.assertEqual(login.status_codex(self.auth), dict(signed_in=False, method=None))
        self.auth.write_text(json.dumps(CODEX_AUTH))
        self.assertEqual(login.status_codex(self.auth), dict(signed_in=True, method='chatgpt'))
        self.auth.unlink()
        self.assertEqual(login.status_codex(self.auth), dict(signed_in=False, method=None))

    def test_claude_status_is_a_closed_projection(self):
        raw = json.dumps(dict(loggedIn=True, authMethod='claude.ai', email='owner@example.test',
                              subscriptionType='max', accessToken=TOKEN, weird={'a': 1}))
        value = login.status_claude(raw)
        self.assertEqual(value, dict(signed_in=True, method='claude.ai', account='owner@example.test', subscription='max'))
        self.assert_no_secret(value)
        self.assertEqual(login.status_claude('garbage')['signed_in'], False)


class SessionTests(Fixture):
    def test_codex_login_lands_in_the_runtime_file_only_after_success(self):
        frames = self.run_session(self.codex_config, 'codex', 'login')
        self.assertEqual(frames[0], dict(state='waiting', link='https://auth.openai.com/codex/device', code='ABCD-EFGH1'))
        self.assertEqual(frames[-1], dict(final=True, state='succeeded', reason=None))
        self.assertEqual(json.loads(self.auth.read_text())['tokens']['access_token'], TOKEN)
        self.assertEqual(stat.S_IMODE(self.auth.stat().st_mode), 0o600)
        self.assert_no_secret(frames)
        self.assert_no_temp_left()

    def test_cli_runs_in_private_home_never_the_runtime_home(self):
        self.run_session(self.codex_config, 'codex', 'login')
        record = json.loads(self.cli.with_name('argv').read_text())
        self.assertEqual(record['argv'], ['login', '--device-auth'])
        self.assertTrue(record['env']['CODEX_HOME'].startswith(str(self.temp)))
        self.assertNotEqual(Path(record['env']['CODEX_HOME']).resolve(), self.codex_dir.resolve())
        self.assertTrue(record['env']['HOME'].startswith(str(self.temp)))

    def test_failed_login_leaves_working_credential_untouched(self):
        self.scenario('fail')
        frames = self.run_session(self.codex_config, 'codex', 'login')
        self.assertEqual(frames[-1], dict(final=True, state='failed', reason='upstream_rate_limited'))
        self.assert_untouched()
        self.assert_no_temp_left()

    def test_exit_zero_without_a_valid_credential_is_refused(self):
        for scenario in ('no-credential', 'bad-credential'):
            with self.subTest(scenario=scenario):
                self.scenario(scenario)
                frames = self.run_session(self.codex_config, 'codex', 'login')
                self.assertEqual(frames[-1], dict(final=True, state='failed', reason='commit_failed'))
                self.assert_untouched()
                self.assert_no_temp_left()

    def test_cancel_kills_the_cli_and_leaves_working_credential_untouched(self):
        self.scenario('hang')
        frames = self.run_session(self.codex_config, 'codex', 'login', actions=[b'C'])
        self.assertEqual(frames[-1], dict(final=True, state='cancelled', reason=None))
        self.assert_untouched()
        self.assert_no_temp_left()

    def test_abandoned_login_times_out_and_leaves_working_credential_untouched(self):
        self.scenario('hang')
        frames = self.run_session(self.codex_config, 'codex', 'login', seconds=1)
        self.assertEqual(frames[-1], dict(final=True, state='expired', reason='timeout'))
        self.assert_untouched()
        self.assert_no_temp_left()

    def test_a_bind_mounted_target_keeps_its_inode(self):
        before = self.auth.stat().st_ino
        real_rename = login.os.rename

        def busy(source, target, **kwargs):
            if str(target) == str(self.auth):
                raise OSError(16, 'Device or resource busy')
            return real_rename(source, target, **kwargs)

        with patch.object(login.os, 'rename', busy):
            frames = self.run_session(self.codex_config, 'codex', 'login')
        self.assertEqual(frames[-1]['state'], 'succeeded')
        self.assertEqual(self.auth.stat().st_ino, before)
        self.assertEqual(json.loads(self.auth.read_text())['tokens']['access_token'], TOKEN)
        self.assertEqual([p for p in self.codex_dir.iterdir() if p.name != 'auth.json'], [])

    def test_in_place_failure_restores_the_previous_bytes(self):
        original = self.auth.read_bytes()
        real_ftruncate = login.os.ftruncate
        calls = []

        def failing(fd, length):
            calls.append(length)
            if len(calls) == 1:
                raise OSError(28, 'No space left on device')
            return real_ftruncate(fd, length)

        with patch.object(login.os, 'ftruncate', failing):
            with self.assertRaises(OSError):
                login.in_place(self.auth, json.dumps(CODEX_AUTH).encode())
        self.assertEqual(self.auth.read_bytes(), original)

    def test_claude_login_uses_the_pasted_code_and_keeps_other_settings(self):
        frames = self.run_session(self.claude_config, 'claude', 'login',
                                  actions=[b'S' + struct.pack('!I', 22) + b'synthetic-browser-code'])
        self.assertEqual(frames[0]['link'], 'https://claude.com/cai/oauth/authorize?code=true&state=abc')
        self.assertIsNone(frames[0]['code'])
        self.assertIn(dict(state='verifying'), frames)
        self.assertEqual(frames[-1], dict(final=True, state='succeeded', reason=None))
        self.assertEqual(json.loads((self.account / '.credentials.json').read_text())['claudeAiOauth']['accessToken'], TOKEN)
        saved = json.loads((self.account / '.claude.json').read_text())
        self.assertEqual(saved['projects'], dict(kept=True), 'saved settings survive a re-login')
        self.assertEqual(saved['oauthAccount']['emailAddress'], 'owner@example.test')
        self.assert_no_secret(frames)
        self.assert_no_temp_left()

    def test_claude_wrong_code_leaves_account_untouched(self):
        before = (self.account / '.credentials.json').read_bytes()
        frames = self.run_session(self.claude_config, 'claude', 'login',
                                  actions=[b'S' + struct.pack('!I', 11) + b'wrong-code!'])
        self.assertEqual(frames[-1], dict(final=True, state='failed', reason='login_failed'))
        self.assertEqual((self.account / '.credentials.json').read_bytes(), before)

    def test_sign_out_clears_codex_but_keeps_the_file_for_the_mount(self):
        self.auth.write_text(json.dumps(CODEX_AUTH))
        inode = self.auth.stat().st_ino
        frames = self.run_session(self.codex_config, 'codex', 'signout')
        self.assertEqual(frames[-1], dict(final=True, state='succeeded', reason=None))
        self.assertTrue(self.auth.exists(), 'manager start refuses a missing or empty bound source')
        self.assertGreater(self.auth.stat().st_size, 0)
        self.assertEqual(login.status_codex(self.auth), dict(signed_in=False, method=None))
        self.assertNotEqual(self.auth.stat().st_ino, inode)

    def test_status_frames_never_contain_a_token(self):
        self.auth.write_text(json.dumps(CODEX_AUTH))
        frames = self.run_session(self.codex_config, 'codex', 'status')
        self.assertEqual(frames[-1], dict(final=True, status=dict(signed_in=True, method='chatgpt')))
        self.assert_no_secret(frames)
        frames = self.run_session(self.claude_config, 'claude', 'status')
        self.assertEqual(frames[-1]['status'], dict(signed_in=True, method='claude.ai',
                                                    account='owner@example.test', subscription='max'))
        self.assert_no_secret(frames)
        self.scenario('signed-out')
        frames = self.run_session(self.claude_config, 'claude', 'status')
        self.assertIs(frames[-1]['status']['signed_in'], False)

    def test_sign_out_uses_claudes_own_logout(self):
        frames = self.run_session(self.claude_config, 'claude', 'signout')
        self.assertEqual(frames[-1], dict(final=True, state='succeeded', reason=None))
        self.assertFalse((self.account / '.credentials.json').exists())

    @unittest.skipUnless(os.geteuid() == 0, 'real executor identity')
    def test_real_drop_runs_cli_as_executor_with_real_custody(self):
        os.chown(self.codex_dir, 65534, 65534)
        os.chown(self.auth, 65534, 65534)
        self.temp.mkdir(mode=0o700)
        os.chown(self.temp, 65534, 65534)
        os.chown(self.cli.parent, 65534, 65534)
        frames = self.run_session(self.codex_config, 'codex', 'login', custody=anchor.Custody,
                                  identity=dict(uid=65534, gid=65534))
        self.assertEqual(frames[-1]['state'], 'succeeded', frames)
        record = json.loads(self.cli.with_name('argv').read_text())
        self.assertEqual(record['uid'], 65534)
        self.assertEqual(self.auth.stat().st_uid, 65534)
        self.assertEqual(json.loads(self.auth.read_text())['tokens']['access_token'], TOKEN)


class OperationsTests(Fixture):
    def setUp(self):
        super().setUp()
        self.addCleanup(self.close_operations)
        self.operations = None
        self.geteuid = patch.object(login.os, 'geteuid', return_value=0)
        self.geteuid.start()
        self.addCleanup(self.geteuid.stop)
        self.process = patch.object(login, 'process',
                                    lambda pid: dict(pid=pid, ppid=os.getpid(), uid=0, start=1))
        self.process.start()
        self.addCleanup(self.process.stop)
        self.package = type('Package', (), dict(
            identity_split=True, beta=dict(managed_host={}), profile=dict(auth_file=str(self.auth)),
            root=self.cli.parent, claude=dict(), provider_home=self.root))()
        self.configuration = patch.object(login, 'configuration', self.config_for)
        self.configuration.start()
        self.addCleanup(self.configuration.stop)

    def close_operations(self):
        if self.operations is not None:
            self.operations.close()

    def config_for(self, _package, name):
        return self.codex_config if name == 'codex' else self.claude_config

    def spawn(self, fd):
        name = self.configured_name
        driver = subprocess.Popen(
            [sys.executable, '-I', '-S', '-B', '-c', DRIVER, str(Path(__file__).resolve().parent), str(fd),
             json.dumps(self.config_for(None, name)), str(self.temp)],
            pass_fds=(fd,), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return driver

    def ops(self, name='codex'):
        self.configured_name = name
        self.operations = login.Operations(self.package, spawn=self.spawn)
        return self.operations

    def settle(self, ops, name, predicate, seconds=20):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            ops.tick()
            view = ops.public(name)
            if predicate(view):
                return view
            time.sleep(.02)
        self.fail('condition not reached: %r' % (view,))

    def test_only_one_login_per_provider_and_public_view_has_only_link_and_code(self):
        self.scenario('hang')
        ops = self.ops()
        self.assertEqual(ops.start('codex'), 'started')
        self.assertEqual(ops.start('codex'), 'in_progress')
        self.assertEqual(ops.sign_out('codex'), 'in_progress')
        view = self.settle(ops, 'codex', lambda v: v['login'] and v['login']['state'] == 'waiting')
        self.assertEqual(view['login']['link'], 'https://auth.openai.com/codex/device')
        self.assertEqual(view['login']['code'], 'ABCD-EFGH1')
        self.assertEqual(set(view['login']), {'state', 'link', 'code', 'expires_in_s'})
        self.assert_no_secret(ops.overview('status'))
        self.assertEqual(ops.cancel('codex'), 'accepted')
        view = self.settle(ops, 'codex', lambda v: v['login'] and v['login']['state'] == 'cancelled')
        self.assertNotIn('link', view['login'])
        self.assertNotIn('code', view['login'])
        self.assert_untouched()

    def test_starts_are_rate_limited_per_provider(self):
        self.scenario('hang')
        ops = self.ops()
        ops.start('codex')
        ops.cancel('codex')
        self.settle(ops, 'codex', lambda v: v['login'] and v['login']['state'] == 'cancelled')
        self.assertEqual(ops.start('codex'), 'rate_limited')
        ops.starts['codex'] = [time.monotonic() - 3599] * login.STARTS_PER_HOUR
        self.assertEqual(ops.start('codex'), 'rate_limited')
        ops.starts['codex'] = []
        self.assertEqual(ops.start('codex'), 'started')

    def test_successful_login_refreshes_status_and_clears_the_link(self):
        ops = self.ops()
        ops.start('codex')
        view = self.settle(ops, 'codex', lambda v: v['login'] and v['login']['state'] == 'succeeded')
        self.assertNotIn('link', view['login'])
        until = time.monotonic() + 20
        while ops.public('codex')['signed_in'] is None and time.monotonic() < until:
            ops.refresh()
            time.sleep(.02)
        view = ops.public('codex')
        self.assertIs(view['signed_in'], True)
        self.assertEqual(view['method'], 'chatgpt')

    def test_claude_is_reported_unavailable_when_not_configured(self):
        ops = self.ops()
        with patch.object(login, 'configuration', lambda _p, name: self.codex_config if name == 'codex' else None):
            self.assertEqual(ops.start('claude'), 'unavailable')
            view = ops.public('claude')
        self.assertEqual(view, dict(provider='claude', available=False, reason='not_configured'))

    def fake_child(self):
        return type('Child', (), dict(pid=1, returncode=None, poll=lambda _self: None,
                                      kill=lambda _self: None, wait=lambda _self, timeout=None: 0))()

    def test_a_foreign_link_frame_only_fails_that_login(self):
        ops = self.ops()
        ours, theirs = socket.socketpair()
        self.addCleanup(theirs.close)
        ours.setblocking(False)
        ops.active['codex'] = login.Handle('codex', 'login', self.fake_child(), dict(pid=1, start=1), ours,
                                           time.monotonic() + 60)
        theirs.sendall(login.encode(dict(state='waiting', link='https://evil.example/', code=None)))
        ops.tick()
        self.assertEqual(ops.public('codex')['login'], dict(state='failed', reason='internal'))
        self.assertNotIn('evil.example', json.dumps(ops.overview('status')))
        self.assertNotIn('codex', ops.active)

    def test_tick_never_raises_into_the_manager_loop(self):
        ops = self.ops()
        ops.active['codex'] = type('Broken', (), dict(
            channel=None, child=None, mode='login', name='codex', identity=None,
            view=lambda self: dict(state='failed'), final=None))()
        ops.tick()
        self.assertNotIn('codex', ops.active)


class ManagerHookTests(Fixture):
    def manager(self, operations=None, preflight=None):
        ledger = type('Ledger', (), dict(status=lambda _self, _conversation: dict(state='idle')))()
        return type('Manager', (), dict(package=self.package, provider_login=operations, ledger=ledger,
                                        _package_preflight=preflight or (lambda _self: None)))()

    def setUp(self):
        super().setUp()
        self.package = type('Package', (), dict(identity_split=True, beta=dict(managed_host={}),
                                                profile=dict(auth_file=str(self.auth)), root=self.cli.parent,
                                                claude=None, provider_home=self.root))()

    def request(self, operation, **fields):
        return dict(operation=operation, conversation_id=CHAT, owner_id=OWNER, **fields)

    def test_status_answers_with_a_closed_overview(self):
        with patch.object(login.os, 'geteuid', return_value=0), patch.object(login.Operations, '_probe', lambda *_: None):
            answer = login.dispatch(self.manager(), self.request('provider_login_status'))
        self.assertEqual(set(answer), {'ok', 'receipt', 'provider_login'})
        self.assertEqual(answer['provider_login']['result'], 'status')
        self.assertEqual([v['provider'] for v in answer['provider_login']['providers']], list(login.PROVIDERS))

    def test_an_unexpected_fault_cannot_stop_the_manager(self):
        class Boom:
            def tick(self): raise RuntimeError('unexpected')
            def start(self, _name): raise RuntimeError('unexpected')
        manager = self.manager(Boom())
        with self.assertRaises(Refused):
            login.dispatch(manager, self.request('provider_login_start', provider='codex'))

    def test_a_held_package_refuses_a_positive_operation(self):
        manager = self.manager(preflight=lambda _self: (_ for _ in ()).throw(Refused('package_inventory')))
        with patch.object(login.os, 'geteuid', return_value=0):
            with self.assertRaises(Refused):
                login.dispatch(manager, self.request('provider_login_start', provider='codex'))

    def test_anchors_count_as_known_children(self):
        from codex_service.manager import Manager
        manager = Manager.__new__(Manager)
        manager.identity = None
        manager.windows = {}
        manager.launcher = None
        manager.desk = None
        manager.workspace_commands = None
        handle = login.Handle('codex', 'login', None, dict(pid=7, start=9), None, 0)
        manager.provider_login = type('Operations', (), dict(children=lambda _self: {(7, 9)}))()
        self.assertIn((7, 9), manager._known_children())
        self.assertIsNotNone(handle)


class ContractTests(unittest.TestCase):
    def frame(self, operation, **fields):
        return json.dumps(dict(version=1, operation=operation, request_id='r1', owner_id=OWNER,
                               conversation_id=CHAT, **fields)).encode()

    def test_closed_fields_and_provider(self):
        self.assertEqual(decode(self.frame('provider_login_status'))['operation'], 'provider_login_status')
        self.assertEqual(decode(self.frame('provider_login_start', provider='codex'))['provider'], 'codex')
        self.assertEqual(decode(self.frame('provider_login_code', provider='claude', code='synthetic-code'))['code'],
                         'synthetic-code')
        for frame in (self.frame('provider_login_start'), self.frame('provider_login_start', provider='openai'),
                      self.frame('provider_login_start', provider='codex', extra=1),
                      self.frame('provider_login_code', provider='claude', code=''),
                      self.frame('provider_login_status', provider='codex')):
            with self.subTest(frame=frame):
                with self.assertRaises(Refused):
                    decode(frame)

    def test_negative_operations_survive_a_held_manager(self):
        from codex_service.qualification import NEGATIVE
        self.assertLessEqual({'provider_login_status', 'provider_login_cancel'}, set(NEGATIVE))
        self.assertFalse({'provider_login_start', 'provider_login_code', 'provider_signout'} & set(NEGATIVE))

    def test_package_ships_both_modules(self):
        from codex_service.package import MODULES_SERVICE
        self.assertLessEqual({'provider_login.py', 'provider_login_files.py', 'provider_login_anchor.py'}, set(MODULES_SERVICE))


if __name__ == '__main__':
    unittest.main()
