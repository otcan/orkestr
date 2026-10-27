#!/usr/bin/env python3
"""Operator provisioning of V2 thread-ask grants (idempotent).

  thread_ask_provision.py --v2-url URL --credentials FILE --grant-dir DIR
                          (--only ID_OR_NAME ... | --all-owner-conversations)
                          (--targets ID_OR_NAME[,...] | --all-targets --i-understand | --revoke)
                          [--allow-widen] [--rotate] [--chown USER] [--dry-run]

The selection is explicit: --only names the asking conversations (UUIDs or
exact names), --all-owner-conversations selects every one. The allowlist is
explicit too: --targets names the conversations the selected ones may ask
(the asking conversation is dropped from its own list). --all-targets
--i-understand is the wide form: every other eligible conversation of the
owner. Without either, the run refuses (`--only` alone used to mean "all").
For each selected eligible conversation (not restricted or archived), this
makes sure a thread-ask grant is issued with that allowlist, installed as
DIR/<conversation>.grant (mode 0600). That is where `thread_ask.py` looks
when ORKESTR_V2_THREAD_ASK_GRANT_DIR=DIR is set in the agent's environment.

- Every line shows the allowlist diff (targets_added / targets_removed)
  against the issued grant, in the dry run too.
- An already issued grant is never widened silently: adding any target needs
  --allow-widen, else that conversation fails with widen_requires_allow_widen
  and its grant is left as it is. Narrowing is always allowed.
- A conversation whose grant is issued with the right allowlist and whose
  file is present is left alone (no rotation), so runs are repeatable.
- A changed allowlist, a missing file, or --rotate issues a new grant; the
  old one stops working at once.
- --revoke revokes the selected grants and deletes their files.
- A selected ineligible conversation that still holds a grant is revoked.
- An allowlist above the server cap (256) is refused for that conversation
  with `allowlist_too_large`; it is never silently truncated.

Grants are owner-scoped, not thread-isolated: any process that can read the
grant directory can use any conversation's grant. Keep DIR private to the
agents' user; per-run broker injection is a follow-up.

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


# Must equal Core's THREAD_ASK_TARGETS_MAX.
TARGETS_MAX = 256


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


def select(rows, only):
    """Conversation IDs named by `only` (UUIDs or exact, case-insensitive names)."""
    by_id = {r['conversation_id']: r for r in rows}
    chosen = set()
    for item in only:
        if item in by_id:
            chosen.add(item)
            continue
        matches = [r['conversation_id'] for r in rows if r['name'].casefold() == item.casefold()]
        if len(matches) != 1:
            raise ProvisionError(0, ('ambiguous_conversation:' if matches else 'unknown_conversation:') + item[:40])
        chosen.add(matches[0])
    return chosen


def plan(rows, only=None, targets=None, rotate=False, revoke=False, grant_dir=None, allow_widen=False):
    """(conversation, action, targets, added, removed) for each selected row;
    pure, for tests. `only=None` selects every conversation. `targets` is the
    explicit allowlist (a set of conversation IDs; the asking conversation is
    dropped from its own list); `targets=None` means every other eligible
    conversation (--all-targets). `added`/`removed` are the sorted diff against
    the currently issued allowlist. A grant that is already issued is never
    widened unless `allow_widen`: it is reported as `widen_refused` instead."""
    eligible = sorted(r['conversation_id'] for r in rows if r['eligible'])
    actions = []
    for row in rows:
        conversation, grant = row['conversation_id'], row['grant']
        if only is not None and conversation not in only:
            continue
        if revoke or not row['eligible']:
            if grant['issued']:
                actions.append((conversation, 'revoke', None, [], []))
            continue
        pool = eligible if targets is None else sorted(targets)
        wanted = [c for c in pool if c != conversation]
        current = sorted(grant.get('targets') or []) if grant['issued'] else None
        added = sorted(set(wanted) - set(current or []))
        removed = sorted(set(current or []) - set(wanted))
        if not wanted:
            # Nothing is issued, rotated or revoked here (use --revoke), so the
            # line must not claim the issued grant lost its targets.
            actions.append((conversation, 'no_targets', wanted, [], []))
            continue
        if len(wanted) > TARGETS_MAX:
            actions.append((conversation, 'too_large', wanted, added, removed))
            continue
        if current is not None and added and not allow_widen:
            actions.append((conversation, 'widen_refused', wanted, added, removed))
            continue
        present = grant_dir is not None and valid_grant_file(Path(grant_dir) / f'{conversation}.grant')
        if rotate or current != wanted or not present:
            actions.append((conversation, 'rotate' if grant['issued'] else 'issue', wanted, added, removed))
        else:
            actions.append((conversation, 'unchanged', wanted, added, removed))
    return actions


def split_ids(values):
    """--targets A,B --targets C -> ['A', 'B', 'C'] (blank items dropped)."""
    return [item.strip() for value in values or [] for item in value.split(',') if item.strip()]


def parser():
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    root.add_argument('--v2-url', required=True)
    root.add_argument('--credentials', required=True)
    root.add_argument('--grant-dir', required=True)
    root.add_argument('--rotate', action='store_true')
    root.add_argument('--revoke', action='store_true')
    selection = root.add_mutually_exclusive_group(required=True)
    selection.add_argument('--only', nargs='+', metavar='ID_OR_NAME')
    selection.add_argument('--all-owner-conversations', action='store_true')
    allowlist = root.add_mutually_exclusive_group()
    allowlist.add_argument('--targets', action='append', metavar='ID_OR_NAME[,...]',
                           help='explicit allowlist of the selected conversations (comma-separated, repeatable)')
    allowlist.add_argument('--all-targets', action='store_true',
                           help="allowlist = every other eligible conversation; needs --i-understand")
    root.add_argument('--i-understand', action='store_true',
                      help='acknowledges that --all-targets lets each selected thread ask every other one')
    root.add_argument('--allow-widen', action='store_true',
                      help='permit adding targets to an already issued grant (always shown in the dry run)')
    root.add_argument('--chown')
    root.add_argument('--dry-run', action='store_true')
    return root


def main(argv=None, api=None):
    cli = parser()
    args = cli.parse_args(argv)
    if args.revoke and (args.targets or args.all_targets):
        cli.error('--revoke takes no --targets/--all-targets')
    if not args.revoke and not args.targets and not args.all_targets:
        cli.error('an explicit allowlist is required: --targets ID_OR_NAME[,...] '
                  '(or --all-targets --i-understand for every other conversation)')
    if args.all_targets and not args.i_understand:
        cli.error('--all-targets lets each selected thread ask every other one; add --i-understand')
    grant_dir = Path(args.grant_dir)
    try:
        owner = pwd.getpwnam(args.chown) if args.chown else None
        if api is None:
            api = Api(args.v2_url)
            api.login(private_json(args.credentials))
        rows = api.directory()
        names = {r['conversation_id']: r['name'] for r in rows}
        eligible = {r['conversation_id'] for r in rows if r['eligible']}
        failed = False
        only = None if args.all_owner_conversations else select(rows, args.only)
        targets = None
        if args.targets:
            targets = select(rows, split_ids(args.targets))
            for target in sorted(targets):
                if target not in eligible:
                    raise ProvisionError(0, 'target_not_eligible:' + str(names.get(target) or target)[:40])
        named = lambda ids: [{'id': c, 'name': names.get(c)} for c in ids]
        for conversation, action, wanted, added, removed in plan(
                rows, only, targets, args.rotate, args.revoke, grant_dir, args.allow_widen):
            path = grant_dir / f'{conversation}.grant'
            line = {'conversation_id': conversation, 'name': names.get(conversation), 'action': action}
            if args.dry_run:
                line['dry_run'] = True
            if wanted is not None:
                line.update(targets=len(wanted), targets_added=named(added), targets_removed=named(removed))
            try:
                if action == 'too_large':
                    raise ProvisionError(0, 'allowlist_too_large')
                if action == 'widen_refused':
                    raise ProvisionError(0, 'widen_requires_allow_widen')
                if args.dry_run or action in {'unchanged', 'no_targets'}:
                    pass
                elif action == 'revoke':
                    api.revoke(conversation)
                    path.unlink(missing_ok=True)
                else:
                    install(path, api.issue(conversation, wanted)['grant'], owner)
            except ProvisionError as failure:
                failed = True
                line.update(action='failed', reason=action, status=failure.status, code=failure.code)
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
