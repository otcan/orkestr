#!/usr/bin/env python3
"""Operator provisioning of V2 thread-ask grants (idempotent).

  thread_ask_provision.py --v2-url URL --credentials FILE --grant-dir DIR
                          [--rotate] [--revoke] [--only ID ...] [--chown USER]
                          [--dry-run]

For every eligible conversation of the owner (not restricted or archived),
this makes sure a thread-ask grant is issued whose allowlist is exactly the
owner's other eligible conversations, and that the grant is installed as
DIR/<conversation>.grant (mode 0600). That is where `thread_ask.py` looks
when ORKESTR_V2_THREAD_ASK_GRANT_DIR=DIR is set in the agent's environment.

- A conversation whose grant is issued with the right allowlist and whose
  file is present is left alone (no rotation), so runs are repeatable.
- A changed allowlist (a conversation was added or archived), a missing file,
  or --rotate issues a new grant; the old one stops working at once.
- --revoke revokes the selected grants and deletes their files.
- An ineligible conversation that still holds a grant is revoked.

CREDENTIALS is a private JSON file {"username": ..., "password": ...} of the
owner; it is used for one machine login and never printed. Grants are never
printed either; the output is one JSON line per conversation with its action.
"""
import argparse
import json
import os
from pathlib import Path
import pwd
import stat
import sys
import tempfile
from urllib import error, parse, request


class ProvisionError(RuntimeError):
    def __init__(self, status, code):
        super().__init__(f'{status}:{code}')
        self.status, self.code = status, code


def private_json(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ProvisionError(0, 'credentials_must_be_private')
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or not value.get('username') or not value.get('password'):
        raise ProvisionError(0, 'credentials_invalid')
    return value


class Api:
    def __init__(self, base_url, timeout=30):
        parsed = parse.urlsplit(base_url)
        if parsed.scheme not in {'http', 'https'} or not parsed.netloc or parsed.path not in {'', '/'}:
            raise ProvisionError(0, 'invalid_base_url')
        self.base, self.timeout, self.token = f'{parsed.scheme}://{parsed.netloc}', timeout, None

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        headers = {'Accept': 'application/json'}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        req = request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with request.urlopen(req, timeout=self.timeout) as response:
                raw = response.read()
        except error.HTTPError as failure:
            try:
                code = str(json.loads(failure.read()).get('code') or 'http_error')[:64]
            except (ValueError, AttributeError):
                code = 'http_error'
            raise ProvisionError(failure.code, code) from None
        except (error.URLError, OSError):
            raise ProvisionError(0, 'unreachable') from None
        return json.loads(raw) if raw else None

    def login(self, credentials):
        value = self.call('POST', '/api/v2/machine/session',
                          {'username': credentials['username'], 'password': credentials['password']})
        self.token = value['token']

    def directory(self):
        return self.call('GET', '/api/v2/thread-ask-grants')['conversations']

    def issue(self, conversation, targets):
        return self.call('PUT', f'/api/v2/conversations/{conversation}/thread-ask-grant', {'targets': targets})

    def revoke(self, conversation):
        return self.call('DELETE', f'/api/v2/conversations/{conversation}/thread-ask-grant')


def valid_grant_file(path):
    try:
        info = path.lstat()
        value = path.read_text().strip()
    except OSError:
        return False
    return (stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077 and len(value) == 64
            and all(c in '0123456789abcdef' for c in value))


def install(path, grant, owner=None):
    """Atomic 0600 write; optional chown so the agent's user can read it."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.grant-')
    try:
        os.fchmod(fd, 0o600)
        if owner is not None:
            os.fchown(fd, owner.pw_uid, owner.pw_gid)
        os.write(fd, (grant + '\n').encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)


def plan(rows, only=None, rotate=False, revoke=False, grant_dir=None):
    """(conversation, action, targets) for each row; pure, for tests."""
    eligible = sorted(r['conversation_id'] for r in rows if r['eligible'])
    actions = []
    for row in rows:
        conversation, grant = row['conversation_id'], row['grant']
        if only and conversation not in only:
            continue
        if revoke or not row['eligible']:
            if grant['issued']:
                actions.append((conversation, 'revoke', None))
            continue
        targets = [c for c in eligible if c != conversation]
        if not targets:
            continue
        current = sorted(grant.get('targets') or []) if grant['issued'] else None
        present = grant_dir is not None and valid_grant_file(Path(grant_dir) / f'{conversation}.grant')
        if rotate or current != targets or not present:
            actions.append((conversation, 'rotate' if grant['issued'] else 'issue', targets))
        else:
            actions.append((conversation, 'unchanged', targets))
    return actions


def parser():
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    root.add_argument('--v2-url', required=True)
    root.add_argument('--credentials', required=True)
    root.add_argument('--grant-dir', required=True)
    root.add_argument('--rotate', action='store_true')
    root.add_argument('--revoke', action='store_true')
    root.add_argument('--only', nargs='+')
    root.add_argument('--chown')
    root.add_argument('--dry-run', action='store_true')
    return root


def main(argv=None, api=None):
    args = parser().parse_args(argv)
    grant_dir = Path(args.grant_dir)
    try:
        owner = pwd.getpwnam(args.chown) if args.chown else None
        if api is None:
            api = Api(args.v2_url)
            api.login(private_json(args.credentials))
        rows = api.directory()
        names = {r['conversation_id']: r['name'] for r in rows}
        failed = False
        for conversation, action, targets in plan(rows, set(args.only or ()), args.rotate, args.revoke, grant_dir):
            path = grant_dir / f'{conversation}.grant'
            line = {'conversation_id': conversation, 'name': names.get(conversation), 'action': action}
            try:
                if args.dry_run or action == 'unchanged':
                    pass
                elif action == 'revoke':
                    api.revoke(conversation)
                    path.unlink(missing_ok=True)
                else:
                    install(path, api.issue(conversation, targets)['grant'], owner)
                if targets is not None:
                    line['targets'] = len(targets)
            except ProvisionError as failure:
                failed = True
                line.update(action='failed', status=failure.status, code=failure.code)
            print(json.dumps(line, sort_keys=True))
    except ProvisionError as failure:
        print(json.dumps({'ok': False, 'status': failure.status, 'code': failure.code}), file=sys.stderr)
        return 2
    except KeyError:
        print(json.dumps({'ok': False, 'code': 'unknown_user'}), file=sys.stderr)
        return 2
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
