"""Offline checks for the local folder agent tool against a fake V2 API."""
import base64
import contextlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
import unittest
import unittest.mock


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TOOL = load('local_files')
PROVISION = load('local_files_provision')
GRANT = 'ef' * 32
CONVERSATION = '00000000-0000-4000-8000-00000000000a'
REQUEST = '00000000-0000-4000-8000-0000000000d1'


def view(state, operation='list', result=None, error=None, text='status'):
    return {'request_id': REQUEST, 'operation': operation, 'state': state, 'result': result,
            'error': error, 'status_text': text}


class FakeV2(http.server.BaseHTTPRequestHandler):
    calls, states, refuse = [], [], None

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
        # Never an owner credential, cookie or browser origin.
        assert self.headers.get('Origin') is None and self.headers.get('Authorization') is None
        assert self.headers.get('Cookie') is None
        if self.headers.get('X-Orkestr-Local-Files-Grant') != GRANT:
            return self._reply(401, {'code': 'unauthorized'})
        path = self.path[len(f'/api/v2/conversations/{CONVERSATION}/local-files'):]
        FakeV2.calls.append((self.command, path, body))
        if path == '/requests' and self.command == 'POST':
            if FakeV2.refuse:
                return self._reply(409, {'code': FakeV2.refuse})
            return self._reply(202, {'created': True, 'request': FakeV2.states.pop(0)})
        if path == f'/requests/{REQUEST}':
            return self._reply(200, FakeV2.states.pop(0) if len(FakeV2.states) > 1 else FakeV2.states[0])
        return self._reply(404, {'code': 'not_found'})

    do_GET = _handle
    do_POST = _handle


class ToolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeV2)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_address[1]}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        FakeV2.calls, FakeV2.states, FakeV2.refuse = [], [], None
        self.env = unittest.mock.patch.dict(os.environ, {'ORKESTR_V2_LOCAL_FILES_GRANT': GRANT}, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)

    def run_tool(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = TOOL.main(['--v2-url', self.url, '--conversation', CONVERSATION, *argv])
        return code, out.getvalue(), err.getvalue()

    def test_list_waits_for_the_owner_tab_and_prints_the_result(self):
        listing = {'entries': [{'name': 'plan.md', 'kind': 'file', 'size': 7}], 'truncated': False}
        FakeV2.states = [view('queued'), view('working'), view('done', result=listing, text='Listed the folder: 1 entries.')]
        code, out, err = self.run_tool('list')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)['request']['result'], listing)
        self.assertIn('request_key: lf-', err)
        self.assertIn('Listed the folder', err)
        method, path, body = FakeV2.calls[0]
        self.assertEqual((method, path, body['operation'], body['path'], body['timeout_ms']), ('POST', '/requests', 'list', '', 120000))
        self.assertNotIn('conversation_id', body, 'the conversation always comes from the grant')

    def test_read_prints_the_prepared_file_and_write_sends_the_content(self):
        result = {'upload_id': REQUEST, 'filename': 'plan.md', 'byte_length': 7, 'local_file': '/srv/exports/x/plan.md'}
        FakeV2.states = [view('queued', 'read'), view('done', 'read', result)]
        code, out, _ = self.run_tool('read', 'docs/plan.md', '--request-key', 'retry-1')
        self.assertEqual(code, 0)
        self.assertIn('local_file: /srv/exports/x/plan.md', out)
        self.assertEqual(FakeV2.calls[0][2]['request_key'], 'retry-1', 'a retry reuses the printed key')
        FakeV2.calls, FakeV2.states = [], [view('working', 'write'), view('done', 'write', {'bytes_written': 5})]
        code, _, _ = self.run_tool('write', 'notes/new.txt', '--text', 'hello', '--timeout', '180')
        self.assertEqual(code, 0)
        body = FakeV2.calls[0][2]
        self.assertEqual((base64.b64decode(body['content_base64']), body['timeout_ms']), (b'hello', 180000))

    def test_no_folder_refused_and_unfinished_have_their_own_exit_codes(self):
        FakeV2.refuse = 'local_files_not_connected'
        code, _, err = self.run_tool('list')
        self.assertEqual(code, TOOL.NOT_CONNECTED_EXIT)
        self.assertIn('Connect folder', err)
        FakeV2.refuse = None
        FakeV2.states = [view('working', 'write'), view('failed', 'write', error='refused_by_owner', text='Not done: the owner refused the write.')]
        code, _, err = self.run_tool('write', 'a.txt', '--text', 'x')
        self.assertEqual(code, TOOL.FAILED_EXIT)
        self.assertIn('refused the write', err)
        FakeV2.states = [view('working', 'write'), view('working', 'write')]
        original = TOOL.wait
        TOOL.wait = lambda client, view, timeout: original(client, view, 0.05, interval=0.01)
        try:
            code, out, _ = self.run_tool('write', 'a.txt', '--text', 'x')
        finally:
            TOOL.wait = original
        self.assertEqual(code, TOOL.PENDING_EXIT)
        self.assertFalse(json.loads(out)['ok'], 'waiting for the owner is never reported as done')

    def test_paths_outside_the_folder_and_bad_grants_never_reach_the_server(self):
        for bad in ('../secret', '/etc/passwd', 'a/../b', 'a\\b', 'a//b', ''):
            code, _, err = self.run_tool('read', bad)
            self.assertEqual(code, TOOL.ERROR_EXIT, bad)
            self.assertIn('invalid_path', err)
        code, _, err = self.run_tool('hash', 'a.txt', 'a.txt')
        self.assertIn('invalid_paths', err)
        with tempfile.TemporaryDirectory() as root:
            big = Path(root) / 'big'
            big.write_bytes(b'x' * (TOOL.WRITE_MAX + 1))
            code, _, err = self.run_tool('write', 'big', '--from-file', str(big))
            self.assertIn('content_too_large', err)
        self.assertEqual(FakeV2.calls, [])
        with unittest.mock.patch.dict(os.environ, {'ORKESTR_V2_LOCAL_FILES_GRANT': ''}):
            code, _, err = self.run_tool('list')
        self.assertIn('grant_missing_or_invalid', err)
        with tempfile.TemporaryDirectory() as root:
            grant = Path(root) / f'{CONVERSATION}.local-files.grant'
            grant.write_text(GRANT)
            os.chmod(grant, 0o644)
            code, _, err = self.run_tool('--grant-file', str(grant), 'list')
            self.assertIn('grant_file_must_be_private', err)
            os.chmod(grant, 0o600)
            FakeV2.states = [view('done')]
            with unittest.mock.patch.dict(os.environ, {'ORKESTR_V2_LOCAL_FILES_GRANT': '', 'ORKESTR_V2_LOCAL_FILES_GRANT_DIR': root}):
                code, _, _ = self.run_tool('list')
            self.assertEqual(code, 0, 'the provisioned grant file is found by conversation')
        self.assertNotIn(GRANT, json.dumps(FakeV2.calls))

    def test_the_grant_dir_lookup_never_takes_the_agent_timer_grant(self):
        """ORK-804: the local-files and agent-timer grants share one agent-visible directory;
        <conversation>.grant there is the agent-timer grant, which this server refuses."""
        with tempfile.TemporaryDirectory() as root:
            timer = Path(root) / f'{CONVERSATION}.grant'
            timer.write_text('12' * 32)
            os.chmod(timer, 0o600)
            env = {'ORKESTR_V2_LOCAL_FILES_GRANT': '', 'ORKESTR_V2_LOCAL_FILES_GRANT_DIR': root}
            with unittest.mock.patch.dict(os.environ, env):
                code, _, err = self.run_tool('list')
            self.assertEqual(code, TOOL.ERROR_EXIT)
            self.assertIn('grant_file_missing', err)
            self.assertEqual(TOOL.grant_path(CONVERSATION, env), Path(root) / f'{CONVERSATION}.local-files.grant')
        self.assertEqual(FakeV2.calls, [])

    def test_a_write_waits_ten_minutes_by_default_and_never_less_than_two(self):
        """ORK-804: a 25 s write expired before the owner saw the card."""
        def sent(*argv):
            FakeV2.calls, FakeV2.states = [], [view('done', argv[0], {'bytes_written': 1})]
            code, _, err = self.run_tool(*argv)
            self.assertEqual(code, 0)
            return FakeV2.calls[0][2]['timeout_ms'], err
        self.assertEqual(sent('write', 'a.txt', '--text', 'x')[0], 600_000)
        timeout, err = sent('write', 'a.txt', '--text', 'x', '--timeout', '25')
        self.assertEqual(timeout, 120_000)
        self.assertIn('write timeout raised to 120 s', err)
        self.assertEqual(sent('write', 'a.txt', '--text', 'x', '--timeout', '300')[0], 300_000)
        self.assertEqual(sent('write', 'a.txt', '--text', 'x', '--timeout', '9000')[0], 600_000, 'the server maximum')
        self.assertEqual(sent('list')[0], 120_000, 'other requests keep their default')
        self.assertEqual(sent('list', '--timeout', '20')[0], 20_000)
        self.assertIn('"Allow write"', TOOL.AGENT_INSTRUCTIONS)
        self.assertIn('never through Root', TOOL.AGENT_INSTRUCTIONS)


class FakeApi:
    def __init__(self, issued):
        self.issued, self.calls = issued, []

    def grant(self, conversation):
        self.calls.append(('grant', conversation))
        return {'issued': self.issued}

    def issue(self, conversation):
        self.calls.append(('issue', conversation))
        return {'grant': GRANT}

    def revoke(self, conversation):
        self.calls.append(('revoke', conversation))


class ProvisionTests(unittest.TestCase):
    def test_plan_is_repeatable(self):
        self.assertEqual(PROVISION.plan(False, False), 'issue')
        self.assertEqual(PROVISION.plan(True, True), 'unchanged')
        self.assertEqual(PROVISION.plan(True, False), 'rotate')
        self.assertEqual(PROVISION.plan(True, True, rotate=True), 'rotate')
        self.assertEqual(PROVISION.plan(True, True, revoke=True), 'revoke')
        self.assertEqual(PROVISION.plan(False, False, revoke=True), 'unchanged')

    def test_installs_a_private_grant_file_and_revokes_it(self):
        with tempfile.TemporaryDirectory() as root:
            grants = Path(root) / 'grants'
            argv = ['--v2-url', 'http://127.0.0.1:1', '--credentials', '/nonexistent', '--grant-dir', str(grants),
                    '--conversation', CONVERSATION]
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(PROVISION.main(argv, api=FakeApi(False)), 0)
            path = grants / f'{CONVERSATION}.local-files.grant'
            self.assertFalse((grants / f'{CONVERSATION}.grant').exists(), 'never the agent-timer grant name')
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.read_text().strip(), GRANT)
            self.assertNotIn(GRANT, out.getvalue())
            api = FakeApi(True)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(PROVISION.main(argv + ['--revoke'], api=api), 0)
            self.assertIn(('revoke', CONVERSATION), api.calls)
            self.assertFalse(path.exists())
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(PROVISION.main(argv[:-1] + ['not-a-uuid'], api=FakeApi(False)), 2)


if __name__ == '__main__':
    unittest.main()
