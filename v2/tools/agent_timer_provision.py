#!/usr/bin/env python3
"""Operator provisioning of V2 agent-timer grants (idempotent).

  agent_timer_provision.py --v2-url URL --credentials FILE --grant-dir DIR
                           --only ID_OR_NAME ... [--rotate] [--revoke]
                           [--create-cap owner_only|off|default|N]
                           [--chown USER] [--dry-run]

--create-cap sets the selected conversations' rolling 24-hour agent timer
create cap: owner_only (a chat only the owner is in; server default 200),
off, default (the server default, 24) or a fixed number. It never changes
timer history, and the hourly and live-timer caps always apply.

The default is one conversation at a time (--only). --all-owner-conversations
also needs --i-understand-shared-grant-dir, because every grant then sits in
one directory. The directory is owned by the caller with mode 0710 and the
--chown user's group (0700 without --chown), so the agent can open its file but
not list the others. Each grant file is 0600 and owned by the --chown user, the
agent that reads it (agent_timer.py refuses a file owned by anyone else).

Same shape as thread_ask_provision.py (whose login, selection and atomic 0600
install it reuses). For each selected eligible conversation (not restricted
or archived) this makes sure an agent-timer grant is issued and installed as
DIR/<conversation>.grant, where `agent_timer.py` looks when
ORKESTR_V2_AGENT_TIMER_GRANT_DIR=DIR is set in the Deep agent's environment.
Never set that variable for Fast: Fast is read-only and must not get the tool.

- An issued grant whose file is present is left alone, so runs repeat safely.
- A missing file or --rotate issues a new grant; the old one stops at once.
- --revoke revokes the selected grants and deletes their files.
- A selected ineligible conversation that still holds a grant is revoked.

Use a grant directory separate from the thread-ask one. Grants are
owner-scoped, not thread-isolated: any process that can read DIR can use any
conversation's grant (for that conversation only). Keep DIR private to the
agents' user. Grants and credentials are never printed.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import os
import pwd
import stat
import sys

_SPEC = importlib.util.spec_from_file_location(
    'thread_ask_provision', Path(__file__).resolve().with_name('thread_ask_provision.py'))
_BASE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_BASE)
ProvisionError, private_json, select, valid_grant_file = (
    _BASE.ProvisionError, _BASE.private_json, _BASE.select, _BASE.valid_grant_file)


def prepare_dir(grant_dir, owner=None):
    """The grant directory: owned by the caller, mode 0710 with the agent
    user's group when --chown names one (the agent can enter it and open its
    own file, but not list it), else 0700. An existing directory of another
    user must not be group- or world-writable."""
    grant_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = grant_dir.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise ProvisionError(0, 'grant_dir_not_a_directory')
    if info.st_uid != os.getuid():
        if info.st_mode & 0o022:
            raise ProvisionError(0, 'grant_dir_unsafe')
        return
    if owner is not None:
        os.chown(grant_dir, -1, owner.pw_gid)
    os.chmod(grant_dir, 0o710 if owner is not None else 0o700)


def install(path, grant, owner=None):
    """Atomic 0600 grant file, owned by the agent user (--chown) that reads
    it with agent_timer.py, else by the caller."""
    prepare_dir(path.parent, owner)
    _BASE.install(path, grant, owner)


class Api(_BASE.Api):
    def directory(self):
        return self.call('GET', '/api/v2/agent-timer-grants')['conversations']

    def issue(self, conversation):
        return self.call('PUT', f'/api/v2/conversations/{conversation}/agent-timer-grant')

    def revoke(self, conversation):
        return self.call('DELETE', f'/api/v2/conversations/{conversation}/agent-timer-grant')

    def set_limits(self, conversation, body):
        return self.call('PUT', f'/api/v2/conversations/{conversation}/agent-timer-limits', body)


def create_cap(value):
    """--create-cap to the limits request body."""
    if value in ('owner_only', 'off', 'default'):
        return {'mode': value}
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError('owner_only, off, default or 1..10000') from None
    if not 1 <= number <= 10_000:
        raise argparse.ArgumentTypeError('owner_only, off, default or 1..10000')
    return {'mode': 'fixed', 'daily_creates_max': number}


def plan(rows, only=None, rotate=False, revoke=False, grant_dir=None):
    """(conversation, action) for each selected row; pure, for tests."""
    actions = []
    for row in rows:
        conversation, grant = row['conversation_id'], row['grant']
        if only is not None and conversation not in only:
            continue
        if revoke or not row['eligible']:
            if grant['issued']:
                actions.append((conversation, 'revoke'))
            continue
        present = grant_dir is not None and valid_grant_file(Path(grant_dir) / f'{conversation}.grant')
        if rotate or not grant['issued'] or not present:
            actions.append((conversation, 'rotate' if grant['issued'] else 'issue'))
        else:
            actions.append((conversation, 'unchanged'))
    return actions


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
    root.add_argument('--i-understand-shared-grant-dir', action='store_true',
                      help='required with --all-owner-conversations: every grant lands in one directory')
    root.add_argument('--create-cap', type=create_cap, metavar='owner_only|off|default|N')
    root.add_argument('--chown')
    root.add_argument('--dry-run', action='store_true')
    return root


def main(argv=None, api=None):
    args = parser().parse_args(argv)
    grant_dir = Path(args.grant_dir)
    if args.all_owner_conversations and not args.i_understand_shared_grant_dir:
        # Every conversation's grant in one directory: any reader of it can act
        # for all of them. The default is one conversation (--only).
        print(json.dumps({'ok': False, 'code': 'shared_grant_dir_not_acknowledged'}), file=sys.stderr)
        return 2
    try:
        owner = pwd.getpwnam(args.chown) if args.chown else None
        if api is None:
            api = Api(args.v2_url)
            api.login(private_json(args.credentials))
        rows = api.directory()
        names = {r['conversation_id']: r['name'] for r in rows}
        failed = False
        only = None if args.all_owner_conversations else select(rows, args.only)
        for conversation, action in plan(rows, only, args.rotate, args.revoke, grant_dir):
            path = grant_dir / f'{conversation}.grant'
            line = {'conversation_id': conversation, 'name': names.get(conversation), 'action': action}
            try:
                if args.dry_run or action == 'unchanged':
                    pass
                elif action == 'revoke':
                    api.revoke(conversation)
                    path.unlink(missing_ok=True)
                else:
                    install(path, api.issue(conversation)['grant'], owner)
                if args.create_cap and action != 'revoke':
                    if args.dry_run:
                        line['create_cap'] = args.create_cap
                    else:
                        limits = api.set_limits(conversation, args.create_cap)
                        line['create_cap'] = {k: limits.get(k) for k in ('mode', 'daily_creates_max')}
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
