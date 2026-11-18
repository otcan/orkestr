"""The workspace reader keeps every request inside its conversation's folder."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


READER = load('workspace_reader')
PINNED = '00000000-0000-4000-8000-0000000000a1'
OTHER = '00000000-0000-4000-8000-0000000000b2'


class Folders(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(os.path.realpath(self.temp.name))
        self.base = base
        self.pinned = base / 'pinned'
        self.default = base / 'shared'
        self.claude = base / 'claude-shared'
        self.outside = base / 'outside'
        for folder in (self.pinned, self.default, self.claude, self.outside):
            folder.mkdir()
        (self.outside / 'private.txt').write_text('outside the folder')
        (self.pinned / 'docs').mkdir()
        (self.pinned / 'docs' / 'plan.md').write_text('# Plan\n')
        (self.pinned / 'notes.txt').write_text('hello\n')
        os.utime(self.pinned / 'notes.txt', (1_700_000_000, 1_700_000_000))
        (self.pinned / 'big.log').write_bytes(b'x' * 4096)
        (self.default / 'shared.txt').write_text('shared')
        self.plan_path = base / 'beta.json'
        self.write_plan()
        self.reader = READER.Reader(str(self.plan_path), [os.getuid()])

    def tearDown(self):
        self.temp.cleanup()

    def write_plan(self, **extra):
        plan = {'workspace': str(self.default), 'claude': {'workspace': str(self.claude)},
                'conversation_workspaces': {PINNED: {'path': str(self.pinned), 'shared': True}}}
        plan.update(extra)
        self.plan_path.write_text(json.dumps(plan))

    def ask(self, op='list', path='', conversation=PINNED, provider='codex', **fields):
        request = {'version': 1, 'op': op, 'conversation_id': conversation, 'provider': provider, 'path': path}
        if op == 'read':
            request.update(limit=fields.pop('limit', 1024 * 1024), partial=fields.pop('partial', False))
        request.update(fields)
        try:
            reply, fd, length = self.reader.answer(READER.parse_request(json.dumps(request)))
        except READER.Refused as refusal:
            return {'ok': False, 'error': refusal.code, **refusal.details}, b''
        body = b''
        if fd is not None:
            try:
                body = os.pread(fd, length, 0)
            finally:
                os.close(fd)
        return reply, body

    def names(self, path='', **kw):
        reply, _ = self.ask(path=path, **kw)
        self.assertTrue(reply['ok'], reply)
        return [entry['name'] for entry in reply['entries']]


class Confinement(Folders):
    def test_lists_folders_first_then_newest_first(self):
        reply, _ = self.ask()
        self.assertEqual(reply['root_kind'], 'conversation')
        self.assertEqual(reply['root_name'], 'pinned')
        self.assertEqual([e['name'] for e in reply['entries']], ['docs', 'big.log', 'notes.txt'])
        notes = reply['entries'][-1]
        self.assertEqual((notes['kind'], notes['size'], notes['modified_ms']), ('file', 6, 1_700_000_000_000))
        self.assertEqual(self.names('docs'), ['plan.md'])

    def test_unpinned_chats_get_the_shared_default_of_their_provider(self):
        reply, _ = self.ask(conversation=OTHER)
        self.assertEqual((reply['root_kind'], reply['root_name']), ('shared_default', 'shared'))
        self.assertEqual(self.names(conversation=OTHER), ['shared.txt'])
        reply, _ = self.ask(conversation=OTHER, provider='claude')
        self.assertEqual((reply['root_kind'], reply['root_name']), ('shared_default', 'claude-shared'))

    def test_traversal_and_absolute_paths_are_refused(self):
        for path, code in [('..', 'traversal'), ('docs/../..', 'traversal'), ('docs/./plan.md', 'traversal'),
                           ('/etc/passwd', 'absolute_path'), (str(self.outside), 'absolute_path'),
                           ('docs//plan.md', 'invalid_path'), ('docs/', 'invalid_path'), ('a\nb', 'invalid_path'),
                           ('a\x00b', 'invalid_path'), ('x' * 5000, 'invalid_path')]:
            for op in ('list', 'read'):
                reply, body = self.ask(op=op, path=path)
                self.assertEqual((reply['ok'], reply['error'], body), (False, code, b''), (op, path))

    def test_a_symlink_that_leaves_the_folder_is_never_followed(self):
        (self.pinned / 'escape').symlink_to(self.outside)
        (self.pinned / 'escape.txt').symlink_to(self.outside / 'private.txt')
        (self.pinned / 'up').symlink_to('..')
        reply, _ = self.ask()
        links = {e['name']: e for e in reply['entries'] if e['kind'] == 'link'}
        self.assertEqual({name: e['target'] for name, e in links.items()},
                         {'escape': 'outside', 'escape.txt': 'outside', 'up': 'outside'})
        for op, path in [('list', 'escape'), ('read', 'escape/private.txt'), ('read', 'escape.txt'),
                         ('list', 'up'), ('read', 'up/outside/private.txt')]:
            reply, body = self.ask(op=op, path=path)
            self.assertEqual((reply['error'], body), ('outside_root', b''), (op, path))

    def test_a_symlink_inside_the_folder_is_followed(self):
        (self.pinned / 'latest').symlink_to('docs')
        (self.pinned / 'readme').symlink_to('docs/plan.md')
        reply, _ = self.ask()
        targets = {e['name']: e.get('target') for e in reply['entries']}
        self.assertEqual((targets['latest'], targets['readme']), ('dir', 'file'))
        self.assertEqual(reply['entries'][0]['name'] in ('docs', 'latest'), True, 'linked folders sort with folders')
        self.assertEqual(self.names('latest'), ['plan.md'])
        reply, body = self.ask(op='read', path='readme')
        self.assertEqual((reply['ok'], body), (True, b'# Plan\n'))

    def test_a_part_swapped_for_a_symlink_after_resolution_is_refused(self):
        root_fd = READER.open_root(str(self.pinned))
        try:
            real = READER.resolve(str(self.pinned), ['docs', 'plan.md'])
            (self.pinned / 'docs').rename(self.pinned / 'docs-moved')
            (self.pinned / 'docs').symlink_to(self.outside)
            with self.assertRaises(READER.Refused) as caught:
                READER.walk(root_fd, real, os.O_RDONLY, regular=True)
            self.assertEqual(caught.exception.code, 'changed')
        finally:
            os.close(root_fd)

    def test_protected_names_are_hidden_at_any_depth(self):
        for name in ['.ssh', '.codex', '.claude', '.aws', '.env', '.env.local', 'prod.env', 'server.key', 'cert.pem',
                     'id_ed25519', 'id_rsa.pub', 'auth.json', 'github_token.txt', 'authToken.json', 'TOKEN',
                     'api_key.txt', 'apiKey.js', 'client_secret.json', 'credentials', 'my-passwords.txt',
                     '.git-credentials', '.netrc', 'secrets']:
            path = self.pinned / name
            path.write_text('protected')
            self.assertTrue(READER.protected(name), name)
        (self.pinned / 'docs' / '.env').write_text('protected')
        (self.pinned / 'project').mkdir()
        (self.pinned / 'project' / '.codex').mkdir()
        (self.pinned / 'project' / '.codex' / 'notes.txt').write_text('inside a protected folder')
        for name in ['tokenizer.py', 'keys.md', 'environment.md', 'monkey.png', 'notes.md']:
            self.assertFalse(READER.protected(name), name)
        reply, _ = self.ask()
        self.assertEqual(sorted(e['name'] for e in reply['entries']), ['big.log', 'docs', 'notes.txt', 'project'])
        self.assertEqual(reply['hidden'], 23)
        reply, _ = self.ask(path='docs')
        self.assertEqual(([e['name'] for e in reply['entries']], reply['hidden']), (['plan.md'], 1))
        for op, path in [('read', '.env'), ('read', 'docs/.env'), ('list', '.ssh'), ('read', 'auth.json'),
                         ('list', 'project/.codex'), ('read', 'project/.codex/notes.txt')]:
            reply, body = self.ask(op=op, path=path)
            self.assertEqual((reply['error'], body), ('protected', b''), (op, path))

    def test_a_link_to_a_protected_file_is_hidden_and_refused(self):
        (self.pinned / '.env').write_text('protected')
        (self.pinned / 'settings').symlink_to('.env')
        reply, _ = self.ask()
        self.assertNotIn('settings', [e['name'] for e in reply['entries']])
        reply, _ = self.ask(op='read', path='settings')
        self.assertEqual(reply['error'], 'protected')

    def test_read_caps(self):
        reply, body = self.ask(op='read', path='big.log', limit=1024)
        self.assertEqual((reply['ok'], reply['error'], reply['size'], body), (False, 'too_large', 4096, b''))
        reply, body = self.ask(op='read', path='big.log', limit=1024, partial=True)
        self.assertEqual((reply['size'], reply['length'], len(body)), (4096, 1024, 1024))
        reply, body = self.ask(op='read', path='notes.txt')
        self.assertEqual((reply['size'], reply['length'], body), (6, 6, b'hello\n'))
        with self.assertRaises(READER.Refused):
            READER.parse_request(json.dumps({'version': 1, 'op': 'read', 'conversation_id': PINNED,
                                             'provider': 'codex', 'path': 'big.log',
                                             'limit': READER.READ_MAX + 1, 'partial': False}))

    def test_folders_fifos_and_missing_files_are_not_read(self):
        os.mkfifo(self.pinned / 'pipe')
        for path, code in [('docs', 'not_a_file'), ('pipe', 'not_a_file'), ('', 'not_a_file'),
                           ('missing.txt', 'not_found'), ('notes.txt/x', 'not_a_directory')]:
            reply, _ = self.ask(op='read', path=path)
            self.assertEqual(reply['error'], code, path)
        reply, _ = self.ask(path='notes.txt')
        self.assertEqual(reply['error'], 'not_a_directory')

    def test_a_missing_folder_is_reported_cleanly(self):
        self.write_plan(conversation_workspaces={PINNED: str(self.base / 'gone')})
        for op, path in [('list', ''), ('list', 'docs'), ('read', 'notes.txt')]:
            reply, _ = self.ask(op=op, path=path)
            self.assertEqual(reply['error'], 'root_missing', (op, path))

    def test_requests_are_closed(self):
        good = {'version': 1, 'op': 'list', 'conversation_id': PINNED, 'provider': 'codex', 'path': ''}
        READER.parse_request(json.dumps(good))
        for change in [{'op': 'write'}, {'op': 'delete'}, {'version': 2}, {'provider': 'other'},
                       {'conversation_id': 'not-a-uuid'}, {'root': '/etc'}, {'limit': 5}]:
            with self.assertRaises(READER.Refused, msg=change):
                READER.parse_request(json.dumps({**good, **change}))

    def test_a_plan_with_a_relative_or_malformed_folder_is_refused(self):
        for plan in [{'workspace': 'relative'}, {'workspace': '/'}, {'workspace': '/a/../b'},
                     {'workspace': str(self.default), 'conversation_workspaces': {'x': '/a'}},
                     {'workspace': str(self.default), 'conversation_workspaces': {PINNED: 'relative'}}]:
            self.plan_path.write_text(json.dumps(plan))
            with self.assertRaises(READER.Refused, msg=plan):
                READER.Plan(str(self.plan_path)).load()

    def test_serve_needs_a_named_peer(self):
        for argv in [['serve', '--plan', str(self.plan_path), '--socket', str(self.base / 's.sock')],
                     ['serve', '--plan', str(self.plan_path), '--peer-user', 'no-such-user-for-this-test']]:
            with self.assertRaises(SystemExit, msg=argv):
                READER.main(argv)
        self.assertFalse((self.base / 's.sock').exists())


class Socket(Folders):
    def serve(self, peer_uids):
        self.reader.peer_uids = frozenset(peer_uids)
        path = str(self.base / 'reader.sock')
        listener = READER.listener(path)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        threading.Thread(target=self.reader.serve, args=(listener,), daemon=True).start()
        return path

    def exchange(self, path, request):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.connect(path)
            client.sendall(json.dumps(request).encode() + b'\n')
            data = b''
            while True:
                try:
                    chunk = client.recv(65536)
                except ConnectionResetError:
                    break
                if not chunk:
                    break
                data += chunk
        if not data:
            return None, b''
        line, _, body = data.partition(b'\n')
        return json.loads(line), body

    def test_a_read_streams_exactly_its_length(self):
        path = self.serve([os.getuid()])
        request = {'version': 1, 'op': 'read', 'conversation_id': PINNED, 'provider': 'codex',
                   'path': 'big.log', 'limit': 100, 'partial': True}
        header, body = self.exchange(path, request)
        self.assertEqual((header['length'], body), (100, b'x' * 100))
        header, body = self.exchange(path, {**request, 'path': '../outside/private.txt'})
        self.assertEqual((header, body), ({'ok': False, 'error': 'traversal'}, b''))

    def test_an_unlisted_peer_gets_nothing(self):
        path = self.serve([os.getuid() + 1])
        request = {'version': 1, 'op': 'list', 'conversation_id': PINNED, 'provider': 'codex', 'path': ''}
        self.assertEqual(self.exchange(path, request), (None, b''))


if __name__ == '__main__':
    unittest.main()
