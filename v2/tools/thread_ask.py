#!/usr/bin/env python3
"""Ask another thread of the same owner, from a running V2 turn ("ask thread X").

Uses only this conversation's thread-ask grant (never owner credentials, the
V1 CLI or browser pairing) against the V2 API:

  targets
  ask TARGET (--text TEXT | --text-file PATH) [--request-key KEY] [--wait SECONDS]
  status ASK_ID
  wait ASK_ID [--timeout SECONDS]

TARGET is a conversation UUID or an exact (case-insensitive) name from
`targets`. `ask` records the request in the target thread; Orkestr starts the
target's own turn and returns its final answer exactly once: to the asking turn
if it is still running and collects it (`--wait` or `wait`; that turn may
collect again), otherwise as a new message in this thread. Requests that are
not answered within the window lifetime ceiling fail as `expired`. A request that is only `sent` has NOT been processed.

Exit status: 0 answered (or sent, without --wait), 3 not answered yet when the
wait ended, 4 the target did not answer, 2 refused or failed.
The grant comes from --grant-file, ORKESTR_V2_THREAD_ASK_GRANT, or the
provisioned file ORKESTR_V2_THREAD_ASK_GRANT_DIR/<conversation>.grant (see
thread_ask_provision.py); it is never printed. `instructions` prints the short
agent rules.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time
from urllib import error, parse, request
import uuid

GRANT_HEADER = 'X-Orkestr-Thread-Ask-Grant'
TERMINAL = ('answered', 'failed')
PENDING_EXIT, FAILED_EXIT, ERROR_EXIT = 3, 4, 2


class AskError(RuntimeError):
    def __init__(self, status, code):
        super().__init__(f'{status}:{code}')
        self.status, self.code = status, code


AGENT_INSTRUCTIONS = """Asking another thread (Orkestr thread asks)

Only when the owner asked you, in this conversation, to get something from or
done by another of his threads. Never on your own initiative, never for a
group member, a timer or another thread's request (Orkestr refuses those).

  thread_ask.py targets                          # the threads you may ask
  thread_ask.py ask "<thread name>" --text "<what the owner wants>" --wait 240

Write the request so the other agent can act on it without this chat. With
--wait you get its answer here if it comes in time. Otherwise tell the owner
exactly what the tool printed (for example "Sent ..., not processed yet");
never say "delivered" or "done" for a request that is only sent. A later
answer arrives in this thread as a new message, and you continue from there.
"""


def grant_path(conversation, environ=os.environ):
    root = environ.get('ORKESTR_V2_THREAD_ASK_GRANT_DIR', '').strip()
    return Path(root) / f'{conversation}.grant' if root else None


def read_grant(path=None, environ=os.environ):
    if path:
        path = Path(path)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise AskError(0, 'grant_file_must_be_private')
        value = path.read_text().strip()
    else:
        value = environ.get('ORKESTR_V2_THREAD_ASK_GRANT', '').strip()
    if len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
        raise AskError(0, 'grant_missing_or_invalid')
    return value


def default_key(target, text):
    """Stable for the same target and text, so a retried call is one request.

    Core scopes a key to the asking run: the same key from a later turn is a
    new request, never an old answered or failed one."""
    return 'ask-' + hashlib.sha256(f'{target}\n{text}'.encode()).hexdigest()[:40]


class Client:
    def __init__(self, base_url, conversation, grant, timeout=30):
        parsed = parse.urlsplit(base_url)
        if parsed.scheme not in {'http', 'https'} or not parsed.netloc or parsed.path not in {'', '/'}:
            raise AskError(0, 'invalid_base_url')
        try:
            uuid.UUID(conversation)
        except ValueError:
            raise AskError(0, 'invalid_conversation') from None
        self.base = f'{parsed.scheme}://{parsed.netloc}/api/v2/conversations/{conversation}'
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
            raise AskError(failure.code, code) from None
        except (error.URLError, OSError):
            raise AskError(0, 'unreachable') from None
        return json.loads(raw) if raw else None

    def targets(self):
        return self.call('GET', '/thread-asks/targets')['targets']

    def resolve(self, target):
        try:
            return str(uuid.UUID(target))
        except ValueError:
            pass
        matches = [t for t in self.targets() if t['name'].casefold() == target.casefold()]
        if len(matches) != 1:
            raise AskError(0, 'target_ambiguous' if matches else 'target_unknown')
        return matches[0]['conversation_id']

    def ask(self, target, text, request_key=None):
        target = self.resolve(target)
        body = {'request_key': request_key or default_key(target, text),
                'target_conversation_id': target, 'text': text}
        return self.call('POST', '/thread-asks', body)['ask']

    def status(self, ask):
        return self.call('GET', f'/thread-asks/{parse.quote(ask)}')

    def collect(self, ask):
        return self.call('POST', f'/thread-asks/{parse.quote(ask)}/collect', {})


def wait(client, ask, timeout, interval=5.0, clock=time.monotonic, sleep=time.sleep):
    """Poll until the outcome is final, then collect it. The collecting run may
    collect again (for example after a lost response); an outcome already
    delivered as a new message of this thread is never collected."""
    deadline = clock() + max(0.0, timeout)
    view = client.status(ask)
    while view['state'] not in TERMINAL and clock() < deadline:
        sleep(min(interval, max(0.0, deadline - clock())))
        view = client.status(ask)
    if view['state'] in TERMINAL and view.get('returned') != 'input':
        view = client.collect(ask)
    return view


def exit_status(view):
    if view['state'] == 'answered':
        return 0
    if view['state'] == 'failed':
        return FAILED_EXIT
    return PENDING_EXIT


def parser():
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    root.add_argument('--v2-url', default=os.environ.get('ORKESTR_V2_URL'))
    root.add_argument('--conversation', default=os.environ.get('ORKESTR_V2_CONVERSATION'))
    root.add_argument('--grant-file')
    commands = root.add_subparsers(dest='action', required=True)
    commands.add_parser('targets')
    commands.add_parser('instructions')
    ask = commands.add_parser('ask')
    ask.add_argument('target')
    text = ask.add_mutually_exclusive_group(required=True)
    text.add_argument('--text')
    text.add_argument('--text-file')
    ask.add_argument('--request-key')
    ask.add_argument('--wait', type=float, default=0.0)
    status = commands.add_parser('status')
    status.add_argument('ask')
    waiter = commands.add_parser('wait')
    waiter.add_argument('ask')
    waiter.add_argument('--timeout', type=float, default=300.0)
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    if args.action == 'instructions':
        print(AGENT_INSTRUCTIONS, end='')
        return 0
    try:
        if not args.v2_url or not args.conversation:
            raise AskError(0, 'v2_url_and_conversation_required')
        path = args.grant_file
        if not path and not os.environ.get('ORKESTR_V2_THREAD_ASK_GRANT'):
            path = grant_path(args.conversation)
        client = Client(args.v2_url, args.conversation, read_grant(path))
        if args.action == 'targets':
            print(json.dumps({'ok': True, 'targets': client.targets()}, indent=2, sort_keys=True))
            return 0
        if args.action == 'ask':
            body = Path(args.text_file).read_text() if args.text_file else args.text
            view = client.ask(args.target, body, args.request_key)
            if args.wait > 0:
                view = wait(client, view['ask_id'], args.wait)
            code = exit_status(view) if args.wait > 0 or view['state'] in TERMINAL else 0
        elif args.action == 'status':
            view = client.status(args.ask)
            code = exit_status(view) if view['state'] in TERMINAL else PENDING_EXIT
        else:
            view = wait(client, args.ask, args.timeout)
            code = exit_status(view)
    except AskError as failure:
        print(json.dumps({'ok': False, 'status': failure.status, 'code': failure.code}), file=sys.stderr)
        return ERROR_EXIT
    print(json.dumps({'ok': True, 'ask': view}, indent=2, sort_keys=True))
    # The honest one-liner to relay; "sent" is never reported as processed.
    print(view['status_text'], file=sys.stderr)
    return code


if __name__ == '__main__':
    raise SystemExit(main())
