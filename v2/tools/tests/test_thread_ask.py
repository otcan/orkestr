"""Offline checks for the thread-ask client against a fake V2 API."""
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

SPEC = importlib.util.spec_from_file_location(
    "thread_ask", Path(__file__).resolve().parents[1] / "thread_ask.py")
ASK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASK)

GRANT = 'cd' * 32
CONVERSATION = '00000000-0000-4000-8000-00000000000a'
HOSTING = '00000000-0000-4000-8000-00000000000b'
ASK_ID = '00000000-0000-4000-8000-0000000000c1'


def view(state, returned=None, answer=None, text='status'):
    value = {'ask_id': ASK_ID, 'state': state, 'returned': returned, 'status_text': text,
             'target_conversation_id': HOSTING, 'target_name': 'Hosting'}
    if answer is not None:
        value['answer'] = answer
    return value


class FakeV2(http.server.BaseHTTPRequestHandler):
    calls = []
    states = []
    collected = False
    collects = 0

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
        if self.headers.get('X-Orkestr-Thread-Ask-Grant') != GRANT:
            return self._reply(401, {'code': 'unauthorized'})
        prefix = f'/api/v2/conversations/{CONVERSATION}'
        path = self.path[len(prefix):]
        FakeV2.calls.append((self.command, path, body))
        if path == '/thread-asks/targets':
            return self._reply(200, {'targets': [{'conversation_id': HOSTING, 'name': 'Hosting'},
                                                 {'conversation_id': CONVERSATION[:-1] + 'd', 'name': 'Design'}]})
        if path == '/thread-asks' and self.command == 'POST':
            if body['target_conversation_id'] != HOSTING:
                return self._reply(404, {'code': 'thread_ask_target_not_found'})
            return self._reply(202, {'created': True, 'ask': view('sent', text='Sent, not processed yet')})
        if path == f'/thread-asks/{ASK_ID}':
            state = FakeV2.states.pop(0) if len(FakeV2.states) > 1 else FakeV2.states[0]
            return self._reply(200, view(state, 'tool_result' if FakeV2.collected else None))
        if path == f'/thread-asks/{ASK_ID}/collect':
            FakeV2.collected = True
            FakeV2.collects += 1
            return self._reply(200, view('answered', 'tool_result', 'eu-central-1'))
        return self._reply(404, {'code': 'not_found'})

    do_GET = _handle
    do_POST = _handle


class ThreadAskClient(unittest.TestCase):
    def setUp(self):
        FakeV2.calls, FakeV2.states, FakeV2.collected, FakeV2.collects = [], ['sent'], False, 0
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeV2)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        self.env = unittest.mock.patch.dict(os.environ, {'ORKESTR_V2_THREAD_ASK_GRANT': GRANT})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.server.shutdown()
        self.server.server_close()

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = ASK.main(['--v2-url', self.url, '--conversation', CONVERSATION, *argv])
        return code, out.getvalue(), err.getvalue()

    def test_ask_by_name_uses_a_stable_key_and_reports_sent_honestly(self):
        code, out, err = self.run_cli('ask', 'hosting', '--text', 'Bedrock access?')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)['ask']['state'], 'sent')
        self.assertIn('not processed yet', err)
        self.assertNotIn(GRANT, out + err)
        posted = [c for c in FakeV2.calls if c[0] == 'POST'][0][2]
        self.assertEqual(posted['target_conversation_id'], HOSTING)
        self.assertEqual(posted['request_key'], ASK.default_key(HOSTING, 'Bedrock access?'))
        # A retried call sends the same idempotency key.
        self.run_cli('ask', HOSTING, '--text', 'Bedrock access?')
        keys = {c[2]['request_key'] for c in FakeV2.calls if c[0] == 'POST'}
        self.assertEqual(len(keys), 1)

    def test_wait_collects_and_the_same_turn_may_collect_again(self):
        FakeV2.states = ['sent', 'running', 'answered']
        client = ASK.Client(self.url, CONVERSATION, GRANT)
        result = ASK.wait(client, ASK_ID, timeout=60, interval=0, sleep=lambda _s: None)
        self.assertEqual(result['answer'], 'eu-central-1')
        collects = [c for c in FakeV2.calls if c[1].endswith('/collect')]
        self.assertEqual(len(collects), 1)
        # A lost response: the collecting turn collects again (Core decides
        # which run may), and gets the same answer.
        again = ASK.wait(client, ASK_ID, timeout=0, interval=0, sleep=lambda _s: None)
        self.assertEqual(again['answer'], 'eu-central-1')
        self.assertEqual(FakeV2.collects, 2)

    def test_outcome_returned_as_input_is_never_collected(self):
        FakeV2.states = ['answered']
        client = ASK.Client(self.url, CONVERSATION, GRANT)
        original = view
        try:
            globals()['view'] = lambda state, returned=None, answer=None, text='s': original(state, 'input')
            result = ASK.wait(client, ASK_ID, timeout=0, interval=0, sleep=lambda _s: None)
        finally:
            globals()['view'] = original
        self.assertEqual(result['returned'], 'input')
        self.assertEqual(FakeV2.collects, 0)

    def test_wait_timeout_is_pending_not_success(self):
        FakeV2.states = ['running']
        code, out, _ = self.run_cli('wait', ASK_ID, '--timeout', '0')
        self.assertEqual(code, ASK.PENDING_EXIT)
        self.assertEqual(json.loads(out)['ask']['state'], 'running')
        self.assertFalse(any(c[1].endswith('/collect') for c in FakeV2.calls))

    def test_refusals_and_bad_grants(self):
        code, _, err = self.run_cli('ask', 'nobody', '--text', 'x')
        self.assertEqual((code, json.loads(err)['code']), (ASK.ERROR_EXIT, 'target_unknown'))
        code, _, err = self.run_cli('ask', CONVERSATION[:-1] + 'f', '--text', 'x')
        self.assertEqual(json.loads(err)['code'], 'thread_ask_target_not_found')
        with unittest.mock.patch.dict(os.environ, {'ORKESTR_V2_THREAD_ASK_GRANT': 'short'}):
            code, _, err = self.run_cli('targets')
        self.assertEqual((code, json.loads(err)['code']), (ASK.ERROR_EXIT, 'grant_missing_or_invalid'))
        with tempfile.TemporaryDirectory() as root:
            loose = Path(root) / 'grant'
            loose.write_text(GRANT)
            loose.chmod(0o644)
            with self.assertRaises(ASK.AskError):
                ASK.read_grant(loose)
            loose.chmod(0o600)
            self.assertEqual(ASK.read_grant(loose), GRANT)


if __name__ == '__main__':
    unittest.main()
