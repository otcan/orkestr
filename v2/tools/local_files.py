#!/usr/bin/env python3
"""Files in the owner's local folder, from a running V2 turn (ORK-750 POC).

The owner connects a folder of his own computer in the Orkestr web app
(Chrome or Edge, "Connect folder" next to Attach). While that tab is open on
this conversation, this tool asks it to:

  list [PATH]                      one folder (default: the connected folder)
  read PATH                        upload one file; prints where it is on the server
  hash PATH [PATH ...]             SHA-256 of files, computed in the owner's browser
  write PATH (--text TEXT | --from-file FILE)
                                   create or replace one file (at most 1 MiB); it
                                   applies on its own while the folder is connected
  package PATH [PATH ...]          upload a tar of the selection
  status REQUEST_ID                one earlier request
  instructions                     the short agent rules

PATH is relative to the connected folder ("docs/plan.md"); it can never name
anything outside it. Every request waits for the owner's tab (--timeout,
default 120 s, at most 600 s). A tab in the background may poll only once a
minute, so a write's timeout is never below 120 s (a shorter one is raised).
Writes need no approval (ORK-810): the owner allowed changes when he
connected the folder, the tab applies them in order and lists each one in its
Folder activity. While the conversation's queue is full the tool waits and
asks again within its timeout. Each request prints its request key first
(stderr); after a lost answer rerun with --request-key KEY to get the same
request.

Exit status: 0 done, 3 not finished when the wait ended, 4 not done (not
found, no permission, expired, disconnected), 5 no folder connected, 2 refused
or failed.
The grant comes from --grant-file, ORKESTR_V2_LOCAL_FILES_GRANT, or the
provisioned file ORKESTR_V2_LOCAL_FILES_GRANT_DIR/<conversation>.local-files.grant
(the directory the agent-timer grant <conversation>.grant shares); it is never
printed.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import stat
import sys
import time
from urllib import error, parse, request
import uuid

GRANT_HEADER = 'X-Orkestr-Local-Files-Grant'
TERMINAL = ('done', 'failed')
PENDING_EXIT, FAILED_EXIT, NOT_CONNECTED_EXIT, ERROR_EXIT = 3, 4, 5, 2
WRITE_MAX = 1024 * 1024
TIMEOUT_MAX = 600.0
TIMEOUT_DEFAULT = 120.0
# A background tab may poll only once a minute: a write gets at least two.
WRITE_TIMEOUT_MIN = 120.0
# While the conversation's queue is full (429), ask again this often.
QUEUE_RETRY_INTERVAL = 2.0
GRANT_SUFFIX = '.local-files.grant'

AGENT_INSTRUCTIONS = """Files on the owner's computer (Orkestr local folder tool)

Only for files the owner asked you to work with. They live in a folder he
connected in the Orkestr web app; you see nothing else of his computer.

  local_files.py list                        # the connected folder
  local_files.py list "docs"
  local_files.py read "docs/plan.md"         # prints local_file: open that path
  local_files.py hash "a.pdf" "b.pdf"
  local_files.py package "docs/plan.md" "data/table.csv"
  local_files.py write "docs/plan.md" --from-file /tmp/plan.md

Exit 5 / local_files_not_connected means no folder is connected right now:
tell the owner to open this conversation in Chrome on his computer and press
"Connect folder", then try again. While it is connected, a write applies on
its own (no approval step); the owner sees each one in his Folder activity.
Keep the command running and check its output until it ends. Never report a
write as done unless the tool said "Wrote"; anything else means nothing was
written. Run the tool in your own shell, never through Root, sudo or another
user. Paths are relative to the folder; never try to reach anything outside
it.
"""


class LocalFilesError(RuntimeError):
    def __init__(self, status, code):
        super().__init__(f'{status}:{code}')
        self.status, self.code = status, code


def grant_path(conversation, environ=os.environ):
    root = environ.get('ORKESTR_V2_LOCAL_FILES_GRANT_DIR', '').strip()
    return Path(root) / f'{conversation}{GRANT_SUFFIX}' if root else None


def read_grant(path=None, environ=os.environ):
    if path:
        path = Path(path)
        try:
            info = path.lstat()
        except FileNotFoundError:
            raise LocalFilesError(0, 'grant_file_missing') from None
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise LocalFilesError(0, 'grant_file_must_be_private')
        value = path.read_text().strip()
    else:
        value = environ.get('ORKESTR_V2_LOCAL_FILES_GRANT', '').strip()
    if len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
        raise LocalFilesError(0, 'grant_missing_or_invalid')
    return value


def checked_path(value, root_allowed=False):
    """The same rule the server and the browser apply, checked early."""
    if value == '' and root_allowed:
        return value
    parts = value.split('/')
    if (not value or len(value.encode()) > 1024 or '\\' in value or len(parts) > 32
            or any(ord(c) < 32 or 127 <= ord(c) < 160 for c in value)
            or any(p in ('', '.', '..') or len(p.encode()) > 255 for p in parts)):
        raise LocalFilesError(0, 'invalid_path')
    return value


class Client:
    def __init__(self, base_url, conversation, grant, timeout=30):
        parsed = parse.urlsplit(base_url)
        if parsed.scheme not in {'http', 'https'} or not parsed.netloc or parsed.path not in {'', '/'}:
            raise LocalFilesError(0, 'invalid_base_url')
        try:
            uuid.UUID(conversation)
        except ValueError:
            raise LocalFilesError(0, 'invalid_conversation') from None
        self.base = f'{parsed.scheme}://{parsed.netloc}/api/v2/conversations/{conversation}/local-files'
        self.grant, self.timeout = grant, timeout

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        headers = {'Accept': 'application/json', GRANT_HEADER: self.grant}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        req = request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with request.urlopen(req, timeout=self.timeout) as response:
                raw = response.read()
        except error.HTTPError as failure:
            try:
                code = str(json.loads(failure.read()).get('code') or 'http_error')[:64]
            except (ValueError, AttributeError):
                code = 'http_error'
            finally:
                failure.close()
            raise LocalFilesError(failure.code, code) from None
        except (error.URLError, OSError):
            raise LocalFilesError(0, 'unreachable') from None
        return json.loads(raw) if raw else None

    def create(self, body):
        return self.call('POST', '/requests', body)['request']

    def status(self, request_id):
        return self.call('GET', f'/requests/{parse.quote(request_id)}')


def create_queued(client, body, timeout, interval=None, clock=time.monotonic, sleep=time.sleep):
    """Queue the request. While the conversation's queue is full (429
    local_files_rate_limited) wait and ask again with the same key, within
    the timeout: a batch is never cut short by the queue's size."""
    interval = QUEUE_RETRY_INTERVAL if interval is None else interval
    deadline = clock() + max(0.0, timeout)
    while True:
        try:
            return client.create(body)
        except LocalFilesError as failure:
            if failure.code != 'local_files_rate_limited' or clock() >= deadline:
                raise
            sleep(min(interval, max(0.0, deadline - clock())))


def wait(client, view, timeout, interval=1.0, clock=time.monotonic, sleep=time.sleep):
    deadline = clock() + max(0.0, timeout)
    while view['state'] not in TERMINAL and clock() < deadline:
        sleep(min(interval, max(0.0, deadline - clock())))
        view = client.status(view['request_id'])
    return view


def exit_status(view):
    if view['state'] == 'done':
        return 0
    if view['state'] == 'failed':
        return FAILED_EXIT
    return PENDING_EXIT


def request_body(args):
    body = {'request_key': args.request_key or f'lf-{uuid.uuid4()}', 'operation': args.action}
    if args.action == 'list':
        body['path'] = checked_path(args.path, root_allowed=True)
    elif args.action in ('read', 'write'):
        body['path'] = checked_path(args.path)
    else:
        if len(args.paths) > 64 or len(set(args.paths)) != len(args.paths):
            raise LocalFilesError(0, 'invalid_paths')
        body['paths'] = [checked_path(p) for p in args.paths]
    if args.action == 'write':
        content = args.text.encode() if args.text is not None else Path(args.from_file).read_bytes()
        if len(content) > WRITE_MAX:
            raise LocalFilesError(0, 'content_too_large')
        body['content_base64'] = base64.b64encode(content).decode()
    # The server deadline covers the whole wait; the tool waits a little longer.
    body['timeout_ms'] = int(max(5.0, min(TIMEOUT_MAX, request_timeout(args))) * 1000)
    return body


def request_timeout(args):
    """--timeout, else the default; a write never waits less than WRITE_TIMEOUT_MIN."""
    timeout = TIMEOUT_DEFAULT if args.timeout is None else args.timeout
    if args.action == 'write' and timeout < WRITE_TIMEOUT_MIN:
        print(f'write timeout raised to {WRITE_TIMEOUT_MIN:.0f} s: a background tab may poll only once a minute',
              file=sys.stderr)
        return WRITE_TIMEOUT_MIN
    return timeout


def parser():
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    root.add_argument('--v2-url', default=os.environ.get('ORKESTR_V2_URL'))
    root.add_argument('--conversation', default=os.environ.get('ORKESTR_V2_CONVERSATION'))
    root.add_argument('--grant-file')
    commands = root.add_subparsers(dest='action', required=True)
    commands.add_parser('instructions')
    status = commands.add_parser('status')
    status.add_argument('request_id')

    def operation(name):
        command = commands.add_parser(name)
        command.add_argument('--timeout', type=float, default=None,
                             help='seconds to wait (default 120, at most 600; a write at least 120)')
        command.add_argument('--request-key')
        return command
    operation('list').add_argument('path', nargs='?', default='')
    operation('read').add_argument('path')
    operation('hash').add_argument('paths', nargs='+')
    operation('package').add_argument('paths', nargs='+')
    write = operation('write')
    write.add_argument('path')
    content = write.add_mutually_exclusive_group(required=True)
    content.add_argument('--text')
    content.add_argument('--from-file')
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    if args.action == 'instructions':
        print(AGENT_INSTRUCTIONS, end='')
        return 0
    try:
        if not args.v2_url or not args.conversation:
            raise LocalFilesError(0, 'v2_url_and_conversation_required')
        path = args.grant_file
        if not path and not os.environ.get('ORKESTR_V2_LOCAL_FILES_GRANT'):
            path = grant_path(args.conversation)
        client = Client(args.v2_url, args.conversation, read_grant(path))
        if args.action == 'status':
            view = client.status(args.request_id)
            code = exit_status(view)
        else:
            body = request_body(args)
            print(f"request_key: {body['request_key']}", file=sys.stderr, flush=True)
            timeout = body['timeout_ms'] / 1000
            view = wait(client, create_queued(client, body, timeout), timeout + 5)
            code = exit_status(view)
    except LocalFilesError as failure:
        print(json.dumps({'ok': False, 'status': failure.status, 'code': failure.code}), file=sys.stderr)
        if failure.code == 'local_files_not_connected':
            print('No folder is connected: ask the owner to open this conversation in Chrome on his '
                  'computer and press "Connect folder".', file=sys.stderr)
            return NOT_CONNECTED_EXIT
        return ERROR_EXIT
    except OSError:
        print(json.dumps({'ok': False, 'code': 'content_file_unreadable'}), file=sys.stderr)
        return ERROR_EXIT
    print(json.dumps({'ok': code == 0, 'request': view}, indent=2, sort_keys=True))
    result = view.get('result') or {}
    if result.get('local_file'):
        print(f"local_file: {result['local_file']}")
    # The honest one-liner to relay; queued or waiting is never reported as done.
    print(view['status_text'], file=sys.stderr)
    return code


if __name__ == '__main__':
    raise SystemExit(main())
