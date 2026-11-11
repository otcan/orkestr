"""Offline checks for the reply attachment tool (ORK-779): workspace custody,
WhatsApp type and size limits, the agent grant and idempotent request keys."""
import base64
import contextlib
import hashlib
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
_SPEC = importlib.util.spec_from_file_location('reply_attach', ROOT / 'reply_attach.py')
ATTACH = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(ATTACH)

GRANT = 'cd' * 32
CONVERSATION = '00000000-0000-4000-8000-00000000000a'
MANIFEST = '00000000-0000-4000-8000-0000000000f1'


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

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        # Never an owner credential, cookie or browser origin.
        assert self.headers.get('Origin') is None and self.headers.get('Authorization') is None
        assert self.headers.get('Cookie') is None
        if self.headers.get('X-Orkestr-Agent-Timer-Grant') != GRANT:
            return self._reply(401, {'code': 'unauthorized'})
        assert self.path == f'/api/v2/conversations/{CONVERSATION}/agent-attachments', self.path
        FakeV2.calls.append(body)
        if body['files'][0]['filename'] == 'idle.pdf':
            return self._reply(409, {'code': 'agent_attachment_no_running_turn'})
        lines = ['[orkestr-attachment manifest=%s reference=00000000-0000-4000-8000-%012d name="%s"]'
                 % (MANIFEST, i, f['filename']) for i, f in enumerate(body['files'], 1)]
        return self._reply(201, {'manifest_id': MANIFEST, 'attachments': [], 'note': '\n'.join(lines)})


class ReplyAttachTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeV2)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = 'http://127.0.0.1:%d' % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        FakeV2.calls = []
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.workspace = self.root / 'workspace'
        (self.workspace / 'finance_checks' / 'october').mkdir(parents=True)
        self.package = self.workspace / 'finance_checks' / 'october' / 'Package 2026-10.zip'
        self.package.write_bytes(b'PK\x03\x04synthetic')
        (self.workspace / 'CHECKLIST.md').write_text('# Synthetic checklist\n')
        self.grant_dir = self.root / 'grants'
        self.grant_dir.mkdir(mode=0o700)
        grant = self.grant_dir / f'{CONVERSATION}.grant'
        grant.write_text(GRANT)
        grant.chmod(0o600)
        (self.root / 'outside.pdf').write_bytes(b'%PDF outside')

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, *args, workspace=None):
        out, err = io.StringIO(), io.StringIO()
        env = {'ORKESTR_V2_AGENT_TIMER_GRANT_DIR': str(self.grant_dir)}
        with unittest.mock.patch.dict(os.environ, env, clear=False), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            os.environ.pop('ORKESTR_V2_AGENT_TIMER_GRANT', None)
            code = ATTACH.main(['--v2-url', self.url, '--conversation', CONVERSATION,
                                '--workspace', str(workspace or self.workspace), *args])
        return code, out.getvalue(), err.getvalue()

    def test_attaches_workspace_files_and_prints_the_reply_lines(self):
        code, out, err = self.run_tool('attach', 'finance_checks/october/Package 2026-10.zip',
                                       str(self.workspace / 'CHECKLIST.md'))
        self.assertEqual(code, 0, err)
        lines = out.strip().split('\n')
        self.assertEqual(len(lines), 2)
        self.assertTrue(all(line.startswith('[orkestr-attachment manifest=') for line in lines))
        self.assertIn('Package 2026-10.zip', lines[0])
        self.assertNotIn(str(self.workspace), out + err, 'no workspace path in the reply lines or summary')
        self.assertIn('End your reply with the line(s)', err)
        (body,) = FakeV2.calls
        self.assertEqual([f['filename'] for f in body['files']], ['Package 2026-10.zip', 'CHECKLIST.md'])
        self.assertEqual([f['media_type'] for f in body['files']], ['application/zip', 'text/markdown'])
        self.assertEqual(base64.b64decode(body['files'][0]['content_base64']), b'PK\x03\x04synthetic')
        # A retry uses the same request key, so the server stores nothing new.
        self.run_tool('attach', 'finance_checks/october/Package 2026-10.zip', 'CHECKLIST.md')
        self.assertEqual(FakeV2.calls[0]['request_key'], FakeV2.calls[1]['request_key'])
        self.assertEqual(len(FakeV2.calls[0]['request_key']), 36)
        # Other content is another key.
        self.package.write_bytes(b'PK\x03\x04changed')
        self.run_tool('attach', 'finance_checks/october/Package 2026-10.zip', 'CHECKLIST.md')
        self.assertNotEqual(FakeV2.calls[1]['request_key'], FakeV2.calls[2]['request_key'])

    def test_only_files_inside_the_workspace_and_no_links_out(self):
        (self.workspace / 'linked.pdf').symlink_to(self.root / 'outside.pdf')
        (self.workspace / 'out').symlink_to(self.root, target_is_directory=True)
        (self.workspace / '.git').mkdir()
        (self.workspace / '.git' / 'notes.txt').write_text('hidden')
        (self.workspace / 'secrets').mkdir()
        (self.workspace / 'secrets' / 'keys.txt').write_text('synthetic')
        cases = {
            '../outside.pdf': 'file_outside_workspace',
            str(self.root / 'outside.pdf'): 'file_outside_workspace',
            'finance_checks/../../outside.pdf': 'file_outside_workspace',
            'linked.pdf': 'file_symlink_refused',
            'out/outside.pdf': 'file_symlink_refused',
            '.git/notes.txt': 'file_refused',
            'secrets/keys.txt': 'file_refused',
            'missing.pdf': 'file_missing',
        }
        for path, expected in cases.items():
            code, out, err = self.run_tool('attach', path)
            self.assertEqual(code, 2, path)
            self.assertEqual(json.loads(err)['code'], expected, path)
            self.assertEqual(out, '')
        self.assertEqual(FakeV2.calls, [], 'nothing was uploaded')

    def test_whatsapp_types_and_sizes_only(self):
        (self.workspace / 'page.html').write_text('<p>synthetic</p>')
        (self.workspace / 'empty.pdf').write_bytes(b'')
        (self.workspace / 'folder.pdf').mkdir()
        big = self.workspace / 'big.pdf'
        with big.open('wb') as handle:
            handle.truncate(ATTACH.MAX_BYTES + 1)
        for path, expected in [('page.html', 'file_type_unsupported'), ('empty.pdf', 'file_size_refused'),
                               ('big.pdf', 'file_size_refused'), ('folder.pdf', 'file_not_regular')]:
            code, _, err = self.run_tool('attach', path)
            self.assertEqual((code, json.loads(err)['code']), (2, expected), path)
        code, _, err = self.run_tool('attach', *(['CHECKLIST.md'] * 9))
        self.assertEqual(json.loads(err)['code'], 'file_count_refused')
        self.assertEqual(FakeV2.calls, [])

    def test_check_sends_nothing_and_refusals_keep_the_request_key(self):
        code, out, _ = self.run_tool('check', 'CHECKLIST.md')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)['media_type'], 'text/markdown')
        self.assertEqual(FakeV2.calls, [])
        (self.workspace / 'idle.pdf').write_bytes(b'%PDF synthetic')
        code, out, err = self.run_tool('attach', 'idle.pdf')
        line = json.loads(err)
        self.assertEqual((code, line['status'], line['code']), (2, 409, 'agent_attachment_no_running_turn'))
        self.assertIn('--request-key', line['retry'])
        self.assertEqual(out, '')

    def test_a_grant_file_of_another_user_or_mode_is_refused(self):
        (self.grant_dir / f'{CONVERSATION}.grant').chmod(0o644)
        code, _, err = self.run_tool('attach', 'CHECKLIST.md')
        self.assertEqual((code, json.loads(err)['code']), (2, 'grant_file_must_be_private'))
        self.assertEqual(FakeV2.calls, [])

    def test_instructions_name_the_exact_command(self):
        code, out, _ = self.run_tool('instructions', '--grant-dir', '/srv/grants')
        self.assertEqual(code, 0)
        self.assertIn('ORKESTR_V2_AGENT_TIMER_GRANT_DIR=/srv/grants', out)
        self.assertIn(f'--conversation {CONVERSATION}', out)
        self.assertIn(f'--workspace {self.workspace}', out)
        self.assertIn('set -- attach', out)
        self.assertIn('Never answer with a\nMarkdown link or a path', out)


if __name__ == '__main__':
    unittest.main()
