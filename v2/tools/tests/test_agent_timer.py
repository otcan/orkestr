"""Offline checks for the agent timer client and its provisioning."""
import contextlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import unittest.mock

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TIMER = load('agent_timer')
PROV = load('agent_timer_provision')

GRANT = 'ef' * 32
CONVERSATION = '00000000-0000-4000-8000-00000000000a'
CHECK = '00000000-0000-4000-8000-0000000000c1'


def timer(namespace=CHECK, label='CHECK 08:00', state='enabled', due=1_800_000_000_000):
    return {'namespace': namespace, 'label': label, 'state': state, 'schedule': 'daily',
            'next_due_ms': due, 'pause_until_ms': None, 'created_by_agent': False}


class FakeV2(http.server.BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *_):
        pass

    def _reply(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _handle(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        # Never an owner credential, cookie, browser origin or V1 path.
        assert self.headers.get('Origin') is None and self.headers.get('Authorization') is None
        assert self.headers.get('Cookie') is None
        if self.headers.get('X-Orkestr-Agent-Timer-Grant') != GRANT:
            return self._reply(401, {'code': 'unauthorized'})
        prefix = f'/api/v2/conversations/{CONVERSATION}'
        assert self.path.startswith(prefix), self.path
        path = self.path[len(prefix):]
        FakeV2.calls.append((self.command, path, body))
        if path == '/agent-timers' and self.command == 'GET':
            return self._reply(200, {'conversation_id': CONVERSATION, 'timers': [timer()]})
        if path == '/agent-timers' and self.command == 'POST':
            if body['schedule'].get('due_ms', 10**13) < 1_700_000_000_000:
                return self._reply(422, {'code': 'agent_timer_too_soon'})
            return self._reply(201, {'changed': True, 'timer': timer('n', body['label'])})
        if path == f'/agent-timers/{CHECK}/control':
            state = 'disabled' if body['operation'] == 'cancel' else 'enabled'
            return self._reply(200, {'changed': True, 'timer': timer(state=state)})
        return self._reply(404, {'code': 'agent_timer_not_found'})

    do_GET = _handle
    do_POST = _handle


class AgentTimerClient(unittest.TestCase):
    def setUp(self):
        FakeV2.calls = []
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeV2)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        self.env = unittest.mock.patch.dict(os.environ, {'ORKESTR_V2_AGENT_TIMER_GRANT': GRANT})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.server.shutdown()
        self.server.server_close()

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = TIMER.main(['--v2-url', self.url, '--conversation', CONVERSATION, *argv])
        return code, out.getvalue(), err.getvalue()

    def test_create_once_and_daily_with_stable_keys(self):
        code, out, err = self.run_cli('create', '--label', 'Biocytogen 12:15',
                                      '--at', '2026-10-27T12:00:00+01:00', '--text', 'Remind.')
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out)['changed'])
        self.assertIn('Timer "Biocytogen 12:15" set', err)
        self.assertNotIn(GRANT, out + err)
        posted = FakeV2.calls[-1][2]
        self.assertEqual(posted['schedule'], {'kind': 'once', 'due_ms': 1_793_098_800_000})
        self.assertNotIn('conversation_id', posted)
        self.run_cli('create', '--label', 'Biocytogen 12:15',
                     '--at', '2026-10-27T11:00:00Z', '--text', 'Remind.')
        keys = {c[2]['request_key'] for c in FakeV2.calls if c[0] == 'POST'}
        self.assertEqual(len(keys), 1, 'the same instant and text is the same request')
        self.run_cli('create', '--label', 'CHECK 08:00', '--daily', '08:00',
                     '--timezone', 'Europe/Berlin', '--weekdays', '1,2,3,4,5', '--text', 'Check.')
        self.assertEqual(FakeV2.calls[-1][2]['schedule'], {
            'kind': 'calendar', 'timezone': 'Europe/Berlin', 'weekdays': [1, 2, 3, 4, 5],
            'start_minute': 480, 'end_minute': 480, 'every_hours': 1, 'minutes': [0]})

    def test_control_by_label_and_deterministic_skip(self):
        code, _, err = self.run_cli('pause', 'check 08:00', '--until', '2026-11-03T08:00:00+01:00')
        self.assertEqual(code, 0)
        self.assertIn('paused', err)
        pause = FakeV2.calls[-1]
        self.assertEqual(pause[1], f'/agent-timers/{CHECK}/control')
        self.assertEqual(pause[2]['operation'], 'pause')
        self.assertEqual(pause[2]['until_ms'], 1_793_689_200_000)
        self.run_cli('skip-next', CHECK)
        self.run_cli('skip-next', CHECK)
        skips = [c[2]['request_key'] for c in FakeV2.calls if c[0] == 'POST' and c[2]['operation'] == 'skip_next']
        self.assertEqual(len(set(skips)), 1, 'a retried skip names the same run')
        code, out, _ = self.run_cli('cancel', CHECK)
        self.assertEqual(json.loads(out)['timer']['state'], 'disabled')

    def test_refusals_and_bad_input(self):
        code, _, err = self.run_cli('create', '--label', 'x', '--at', '2020-01-01T00:00:00Z', '--text', 't')
        self.assertEqual((code, json.loads(err)['code']), (TIMER.ERROR_EXIT, 'agent_timer_too_soon'))
        code, _, err = self.run_cli('create', '--label', 'x', '--at', '2026-10-27T12:00:00', '--text', 't')
        self.assertEqual(json.loads(err)['code'], 'time_needs_offset')
        code, _, err = self.run_cli('cancel', 'nobody')
        self.assertEqual(json.loads(err)['code'], 'timer_unknown')
        with unittest.mock.patch.dict(os.environ, {'ORKESTR_V2_AGENT_TIMER_GRANT': 'short'}):
            code, _, err = self.run_cli('list')
        self.assertEqual((code, json.loads(err)['code']), (TIMER.ERROR_EXIT, 'grant_missing_or_invalid'))

    def test_instructions_and_provisioned_grant_file(self):
        code, out, _ = self.run_cli('instructions')
        self.assertEqual(code, 0)
        self.assertIn('Never\nuse the V1 timer API', out)
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / f'{CONVERSATION}.grant'
            path.write_text(GRANT)
            path.chmod(0o600)
            with unittest.mock.patch.dict(os.environ, {'ORKESTR_V2_AGENT_TIMER_GRANT_DIR': root}):
                os.environ.pop('ORKESTR_V2_AGENT_TIMER_GRANT', None)
                code, out, _ = self.run_cli('list')
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out)['timers'][0]['label'], 'CHECK 08:00')
            path.chmod(0o644)
            with self.assertRaises(TIMER.TimerError):
                TIMER.read_grant(path)


class Retry(unittest.TestCase):
    def setUp(self):
        FakeV2.calls = []
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Flaky)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        self.env = unittest.mock.patch.dict(os.environ, {'ORKESTR_V2_AGENT_TIMER_GRANT': GRANT})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.server.shutdown()
        self.server.server_close()

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = TIMER.main(['--v2-url', self.url, '--conversation', CONVERSATION, *argv])
        return code, out.getvalue(), err.getvalue()

    def test_failed_skip_prints_its_key_and_a_rerun_reuses_it(self):
        Flaky.fail = True
        code, _, err = self.run_cli('skip-next', CHECK)
        self.assertEqual(code, TIMER.ERROR_EXIT)
        failure = json.loads(err.strip().splitlines()[-1])
        key = failure['request_key']
        self.assertIn(f'--request-key {key}', failure['retry'])
        # The next run moved meanwhile: a fresh key would differ, so reuse it.
        Flaky.fail, Flaky.due = False, Flaky.due + 3_600_000
        self.assertNotEqual(TIMER.Client(self.url, CONVERSATION, GRANT).control_key(CHECK, 'skip_next'), key)
        code, _, err = self.run_cli('skip-next', CHECK, '--request-key', key)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(err.splitlines()[0])['request_key'], key)
        sent = [c[2]['request_key'] for c in FakeV2.calls if c[0] == 'POST']
        self.assertEqual(sent, [key, key])


class Flaky(FakeV2):
    fail = False
    due = 1_800_000_000_000

    def _handle(self):
        if self.command == 'GET':
            FakeV2.calls.append(('GET', '/agent-timers', None))
            return self._reply(200, {'conversation_id': CONVERSATION, 'timers': [timer(due=Flaky.due)]})
        length = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(length))
        FakeV2.calls.append(('POST', self.path, body))
        if Flaky.fail:
            return self._reply(503, {'code': 'store_unavailable'})
        return self._reply(200, {'changed': False, 'timer': timer(due=Flaky.due)})

    do_GET = _handle
    do_POST = _handle


A, B, R = (f'00000000-0000-4000-8000-00000000000{n}' for n in 'abd')


class Provision(unittest.TestCase):
    def rows(self, issued=()):
        return [{'conversation_id': c, 'name': 'T' + c[-1], 'eligible': c != R,
                 'grant': {'conversation_id': c, 'issued': c in issued, 'generation': 1}}
                for c in (A, B, R)]

    def test_plan_is_idempotent_and_revokes_ineligible(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(PROV.plan(self.rows(), grant_dir=root), [(A, 'issue'), (B, 'issue')])
            for c in (A, B):
                p = Path(root) / f'{c}.grant'
                p.write_text(GRANT)
                p.chmod(0o600)
            self.assertEqual(PROV.plan(self.rows({A, B, R}), grant_dir=root),
                             [(A, 'unchanged'), (B, 'unchanged'), (R, 'revoke')])
            self.assertEqual(PROV.plan(self.rows({A}), only={A}, rotate=True, grant_dir=root),
                             [(A, 'rotate')])
            self.assertEqual(PROV.plan(self.rows({A}), revoke=True, grant_dir=root), [(A, 'revoke')])

    def test_all_conversations_needs_the_shared_dir_acknowledgement(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = PROV.main(['--v2-url', 'http://127.0.0.1:1', '--credentials', '/nonexistent',
                              '--grant-dir', '/nonexistent', '--all-owner-conversations'], api=object())
        self.assertEqual((code, json.loads(err.getvalue())['code']), (2, 'shared_grant_dir_not_acknowledged'))

    def test_install_makes_an_enterable_private_dir_and_0600_files(self):
        import pwd
        me = pwd.getpwuid(os.getuid())
        with tempfile.TemporaryDirectory() as root:
            grant_dir = Path(root) / 'grants'
            PROV.install(grant_dir / f'{A}.grant', GRANT, me)
            info = grant_dir.stat()
            self.assertEqual((info.st_mode & 0o777, info.st_gid, info.st_uid), (0o710, me.pw_gid, os.getuid()))
            grant = (grant_dir / f'{A}.grant').stat()
            self.assertEqual((grant.st_mode & 0o777, grant.st_uid), (0o600, me.pw_uid))
            self.assertEqual(TIMER.read_grant(grant_dir / f'{A}.grant'), GRANT)
            other = Path(root) / 'plain'
            PROV.install(other / f'{B}.grant', GRANT)
            self.assertEqual(other.stat().st_mode & 0o777, 0o700)


if __name__ == '__main__':
    unittest.main()
