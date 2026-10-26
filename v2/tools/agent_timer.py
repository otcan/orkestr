#!/usr/bin/env python3
"""Timers of THIS conversation, from a running V2 Deep turn (TASK-52).

Uses only this conversation's agent-timer grant (never owner credentials or
the V1 timer API) against the V2 API:

  list
  create --label LABEL (--at WHEN | --daily HH:MM [--weekdays 1,2,3] --timezone TZ)
         (--text TEXT | --text-file PATH) [--request-key KEY]
  cancel TIMER
  pause TIMER [--until WHEN]
  resume TIMER
  skip-next TIMER

TIMER is a timer ID or an exact (case-insensitive) label from `list`. WHEN is
an ISO 8601 time with an offset (2026-10-27T12:15:00+01:00 or ...Z). Every
timer belongs to this conversation: there is no way to name another one.
Orkestr enforces the caps (one-shot runs at least 2 minutes ahead, recurring
runs at most every 30 minutes, at most 32 live agent timers and 12 creates an
hour per conversation, pauses of at most 60 days). `cancel` disables a timer
(the owner can re-enable it); stop and rollback stay with the owner.

Exit status: 0 done (or nothing to change), 2 refused or failed.
The grant comes from --grant-file, ORKESTR_V2_AGENT_TIMER_GRANT, or the
provisioned file ORKESTR_V2_AGENT_TIMER_GRANT_DIR/<conversation>.grant (see
agent_timer_provision.py); it is never printed. `instructions` prints the
short agent rules.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
from urllib import error, parse, request
import uuid

GRANT_HEADER = 'X-Orkestr-Agent-Timer-Grant'
ERROR_EXIT = 2


class TimerError(RuntimeError):
    def __init__(self, status, code):
        super().__init__(f'{status}:{code}')
        self.status, self.code = status, code


AGENT_INSTRUCTIONS = """Timers of this thread (Orkestr agent timer tool)

Use agent_timer.py for every reminder or scheduled check of THIS thread. Never
use the V1 timer API (/api/threads/.../timers, api-client.js, deltimers.mjs):
V1 no longer runs this thread and refuses changes to its timers.

  agent_timer.py list
  agent_timer.py create --label "Biocytogen 12:15" --at 2026-10-27T12:00:00+01:00 \\
      --text "Remind the owner: Biocytogen meeting at 12:15, booth B12."
  agent_timer.py create --label "CHECK 08:00" --daily 08:00 --timezone Europe/Berlin --text "..."
  agent_timer.py cancel "Biocytogen 12:15"      # meeting cancelled
  agent_timer.py pause "CHECK 08:00" --until 2026-11-03T08:00:00+01:00
  agent_timer.py resume "CHECK 08:00"
  agent_timer.py skip-next "CHECK 08:00"

Write the timer text so a later turn can act on it without this chat. Report
to the owner exactly what the tool printed. If it refuses (too soon, too
frequent, too many timers), tell the owner instead of retrying in a loop.
"""


def grant_path(conversation, environ=os.environ):
    root = environ.get('ORKESTR_V2_AGENT_TIMER_GRANT_DIR', '').strip()
    return Path(root) / f'{conversation}.grant' if root else None


def read_grant(path=None, environ=os.environ):
    if path:
        path = Path(path)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise TimerError(0, 'grant_file_must_be_private')
        value = path.read_text().strip()
    else:
        value = environ.get('ORKESTR_V2_AGENT_TIMER_GRANT', '').strip()
    if len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
        raise TimerError(0, 'grant_missing_or_invalid')
    return value


def instant_ms(value):
    """ISO 8601 with an explicit offset to epoch milliseconds."""
    try:
        moment = dt.datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
    except ValueError:
        raise TimerError(0, 'invalid_time') from None
    if moment.tzinfo is None:
        raise TimerError(0, 'time_needs_offset')
    return int(moment.timestamp() * 1000)


def daily_schedule(clock, timezone, weekdays=None):
    try:
        hour, minute = (int(part) for part in clock.split(':'))
    except ValueError:
        raise TimerError(0, 'invalid_daily_time') from None
    if not (0 <= hour < 24 and 0 <= minute < 60) or not timezone:
        raise TimerError(0, 'invalid_daily_time')
    days = []
    if weekdays:
        try:
            days = sorted({int(d) for d in weekdays.split(',')})
        except ValueError:
            raise TimerError(0, 'invalid_weekdays') from None
    start = hour * 60 + minute
    return {'kind': 'calendar', 'timezone': timezone, 'weekdays': days,
            'start_minute': start, 'end_minute': start, 'every_hours': 1, 'minutes': [minute]}


def default_key(label, schedule, text):
    """Stable for the same timer, so a retried call creates it once."""
    body = json.dumps([label, schedule, text], sort_keys=True)
    return 'timer-' + hashlib.sha256(body.encode()).hexdigest()[:40]


class Client:
    def __init__(self, base_url, conversation, grant, timeout=30):
        parsed = parse.urlsplit(base_url)
        if parsed.scheme not in {'http', 'https'} or not parsed.netloc or parsed.path not in {'', '/'}:
            raise TimerError(0, 'invalid_base_url')
        try:
            uuid.UUID(conversation)
        except ValueError:
            raise TimerError(0, 'invalid_conversation') from None
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
            raise TimerError(failure.code, code) from None
        except (error.URLError, OSError):
            raise TimerError(0, 'unreachable') from None
        return json.loads(raw) if raw else None

    def list(self):
        return self.call('GET', '/agent-timers')['timers']

    def resolve(self, timer):
        try:
            return str(uuid.UUID(timer))
        except ValueError:
            pass
        matches = [t for t in self.list() if (t.get('label') or '').casefold() == timer.casefold()]
        if len(matches) != 1:
            raise TimerError(0, 'timer_ambiguous' if matches else 'timer_unknown')
        return matches[0]['namespace']

    def create(self, label, schedule, text, request_key=None):
        body = {'request_key': request_key or default_key(label, schedule, text),
                'label': label, 'schedule': schedule, 'text': text}
        return self.call('POST', '/agent-timers', body)

    def control(self, timer, operation, until_ms=None, request_key=None):
        namespace = self.resolve(timer)
        if request_key is None and operation == 'skip_next':
            # Keyed on the run it skips: a retried call never skips two runs.
            due = next((t.get('next_due_ms') for t in self.list() if t['namespace'] == namespace), None)
            request_key = f'skip_next-{namespace}-{due}'
        body = {'request_key': request_key or f'{operation}-{uuid.uuid4().hex[:24]}',
                'operation': operation}
        if until_ms is not None:
            body['until_ms'] = until_ms
        return self.call('POST', f'/agent-timers/{parse.quote(namespace)}/control', body)


def summary(receipt, verb):
    timer = receipt['timer']
    label = timer.get('label') or timer['namespace']
    if not receipt['changed']:
        return f'Timer "{label}": nothing to change ({timer["state"]}).'
    when = timer.get('next_due_ms')
    nxt = (dt.datetime.fromtimestamp(when / 1000, dt.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
           if when else 'none')
    return f'Timer "{label}" {verb}: {timer["state"]}, {timer["schedule"]}, next run {nxt}.'


def parser():
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    root.add_argument('--v2-url', default=os.environ.get('ORKESTR_V2_URL'))
    root.add_argument('--conversation', default=os.environ.get('ORKESTR_V2_CONVERSATION'))
    root.add_argument('--grant-file')
    commands = root.add_subparsers(dest='action', required=True)
    commands.add_parser('list')
    commands.add_parser('instructions')
    create = commands.add_parser('create')
    create.add_argument('--label', required=True)
    when = create.add_mutually_exclusive_group(required=True)
    when.add_argument('--at')
    when.add_argument('--daily', metavar='HH:MM')
    create.add_argument('--timezone')
    create.add_argument('--weekdays', help='1=Monday .. 7=Sunday, comma separated')
    text = create.add_mutually_exclusive_group(required=True)
    text.add_argument('--text')
    text.add_argument('--text-file')
    create.add_argument('--request-key')
    for name in ('cancel', 'resume', 'skip-next'):
        commands.add_parser(name).add_argument('timer')
    pause = commands.add_parser('pause')
    pause.add_argument('timer')
    pause.add_argument('--until')
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    if args.action == 'instructions':
        print(AGENT_INSTRUCTIONS, end='')
        return 0
    try:
        if not args.v2_url or not args.conversation:
            raise TimerError(0, 'v2_url_and_conversation_required')
        path = args.grant_file
        if not path and not os.environ.get('ORKESTR_V2_AGENT_TIMER_GRANT'):
            path = grant_path(args.conversation)
        client = Client(args.v2_url, args.conversation, read_grant(path))
        if args.action == 'list':
            print(json.dumps({'ok': True, 'timers': client.list()}, indent=2, sort_keys=True))
            return 0
        if args.action == 'create':
            if args.at:
                if args.timezone or args.weekdays:
                    raise TimerError(0, 'timezone_and_weekdays_need_daily')
                schedule = {'kind': 'once', 'due_ms': instant_ms(args.at)}
            else:
                schedule = daily_schedule(args.daily, args.timezone, args.weekdays)
            body = Path(args.text_file).read_text() if args.text_file else args.text
            receipt = client.create(args.label, schedule, body, args.request_key)
            verb = 'set'
        else:
            operation = args.action.replace('-', '_')
            until = instant_ms(args.until) if getattr(args, 'until', None) else None
            receipt = client.control(args.timer, operation, until)
            verb = {'cancel': 'cancelled', 'pause': 'paused', 'resume': 'resumed',
                    'skip_next': 'skips its next run'}[operation]
    except TimerError as failure:
        print(json.dumps({'ok': False, 'status': failure.status, 'code': failure.code}), file=sys.stderr)
        return ERROR_EXIT
    print(json.dumps({'ok': True, **receipt}, indent=2, sort_keys=True))
    print(summary(receipt, verb), file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
