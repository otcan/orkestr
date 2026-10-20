#!/usr/bin/env python3
"""V2 Worker client for V1-brokered desktop leases (parallel run).

Uses only the conversation desktop grant (never owner credentials) against
the V2 API, which forwards to V1's lease broker for the bound V1 thread.

  list
  acquire SLUG --ttl-ms N [--purpose TEXT]
  heartbeat SLUG --fencing-token T [--extend-ttl-ms N]
  release SLUG --fencing-token T [--reason TEXT]
  hold SLUG --ttl-ms N [--purpose TEXT] -- COMMAND [ARGS...]

`hold` acquires, runs COMMAND with ORKESTR_DESKTOP_SLUG,
ORKESTR_DESKTOP_THREAD_ID, ORKESTR_DESKTOP_FENCING_TOKEN and
ORKESTR_DESKTOP_FENCING_VERSION, heartbeats (renewing expiry) while it runs,
stops it if the lease is lost (exit 75) and always releases afterwards.
The grant comes from ORKESTR_V2_DESKTOP_GRANT or a private --grant-file and
is never printed. No browser is launched and no profile is touched here.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import threading
from urllib import error, parse, request

GRANT_HEADER = 'X-Orkestr-Desktop-Grant'
LOST_EXIT = 75


class LeaseError(RuntimeError):
    def __init__(self, status, code):
        super().__init__(f'{status}:{code}')
        self.status, self.code = status, code


def read_grant(path=None, environ=os.environ):
    if path:
        path = Path(path)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise LeaseError(0, 'grant_file_must_be_private')
        value = path.read_text().strip()
    else:
        value = environ.get('ORKESTR_V2_DESKTOP_GRANT', '').strip()
    if len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
        raise LeaseError(0, 'grant_missing_or_invalid')
    return value


class Client:
    def __init__(self, base_url, conversation, grant, timeout=15):
        parsed = parse.urlsplit(base_url)
        if parsed.scheme not in {'http', 'https'} or not parsed.netloc or parsed.path not in {'', '/'}:
            raise LeaseError(0, 'invalid_base_url')
        self.base = f'{parsed.scheme}://{parsed.netloc}/api/v2/conversations/{parse.quote(conversation)}'
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
            raise LeaseError(failure.code, code) from None
        except (error.URLError, OSError):
            raise LeaseError(0, 'unreachable') from None
        return json.loads(raw) if raw else None

    def list(self):
        return self.call('GET', '/desktops')

    def acquire(self, slug, ttl_ms, purpose=None):
        body = {'ttl_ms': ttl_ms}
        if purpose:
            body['purpose'] = purpose
        return self.call('POST', f'/desktops/{parse.quote(slug)}/acquire', body)

    def heartbeat(self, slug, token, extend_ttl_ms=None):
        body = {'fencing_token': token}
        if extend_ttl_ms:
            body['extend_ttl_ms'] = extend_ttl_ms
        return self.call('POST', f'/desktops/{parse.quote(slug)}/heartbeat', body)

    def release(self, slug, token, reason=None):
        body = {'fencing_token': token}
        if reason:
            body['reason'] = reason
        return self.call('POST', f'/desktops/{parse.quote(slug)}/release', body)


def hold(client, slug, ttl_ms, command, purpose=None, interval=None, popen=subprocess.Popen):
    """Run `command` while holding the lease; returns the exit status."""
    granted = client.acquire(slug, ttl_ms, purpose)
    token, lease = granted['fencing_token'], granted['lease']
    env = dict(os.environ, ORKESTR_DESKTOP_SLUG=slug, ORKESTR_DESKTOP_THREAD_ID=lease['v1_thread_id'],
               ORKESTR_DESKTOP_FENCING_TOKEN=token,
               ORKESTR_DESKTOP_FENCING_VERSION=str(lease['fencing_version']))
    env.pop('ORKESTR_V2_DESKTOP_GRANT', None)
    interval = interval or max(5.0, min(60.0, ttl_ms / 3000.0))
    stop, lost = threading.Event(), threading.Event()
    try:
        child = popen(command, env=env)
    except OSError:
        client.release(slug, token, 'command_failed_to_start')
        raise

    def beat():
        while not stop.wait(interval):
            try:
                client.heartbeat(slug, token, extend_ttl_ms=ttl_ms)
            except LeaseError as failure:
                if failure.code in {'desktop_lease_lost', 'desktop_fence_rejected', 'not_found'}:
                    lost.set()
                    child.terminate()
                    return
    previous = {sig: signal.signal(sig, lambda s, _f: child.send_signal(s))
                for sig in (signal.SIGTERM, signal.SIGINT)} if threading.current_thread() is threading.main_thread() else {}
    worker = threading.Thread(target=beat, daemon=True)
    worker.start()
    try:
        status = child.wait()
    finally:
        stop.set()
        worker.join()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        if not lost.is_set():
            try:
                client.release(slug, token, 'hold_finished')
            except LeaseError as failure:
                if failure.code not in {'desktop_lease_lost', 'not_found'}:
                    raise
    return LOST_EXIT if lost.is_set() else status


def parser():
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    root.add_argument('--v2-url', required=True)
    root.add_argument('--conversation', required=True)
    root.add_argument('--grant-file')
    commands = root.add_subparsers(dest='action', required=True)
    commands.add_parser('list')
    acquire = commands.add_parser('acquire')
    acquire.add_argument('slug')
    acquire.add_argument('--ttl-ms', type=int, required=True)
    acquire.add_argument('--purpose')
    beat = commands.add_parser('heartbeat')
    beat.add_argument('slug')
    beat.add_argument('--fencing-token', required=True)
    beat.add_argument('--extend-ttl-ms', type=int)
    release = commands.add_parser('release')
    release.add_argument('slug')
    release.add_argument('--fencing-token', required=True)
    release.add_argument('--reason')
    holder = commands.add_parser('hold')
    holder.add_argument('slug')
    holder.add_argument('--ttl-ms', type=int, required=True)
    holder.add_argument('--purpose')
    holder.add_argument('argv', nargs=argparse.REMAINDER)
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        client = Client(args.v2_url, args.conversation, read_grant(args.grant_file))
        if args.action == 'hold':
            command = args.argv[1:] if args.argv[:1] == ['--'] else args.argv
            if not command:
                raise LeaseError(0, 'command_required')
            return hold(client, args.slug, args.ttl_ms, command, args.purpose)
        result = {
            'list': lambda: client.list(),
            'acquire': lambda: client.acquire(args.slug, args.ttl_ms, args.purpose),
            'heartbeat': lambda: client.heartbeat(args.slug, args.fencing_token, args.extend_ttl_ms),
            'release': lambda: client.release(args.slug, args.fencing_token, args.reason),
        }[args.action]()
    except LeaseError as failure:
        print(json.dumps({'ok': False, 'status': failure.status, 'code': failure.code}), file=sys.stderr)
        return 2
    print(json.dumps({'ok': True, 'result': result}, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
