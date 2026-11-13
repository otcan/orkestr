#!/usr/bin/env python3
"""Operator provisioning of one conversation's V2 local-files grant (ORK-750).

  local_files_provision.py --v2-url URL --credentials FILE --grant-dir DIR
                           --conversation UUID [--rotate] [--revoke]
                           [--chown USER] [--dry-run]

Makes sure the conversation's local-files grant is issued and installed as
DIR/<conversation>.local-files.grant, where `local_files.py` looks when
ORKESTR_V2_LOCAL_FILES_GRANT_DIR=DIR is set in the Deep agent's environment.
Never set that variable for Fast. The directory and file custody is the
agent-timer grant's (agent_timer_provision.py, whose install it reuses): DIR
0710 with the --chown user's group, the file 0600 owned by that user. The
name differs from the agent-timer grant's <conversation>.grant, so both can
share one directory; a server with `agent_timers` issues and installs this
grant itself (ORK-804).

DIR must be the directory the agent actually sees. With a broker that
projects a Core-written directory into the agent's namespace, install into
that source directory, never at the projection's target path on the host
(a file there is hidden from every agent, and the issue still rotates the
grant).

- An issued grant whose file is present is left alone (reruns change nothing).
- A missing file or --rotate issues a new grant; the old one stops at once.
- --revoke revokes the grant and deletes its file. Revoking also fails every
  unfinished request of the conversation.

A grant alone reaches nothing: the owner still has to connect a folder for
this conversation in his browser, and every write needs his confirmation
there. Use a grant directory separate from the thread-ask one.
CREDENTIALS is a private JSON file {"username": ..., "password": ...} of the
owner; it is used for one machine login. Grants and credentials are never
printed.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import pwd
import sys
import uuid

_SPEC = importlib.util.spec_from_file_location(
    'agent_timer_provision', Path(__file__).resolve().with_name('agent_timer_provision.py'))
_TIMER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_TIMER)
ProvisionError, private_json, valid_grant_file, install = (
    _TIMER.ProvisionError, _TIMER.private_json, _TIMER.valid_grant_file, _TIMER.install)


class Api(_TIMER._BASE.Api):
    def grant(self, conversation):
        return self.call('GET', f'/api/v2/conversations/{conversation}/local-files-grant')

    def issue(self, conversation):
        return self.call('PUT', f'/api/v2/conversations/{conversation}/local-files-grant')

    def revoke(self, conversation):
        return self.call('DELETE', f'/api/v2/conversations/{conversation}/local-files-grant')


def plan(issued, present, rotate=False, revoke=False):
    """The one action for the conversation; pure, for tests."""
    if revoke:
        return 'revoke' if issued else 'unchanged'
    if rotate or not issued or not present:
        return 'rotate' if issued else 'issue'
    return 'unchanged'


def parser():
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    root.add_argument('--v2-url', required=True)
    root.add_argument('--credentials', required=True)
    root.add_argument('--grant-dir', required=True)
    root.add_argument('--conversation', required=True)
    root.add_argument('--rotate', action='store_true')
    root.add_argument('--revoke', action='store_true')
    root.add_argument('--chown')
    root.add_argument('--dry-run', action='store_true')
    return root


def main(argv=None, api=None):
    args = parser().parse_args(argv)
    try:
        conversation = str(uuid.UUID(args.conversation))
    except ValueError:
        print(json.dumps({'ok': False, 'code': 'invalid_conversation'}), file=sys.stderr)
        return 2
    path = Path(args.grant_dir) / f'{conversation}.local-files.grant'
    try:
        owner = pwd.getpwnam(args.chown) if args.chown else None
        if api is None:
            api = Api(args.v2_url)
            api.login(private_json(args.credentials))
        action = plan(api.grant(conversation)['issued'], valid_grant_file(path), args.rotate, args.revoke)
        if not args.dry_run:
            if action == 'revoke':
                api.revoke(conversation)
                path.unlink(missing_ok=True)
            elif action in ('issue', 'rotate'):
                install(path, api.issue(conversation)['grant'], owner)
    except ProvisionError as failure:
        print(json.dumps({'ok': False, 'status': failure.status, 'code': failure.code}), file=sys.stderr)
        return 2
    except KeyError:
        print(json.dumps({'ok': False, 'code': 'unknown_user'}), file=sys.stderr)
        return 2
    print(json.dumps({'conversation_id': conversation, 'action': action, 'dry_run': args.dry_run}, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
