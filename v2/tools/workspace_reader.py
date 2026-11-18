#!/usr/bin/env python3
"""Read-only view of each conversation's working folder, for the Files panel.

Core is the web-facing process and is kept out of project trees: on a
split-identity host it cannot open them at all. This reader runs on the side
that already has access (the workspace owner, for example the executor UID)
and answers Core over a Unix socket that only Core may use. Every check that
keeps a request inside its folder runs here, not in Core:

- The folder comes from the operator's runtime plan (`beta.json`): the
  conversation's pinned workspace (`conversation_workspaces`), otherwise the
  provider's default workspace, which every chat without its own folder
  shares. Core names a conversation, its provider and a relative path; it
  never names a folder.
- A path is relative and has no empty, `.` or `..` part, NUL or control
  character. Each part is opened from the folder's descriptor with
  O_NOFOLLOW, so a part swapped for a symlink during a request is refused. A
  symlink is followed only when its real path stays inside the folder; the
  real path is then walked the same way.
- Protected names (keys, tokens, credentials, `.env` files, `.ssh`, `.codex`
  and the like) are never listed, opened or followed, at any depth. This
  hides secret-shaped files; it does not stop an agent that deliberately
  copies a secret under another name.
- There is no write, rename or delete operation.

Protocol: one JSON request line (at most 8 KiB), one JSON reply line; a
successful read reply is followed by exactly `length` raw bytes.

    {"version":1,"op":"list","conversation_id":ID,"provider":"codex","path":"docs"}
    {"version":1,"op":"read","conversation_id":ID,"provider":"codex",
     "path":"docs/a.md","limit":524288,"partial":true}

`serve --plan PLAN (--peer-uid UID | --peer-user NAME) [--socket PATH]` runs
the reader; with systemd socket activation (LISTEN_FDS=1) it uses the passed
socket, otherwise it binds PATH with mode 0600. Only a peer whose SO_PEERCRED
uid is listed may ask. `check --plan PLAN` validates the plan and prints the
number of pinned folders. See `docs/v2/workspace-files.md`.
"""
import argparse
import json
import os
import pwd
import re
import socket
import stat
import struct
import sys
import threading

VERSION = 1
REQUEST_MAX = 8192
PLAN_MAX = 4 * 1024 * 1024
LIST_MAX = 1000
READ_MAX = 25 * 1024 * 1024
PATH_BYTES_MAX = 4096
PARTS_MAX = 64
CONCURRENCY = 16
IDLE_SECONDS = 15
CHUNK = 256 * 1024
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')

# Exact names (case-insensitive) that are never shown, at any depth.
PROTECTED_NAMES = frozenset({
    '.ssh', '.gnupg', '.gpg', '.codex', '.claude', '.claude.json', '.aws', '.azure', '.kube', '.docker',
    '.gcloud', '.password-store', '.vault-token', '.netrc', '_netrc', '.npmrc', '.pypirc',
    '.pgpass', '.git-credentials', '.htpasswd', '.my.cnf', 'auth.json', '.credentials.json',
    'secrets', '.secrets', 'keyring', 'keyrings', '.keyrings', 'known_hosts', 'authorized_keys',
})
PROTECTED_PREFIXES = ('id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.env.')
PROTECTED_SUFFIXES = ('.env', '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx', '.ppk')
# Substrings that are almost never an innocent file name.
PROTECTED_FRAGMENTS = ('credential', 'secret', 'passw', 'private_key', 'private-key', 'privatekey')
# Whole words (a name split at punctuation and camelCase): `github_token.txt`
# and `authToken.json` are protected, `tokenizer.py` is not.
PROTECTED_WORDS = frozenset({'token', 'tokens', 'creds', 'apikey', 'apikeys', 'passwd'})
PROTECTED_PAIRS = frozenset({('api', 'key'), ('api', 'keys'), ('access', 'key'), ('private', 'key'),
                             ('auth', 'token'), ('session', 'key')})


class Refused(Exception):
    def __init__(self, code, **details):
        super().__init__(code)
        self.code = code
        self.details = details


def words(name):
    spaced = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', name)
    return [w for w in re.split(r'[^A-Za-z0-9]+', spaced.lower()) if w]


def protected(name):
    """Whether a single path part names something secret-shaped."""
    lower = name.lower()
    if lower in PROTECTED_NAMES or lower == '.env':
        return True
    if lower.startswith(PROTECTED_PREFIXES) or lower.endswith(PROTECTED_SUFFIXES):
        return True
    if any(fragment in lower for fragment in PROTECTED_FRAGMENTS):
        return True
    parts = words(name)
    if any(word in PROTECTED_WORDS for word in parts):
        return True
    return any(pair in PROTECTED_PAIRS for pair in zip(parts, parts[1:]))


def clean_name(name):
    return (type(name) is str and name not in ('', '.', '..') and '/' not in name
            and not any(ord(c) < 32 or ord(c) == 127 for c in name)
            and not any(0xD800 <= ord(c) <= 0xDFFF for c in name))


def split_path(path):
    """The parts of a request path, or Refused. The empty path is the folder."""
    if type(path) is not str or len(path.encode('utf-8', 'surrogatepass')) > PATH_BYTES_MAX:
        raise Refused('invalid_path')
    if path == '':
        return []
    if path.startswith('/'):
        raise Refused('absolute_path')
    parts = path.split('/')
    if len(parts) > PARTS_MAX:
        raise Refused('invalid_path')
    for part in parts:
        if part in ('.', '..'):
            raise Refused('traversal')
        if not clean_name(part):
            raise Refused('invalid_path')
    for part in parts:
        if protected(part):
            raise Refused('protected')
    return parts


def absolute(value):
    return (type(value) is str and value.startswith('/') and value != '/' and '\0' not in value
            and not value.endswith('/') and len(value) <= 4096
            and all(part not in ('', '.', '..') for part in value.split('/')[1:]))


class Plan:
    """The folders of the operator's runtime plan, re-read when the file changes."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.seen = None
        self.value = None

    def load(self):
        info = os.stat(self.path)
        key = (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size)
        with self.lock:
            if key != self.seen:
                self.value = self.parse(self.read())
                self.seen = key
            return self.value

    def read(self):
        with open(self.path, 'rb') as handle:
            raw = handle.read(PLAN_MAX + 1)
        if len(raw) > PLAN_MAX:
            raise Refused('plan_invalid')
        return raw

    @staticmethod
    def parse(raw):
        try:
            plan = json.loads(raw)
        except ValueError:
            raise Refused('plan_invalid') from None
        if type(plan) is not dict or not absolute(plan.get('workspace')):
            raise Refused('plan_invalid')
        claude = plan.get('claude')
        claude = claude.get('workspace') if type(claude) is dict else None
        if claude is not None and not absolute(claude):
            raise Refused('plan_invalid')
        pinned = {}
        mapping = plan.get('conversation_workspaces', {})
        if type(mapping) is not dict:
            raise Refused('plan_invalid')
        for conversation, entry in mapping.items():
            path = entry.get('path') if type(entry) is dict else entry
            if type(conversation) is not str or not UUID.match(conversation) or not absolute(path):
                raise Refused('plan_invalid')
            pinned[conversation] = path
        return {'default': plan['workspace'], 'claude': claude, 'pinned': pinned}


def root_of(plan, conversation, provider):
    if conversation in plan['pinned']:
        return plan['pinned'][conversation], 'conversation'
    if provider == 'claude' and plan['claude']:
        return plan['claude'], 'shared_default'
    return plan['default'], 'shared_default'


def open_root(path):
    try:
        if os.path.realpath(path) != path:
            raise Refused('root_unavailable')
        return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        raise Refused('root_missing') from None
    except PermissionError:
        raise Refused('root_unreadable') from None
    except OSError:
        raise Refused('root_unavailable') from None


def resolve(root, parts):
    """The real parts of `parts` inside `root`; a link may not leave it."""
    if not parts:
        return []
    real = os.path.realpath(os.path.join(root, *parts))
    if real == root:
        return []
    if not real.startswith(root + '/'):
        raise Refused('outside_root')
    result = real[len(root) + 1:].split('/')
    if any(protected(part) for part in result):
        raise Refused('protected')
    return result


def walk(root_fd, parts, final_flags, regular=False):
    """Open `parts` one at a time from the folder, refusing any symlink.

    With `regular`, the last part is checked to be a regular file before it
    is opened, so a device or FIFO is never opened at all."""
    fd = os.dup(root_fd)
    try:
        for index, part in enumerate(parts):
            last = index == len(parts) - 1
            flags = (final_flags if last else os.O_RDONLY | os.O_DIRECTORY) | os.O_NOFOLLOW | os.O_CLOEXEC
            try:
                if last and regular and not stat.S_ISREG(os.stat(part, dir_fd=fd, follow_symlinks=False).st_mode):
                    raise Refused('not_a_file')
                child = os.open(part, flags, dir_fd=fd)
            except FileNotFoundError:
                raise Refused('not_found') from None
            except NotADirectoryError:
                raise Refused('changed' if is_link(part, fd) else 'not_a_directory') from None
            except PermissionError:
                raise Refused('unreadable') from None
            except OSError as error:
                # ELOOP: a part became a symlink after the path was resolved.
                raise Refused('changed' if error.errno == 40 else 'unreadable') from None
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def is_link(part, fd):
    try:
        return stat.S_ISLNK(os.stat(part, dir_fd=fd, follow_symlinks=False).st_mode)
    except OSError:
        return False


def modified_ms(info):
    return info.st_mtime_ns // 1_000_000


def link_target(root, directory, name):
    """What an in-folder symlink points to: dir, file, outside, protected or broken."""
    real = os.path.realpath(os.path.join(root, *directory, name))
    if real != root and not real.startswith(root + '/'):
        return 'outside'
    if real != root and any(protected(part) for part in real[len(root) + 1:].split('/')):
        return 'protected'
    try:
        info = os.stat(real)
    except OSError:
        return 'broken'
    return 'dir' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'other'


def listing(root, parts):
    root_fd = open_root(root)
    try:
        real_parts = resolve(root, parts)
        fd = walk(root_fd, real_parts, os.O_RDONLY | os.O_DIRECTORY) if real_parts else os.dup(root_fd)
    finally:
        os.close(root_fd)
    entries, hidden, skipped = [], 0, 0
    try:
        with os.scandir(fd) as items:
            for item in items:
                name = item.name
                if not clean_name(name):
                    skipped += 1
                    continue
                if protected(name):
                    hidden += 1
                    continue
                try:
                    info = item.stat(follow_symlinks=False)
                except OSError:
                    skipped += 1
                    continue
                mode = info.st_mode
                entry = {'name': name, 'modified_ms': modified_ms(info)}
                if stat.S_ISDIR(mode):
                    entry['kind'] = 'dir'
                elif stat.S_ISREG(mode):
                    entry.update(kind='file', size=info.st_size)
                elif stat.S_ISLNK(mode):
                    target = link_target(root, real_parts, name)
                    if target == 'protected':
                        hidden += 1
                        continue
                    entry.update(kind='link', target=target)
                else:
                    entry['kind'] = 'other'
                entries.append(entry)
    finally:
        os.close(fd)
    entries.sort(key=lambda e: (e['kind'] != 'dir' and not (e['kind'] == 'link' and e.get('target') == 'dir'),
                                -e['modified_ms'], e['name']))
    truncated = len(entries) > LIST_MAX
    return {'ok': True, 'path': '/'.join(parts), 'entries': entries[:LIST_MAX],
            'hidden': hidden, 'skipped': skipped, 'truncated': truncated}


def open_file(root, parts):
    if not parts:
        raise Refused('not_a_file')
    root_fd = open_root(root)
    try:
        real_parts = resolve(root, parts)
        if not real_parts:
            raise Refused('not_a_file')
        fd = walk(root_fd, real_parts, os.O_RDONLY | os.O_NONBLOCK, regular=True)
    finally:
        os.close(root_fd)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        os.close(fd)
        raise Refused('not_a_file')
    return fd, info


def number(value, low, high):
    return type(value) is int and low <= value <= high


def parse_request(raw):
    try:
        request = json.loads(raw)
    except ValueError:
        raise Refused('invalid_request') from None
    if type(request) is not dict or request.get('version') != VERSION:
        raise Refused('invalid_request')
    op = request.get('op')
    fields = {'version', 'op', 'conversation_id', 'provider', 'path'}
    if op == 'read':
        fields |= {'limit', 'partial'}
    elif op != 'list':
        raise Refused('invalid_request')
    if set(request) != fields:
        raise Refused('invalid_request')
    if type(request['conversation_id']) is not str or not UUID.match(request['conversation_id']):
        raise Refused('invalid_request')
    if request['provider'] not in ('codex', 'claude'):
        raise Refused('invalid_request')
    if op == 'read' and (not number(request['limit'], 1, READ_MAX) or type(request['partial']) is not bool):
        raise Refused('invalid_request')
    return request


class Reader:
    def __init__(self, plan_path, peer_uids):
        self.plan = Plan(plan_path)
        self.peer_uids = frozenset(peer_uids)
        self.slots = threading.BoundedSemaphore(CONCURRENCY)

    def answer(self, request):
        """The reply for a list request, or (header, fd, length) for a read."""
        plan = self.plan.load()
        root, kind = root_of(plan, request['conversation_id'], request['provider'])
        parts = split_path(request['path'])
        if request['op'] == 'list':
            reply = listing(root, parts)
            reply.update(root_kind=kind, root_name=os.path.basename(root))
            return reply, None, 0
        fd, info = open_file(root, parts)
        size = info.st_size
        if size > request['limit'] and not request['partial']:
            os.close(fd)
            raise Refused('too_large', size=size)
        length = min(size, request['limit'])
        header = {'ok': True, 'path': '/'.join(parts), 'size': size, 'length': length,
                  'modified_ms': modified_ms(info), 'root_kind': kind}
        return header, fd, length

    def peer_allowed(self, connection):
        raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
        _pid, uid, _gid = struct.unpack('3i', raw)
        return uid in self.peer_uids

    def handle(self, connection):
        fd = None
        try:
            connection.settimeout(IDLE_SECONDS)
            if not self.peer_allowed(connection):
                return
            raw = b''
            while not raw.endswith(b'\n'):
                chunk = connection.recv(REQUEST_MAX + 1 - len(raw))
                if not chunk:
                    return
                raw += chunk
                if len(raw) > REQUEST_MAX:
                    raise Refused('invalid_request')
            try:
                header, fd, length = self.answer(parse_request(raw))
            except Refused as refusal:
                header, fd, length = {'ok': False, 'error': refusal.code, **refusal.details}, None, 0
            except OSError:
                header, fd, length = {'ok': False, 'error': 'unreadable'}, None, 0
            connection.sendall(json.dumps(header, separators=(',', ':')).encode() + b'\n')
            sent = 0
            while sent < length:
                chunk = os.pread(fd, min(CHUNK, length - sent), sent)
                if not chunk:
                    # The file shrank: close short, so Core never takes it as whole.
                    return
                connection.sendall(chunk)
                sent += len(chunk)
        except (OSError, Refused):
            return
        finally:
            if fd is not None:
                os.close(fd)
            connection.close()

    def serve(self, listener):
        while True:
            connection, _ = listener.accept()
            if not self.slots.acquire(blocking=False):
                connection.close()
                continue
            threading.Thread(target=self.run, args=(connection,), daemon=True).start()

    def run(self, connection):
        try:
            self.handle(connection)
        finally:
            self.slots.release()


def listener(path):
    if os.environ.get('LISTEN_PID') == str(os.getpid()) and os.environ.get('LISTEN_FDS') == '1':
        sock = socket.socket(fileno=3)
        if sock.family != socket.AF_UNIX or sock.type != socket.SOCK_STREAM:
            raise SystemExit('the passed socket is not a Unix stream socket')
        return sock
    if not path:
        raise SystemExit('no socket: pass --socket or use socket activation')
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    previous = os.umask(0o177)
    try:
        sock.bind(path)
    finally:
        os.umask(previous)
    sock.listen(64)
    return sock


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    commands = parser.add_subparsers(dest='command', required=True)
    serve = commands.add_parser('serve')
    serve.add_argument('--plan', required=True)
    serve.add_argument('--peer-uid', type=int, action='append', default=[])
    serve.add_argument('--peer-user', action='append', default=[], help='a user name, resolved to its uid')
    serve.add_argument('--socket')
    check = commands.add_parser('check')
    check.add_argument('--plan', required=True)
    args = parser.parse_args(argv)
    if args.command == 'check':
        try:
            plan = Plan(args.plan).load()
        except (Refused, OSError) as error:
            print('plan refused: %s' % error, file=sys.stderr)
            return 2
        print('plan ok: %d pinned folders' % len(plan['pinned']))
        return 0
    peers = list(args.peer_uid)
    for name in args.peer_user:
        try:
            peers.append(pwd.getpwnam(name).pw_uid)
        except KeyError:
            raise SystemExit('unknown --peer-user %s' % name) from None
    if not peers or any(uid < 0 for uid in peers):
        raise SystemExit('name the peer allowed to ask: --peer-uid UID or --peer-user NAME')
    reader = Reader(args.plan, peers)
    reader.plan.load()
    reader.serve(listener(args.socket))
    return 0


if __name__ == '__main__':
    sys.exit(main())
