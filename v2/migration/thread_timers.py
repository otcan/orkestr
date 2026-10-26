#!/usr/bin/env python3
"""Per-thread V1 <-> V2 timer moves. Explicit paths only; dry-run by default.

  v1-export   selected threads' V1 timers -> private bundle (schedule mapping)
  v2-import   bundle thread -> paused V2 timers mapped to one conversation
  handoff     V1 ownedBy:v2 fence, then explicit V2 enable (fence first)
  handback    V2 disable, then lift the V1 fence and restore V1 enablement
  status      per-timer owner across V1 and V2; flags any double owner
  calendar-plan / -apply / -rollback / -status
              convert V1-style timers into ONE calendar timer from a recipe
              (see calendar_convert.py); the old timers stay off for rollback

Output is a JSON report of identifiers, states and schedule kinds; timer
instructions, credentials and private paths are never printed.
"""
import argparse
import json
from pathlib import Path
import sys

# Isolated mode (-I) omits the script directory; add only this reviewed directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import calendar_convert  # noqa: E402
import timer_moves  # noqa: E402
import v2_client  # noqa: E402


def _with_client(args, action):
    username, password = v2_client.read_credentials(args.credentials_file)
    client = v2_client.Client(args.v2_url, origin=args.origin)
    client.login(username, password)
    try:
        return action(client)
    finally:
        client.close()


def _v1(args):
    return timer_moves.V1Cli(args.v1_cli)


def _export(args):
    if args.v1_timers_json:
        value = json.loads(Path(args.v1_timers_json).read_text())
        timers = value['timers'] if isinstance(value, dict) else value
    else:
        timers = _v1(args).timers()
    return timer_moves.export(timers, args.thread, args.out, args.source_instance, args.default_timezone)


def _import(args):
    bundle = timer_moves.load_bundle(args.bundle)
    return _with_client(args, lambda client: timer_moves.import_thread(
        client, bundle, args.thread, args.conversation, apply=args.apply))


def _handoff(args):
    bundle = timer_moves.load_bundle(args.bundle)
    return _with_client(args, lambda client: timer_moves.handoff(
        client, _v1(args), bundle, args.thread, args.conversation, timer_ids=args.timer,
        include_disabled=args.include_disabled, inline_prompt_file=args.inline_prompt_file, apply=args.apply,
        force_enable_disabled=args.force_enable_disabled))


def _summarize_skipped(result, stream):
    """Name every timer a handoff skipped and why (identifiers and reason codes only)."""
    skipped = result.get('skipped') if isinstance(result, dict) else None
    if not skipped:
        return
    print('handoff skipped %d timer(s): %s' % (len(skipped), ', '.join(
        '%s (%s)' % (row['id'], row['reason']) for row in skipped)), file=stream)


def _handback(args):
    bundle = timer_moves.load_bundle(args.bundle)
    return _with_client(args, lambda client: timer_moves.handback(
        client, _v1(args), bundle, args.thread, timer_ids=args.timer,
        keep_disabled=args.keep_disabled, apply=args.apply))


def _status(args):
    bundle = timer_moves.load_bundle(args.bundle)
    return _with_client(args, lambda client: timer_moves.status(
        client, _v1(args), bundle, args.thread, args.conversation))


class V1Snapshot:
    """Read-only V1 state from a saved `orkestr timers list --json` (offline planning)."""

    def __init__(self, path):
        value = json.loads(Path(path).read_text())
        self._timers = value['timers'] if isinstance(value, dict) else value

    def timers(self):
        return list(self._timers)

    def handoff(self, *_):
        raise timer_moves.MoveError('v1_snapshot_is_read_only')

    handback = handoff


def _calendar(args, action):
    bundle = timer_moves.load_bundle(args.bundle)
    recipe = calendar_convert.load_recipe(args.recipe)
    inline = not args.no_inline_prompt_file
    v1 = V1Snapshot(args.v1_timers_json) if getattr(args, 'v1_timers_json', None) else _v1(args)
    if action == 'plan' and not args.v2_url:
        return calendar_convert.plan(None, v1, bundle, recipe, args.conversation, inline)
    return _with_client(args, lambda client: {
        'plan': lambda: calendar_convert.plan(client, v1, bundle, recipe, args.conversation, inline),
        'apply': lambda: calendar_convert.apply(client, v1, bundle, recipe, args.conversation, args.confirm, inline),
        'rollback': lambda: calendar_convert.rollback(client, v1, bundle, recipe, args.conversation, args.to, inline),
        'status': lambda: calendar_convert.status(client, v1, bundle, recipe, args.conversation, inline),
    }[action]())


def parser():
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = root.add_subparsers(dest='command', required=True)

    def remote(command, conversation=True):
        command.add_argument('--bundle', required=True)
        command.add_argument('--thread', required=True, help='V1 thread id')
        if conversation:
            command.add_argument('--conversation', required=True, help='target V2 conversation UUID')
        command.add_argument('--v2-url', required=True)
        command.add_argument('--origin', help='server origin when it differs from --v2-url')
        command.add_argument('--credentials-file', required=True,
                             help='private 0600 JSON {"username","password"}')
        command.add_argument('--v1-cli', default='orkestr', help='V1 CLI executable (uses its own auth)')

    export = commands.add_parser('v1-export')
    export.add_argument('--thread', action='append', required=True)
    export.add_argument('--out', required=True, help='new private bundle file (created 0600)')
    export.add_argument('--source-instance', default='orkestr-v1')
    export.add_argument('--default-timezone',
                        help='IANA zone for V1 daily/weekly timers without one (V1 used host local time)')
    export.add_argument('--v1-timers-json', help='saved `orkestr timers list --json` output instead of the CLI')
    export.add_argument('--v1-cli', default='orkestr')
    export.set_defaults(run=_export)

    imp = commands.add_parser('v2-import')
    remote(imp)
    imp.add_argument('--apply', action='store_true')
    imp.set_defaults(run=_import)

    off = commands.add_parser('handoff')
    remote(off)
    off.add_argument('--timer', action='append', help='V1 timer id (repeatable); default: all enabled in V1')
    off.add_argument('--include-disabled', action='store_true',
                     help='compatibility only: timers disabled in V1 are still skipped (never enabled in V2)')
    off.add_argument('--force-enable-disabled', action='store_true',
                     help='explicitly hand off AND enable in V2 timers that are disabled in V1')
    off.add_argument('--inline-prompt-file', action='store_true',
                     help='use the V1 prompt file content as the V2 instruction')
    off.add_argument('--apply', action='store_true')
    off.set_defaults(run=_handoff)

    back = commands.add_parser('handback')
    remote(back, conversation=False)
    back.add_argument('--timer', action='append')
    back.add_argument('--keep-disabled', action='store_true', help='return to V1 but leave it disabled')
    back.add_argument('--apply', action='store_true')
    back.set_defaults(run=_handback)

    stat = commands.add_parser('status')
    remote(stat)
    stat.set_defaults(run=_status)

    for name, help_text in (('plan', 'read-only: rule in words, what is replaced, plan digest'),
                            ('apply', 'fence/disable the old timers, then enable the calendar timer'),
                            ('rollback', 'disable the calendar timer, restore the old timers'),
                            ('status', 'which of old and new is active; flags a double owner')):
        cal = commands.add_parser('calendar-' + name, help=help_text)
        cal.add_argument('--bundle', required=True)
        cal.add_argument('--recipe', required=True, help='calendar recipe JSON (see recipes/)')
        cal.add_argument('--conversation', required=(name != 'plan'), help='target V2 conversation UUID')
        cal.add_argument('--v2-url', required=(name != 'plan'))
        cal.add_argument('--origin')
        cal.add_argument('--credentials-file', required=(name != 'plan'))
        cal.add_argument('--v1-cli', default='orkestr')
        cal.add_argument('--v1-timers-json', help='saved `orkestr timers list --json` instead of the CLI')
        cal.add_argument('--no-inline-prompt-file', action='store_true',
                         help='use the V1 prompt text itself, not the file it points to')
        if name == 'apply':
            cal.add_argument('--confirm', required=True, help='plan_digest printed by calendar-plan')
        if name == 'rollback':
            cal.add_argument('--to', choices=('v2', 'v1'), default='v2')
        cal.set_defaults(run=lambda a, n=name: _calendar(a, n))
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        result = args.run(args)
    except calendar_convert.ConvertError as error:
        print(json.dumps({'ok': False, 'code': str(error)}), file=sys.stderr)
        return 2
    except timer_moves.MoveError as error:
        print(json.dumps({'ok': False, 'code': str(error)}), file=sys.stderr)
        return 2
    except v2_client.ApiError as error:
        print(json.dumps({'ok': False, 'code': error.code, 'status': error.status}), file=sys.stderr)
        return 2
    except (OSError, ValueError, KeyError, TypeError) as error:
        # No paths, payloads or exception text: they may contain private data.
        print(json.dumps({'ok': False, 'code': type(error).__name__}), file=sys.stderr)
        return 2
    print(json.dumps({'ok': True, 'result': result}, indent=2, sort_keys=True))
    if args.command == 'handoff':
        _summarize_skipped(result, sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
