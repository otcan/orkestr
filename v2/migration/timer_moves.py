"""Per-thread V1 -> V2 timer moves with single-owner handoff and handback.

A V1 timer is imported into one V2 conversation as a paused (dormant) timer
that records its original V1 enablement. Ownership then moves one timer at a
time, fence first:

  handoff   V1 `ownedBy: v2` fence (V1 can no longer fire, run, edit or delete
            it), then an explicit V2 owner enable into the mapped conversation.
            A definite V2 refusal hands the timer straight back to V1.
  handback  V2 disable (outstanding occurrences become held), then the V1 fence
            is lifted and the original enablement is restored with a fresh
            next run (no catch-up).

Each step is idempotent by deterministic key, so an interrupted move is
completed by running the same command again. In between, a timer has at most
one owner; it never has two.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import v2_client

NAMESPACE = uuid.UUID('5b0f6f1c-3c55-4a7d-9a1e-8f2b6c4d7e90')
BUNDLE_SCHEMA = 'orkestr.v1-timer-bundle.v1'
MAX_INSTRUCTION = 32768
MINUTE = 60_000
DAY = 86_400_000


class MoveError(RuntimeError):
    pass


def timer_namespace(source_instance, timer_id):
    return str(uuid.uuid5(NAMESPACE, f'{source_instance}\n{timer_id}'))


def _clock(value):
    match = re.fullmatch(r'(\d{1,2}):(\d{2})', str(value or '').strip())
    if not match or int(match[1]) > 23 or int(match[2]) > 59:
        return None
    return int(match[1]) * 60 + int(match[2])


def _instant(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else None


def _zone(name):
    try:
        return ZoneInfo(name) if name else None
    except (ZoneInfoNotFoundError, ValueError):
        return None


def _dormant(timer, reason):
    def text(key):
        value = timer.get(key)
        return str(value)[:128] if value not in (None, '') else None
    return {'kind': 'dormant', 'cadence': str(timer.get('cadence') or 'unknown')[:80],
            'timezone': text('timezone'), 'time': text('time'), 'every': text('every'),
            'run_at': text('runAt'), 'reason': reason}


def schedule_for(timer, default_timezone=None):
    """Exact V2 schedule for a V1 timer, or a dormant record with the reason."""
    cadence = str(timer.get('cadence') or '').lower()
    if cadence == 'once':
        due = _instant(timer.get('runAt'))
        return {'kind': 'once', 'due_ms': int(due.timestamp() * 1000)} if due else _dormant(timer, 'ambiguous_cadence')
    if cadence == 'interval':
        match = re.fullmatch(r'(\d+)\s*([mhd])', str(timer.get('every') or '').strip().lower())
        every = int(match[1]) * {'m': MINUTE, 'h': 60 * MINUTE, 'd': DAY}[match[2]] if match else 0
        if not MINUTE <= every <= 366 * DAY:
            return _dormant(timer, 'ambiguous_cadence')
        return {'kind': 'interval', 'every_ms': every}
    if cadence not in ('daily', 'weekly'):
        return _dormant(timer, 'ambiguous_cadence')
    minute = _clock(timer.get('time'))
    name = str(timer.get('timezone') or '').strip() or default_timezone
    if not name:
        return _dormant(timer, 'missing_timezone')
    zone = _zone(name)
    if minute is None:
        return _dormant(timer, 'ambiguous_cadence')
    if zone is None:
        return _dormant(timer, 'unsupported_timezone')
    weekday = None
    if cadence == 'weekly':
        # V1 keeps a weekly timer on the weekday of its stored next run.
        anchor = next((_instant(timer.get(k)) for k in ('nextRunAt', 'lastRunAt', 'createdAt') if _instant(timer.get(k))), None)
        if anchor is None:
            return _dormant(timer, 'ambiguous_cadence')
        weekday = anchor.astimezone(zone).isoweekday()
    return {'kind': 'zoned_clock', 'timezone': name, 'weekday': weekday, 'minute_of_day': minute}


def _private_write(path, value):
    path = Path(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle, indent=1, sort_keys=True)


def load_bundle(path):
    info = os.stat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise MoveError('bundle_must_be_private')
    value = json.loads(Path(path).read_text())
    if value.get('schema') != BUNDLE_SCHEMA:
        raise MoveError('bundle_schema')
    return value


class V1Cli:
    """V1 timer operations through the reviewed `orkestr` CLI (its own auth)."""

    def __init__(self, executable='orkestr', runner=subprocess.run):
        self.executable, self.runner = executable, runner

    def _json(self, *args):
        done = self.runner([self.executable, 'timers', *args, '--json'], capture_output=True, text=True, timeout=120)
        if done.returncode != 0:
            raise MoveError('v1_cli_refused:' + _code(done.stderr))
        return json.loads(done.stdout)

    def timers(self):
        value = self._json('list')
        return value['timers'] if isinstance(value, dict) else value

    def handoff(self, timer_id, handoff_id):
        return self._json('handoff', timer_id, '--handoff-id', handoff_id)

    def handback(self, timer_id, handoff_id, keep_disabled=False):
        flags = ['--keep-disabled'] if keep_disabled else []
        return self._json('handback', timer_id, '--handoff-id', handoff_id, *flags)


def _code(text):
    match = re.search(r'(timer_[a-z_]+|[a-z_]+_conflict|not_found)', str(text or ''))
    return match[0] if match else 'error'


def export(timers, threads, out, source_instance, default_timezone=None):
    threads = set(threads)
    selected = []
    for timer in timers:
        if timer.get('targetType') != 'thread' or timer.get('target') not in threads:
            continue
        selected.append({
            'id': str(timer['id']), 'thread': timer['target'], 'label': str(timer.get('label') or 'Timer')[:200],
            'namespace': timer_namespace(source_instance, timer['id']),
            'source_enabled': bool(timer.get('enabled')) or bool((timer.get('ownership') or {}).get('enabledBeforeHandoff')),
            'owned_by': timer.get('ownedBy') or 'v1', 'schedule': schedule_for(timer, default_timezone),
            'v1': {k: timer.get(k) for k in ('cadence', 'time', 'timezone', 'every', 'runAt', 'nextRunAt',
                                             'requiredDesktop', 'requiredConnector')},
            # Private: the owner's own timer instructions, needed only for enable.
            'prompt': timer.get('prompt') or '', 'prompt_file': timer.get('promptFile') or '',
        })
    bundle = {'schema': BUNDLE_SCHEMA, 'source_instance': source_instance,
              'exported_at': datetime.now(timezone.utc).isoformat(), 'threads': sorted(threads), 'timers': selected}
    _private_write(out, bundle)
    return {'timers': [_public(t) for t in selected]}


def _public(timer):
    return {'id': timer['id'], 'thread': timer['thread'], 'namespace': timer['namespace'],
            'source_enabled': timer['source_enabled'], 'schedule': timer['schedule']['kind'],
            'dormant_reason': timer['schedule'].get('reason')}


def _selected(bundle, thread, timer_ids=None):
    rows = [t for t in bundle['timers'] if t['thread'] == thread and (not timer_ids or t['id'] in timer_ids)]
    if timer_ids and len(rows) != len(set(timer_ids)):
        raise MoveError('timer_not_in_bundle')
    return rows


def import_thread(client, bundle, thread, conversation, apply=False):
    report = []
    for timer in _selected(bundle, thread):
        body = {'namespace': timer['namespace'], 'source_namespace': bundle['source_instance'],
                'source_timer_id': timer['id'], 'source_enabled': timer['source_enabled'],
                'schedule': timer['schedule'], 'conversation_id': conversation, 'label': timer['label'],
                'source_thread_id': thread}
        row = _public(timer)
        if apply:
            detail = client.post('/api/v2/timers/import', body)
            row.update(state=detail['state'], revision=detail['revision'])
        else:
            row['action'] = 'would_import_paused'
        report.append(row)
    return {'conversation_id': conversation, 'applied': apply, 'timers': report}


def instruction_for(timer, inline_prompt_file=False):
    text = timer['prompt']
    if inline_prompt_file and timer['prompt_file']:
        path = Path(timer['prompt_file'])
        if not path.is_absolute() or path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_INSTRUCTION:
            raise MoveError('prompt_file_unusable')
        text = path.read_text()
    text = text.strip()
    if not text or len(text.encode()) > MAX_INSTRUCTION:
        raise MoveError('instruction_unusable')
    return text


def _handoff_id(timer):
    return 'v2:' + timer['namespace']


def _v1_owner(v1, timer_id):
    for timer in v1.timers():
        if str(timer.get('id')) == timer_id:
            return timer.get('ownedBy') or 'v1', bool(timer.get('enabled'))
    raise MoveError('v1_timer_missing')


def handoff(client, v1, bundle, thread, conversation, timer_ids=None, include_disabled=False,
            inline_prompt_file=False, apply=False, force_enable_disabled=False):
    """Fence V1, then enable in V2. A definite V2 refusal restores V1 ownership.

    A timer disabled in V1 (`source_enabled` false) is never enabled in V2:
    neither selecting it with `timer_ids` nor `include_disabled` changes that
    (`include_disabled` is kept for compatibility and no longer enables
    anything). Only the separate `force_enable_disabled` hands such a timer
    off and enables it. Every skipped timer is listed in `skipped` with its
    reason (`source_disabled` or `dormant_schedule:<reason>`).
    """
    report, skipped = [], []
    for timer in _selected(bundle, thread, timer_ids):
        row = {'id': timer['id'], 'namespace': timer['namespace']}
        report.append(row)
        if timer['schedule']['kind'] == 'dormant':
            row['result'] = 'skipped_dormant_schedule:' + timer['schedule']['reason']
            row['reason'] = 'dormant_schedule:' + timer['schedule']['reason']
            skipped.append({'id': timer['id'], 'reason': row['reason']})
            continue
        if not timer['source_enabled']:
            if not force_enable_disabled:
                row.update(result='skipped_disabled_in_v1', reason='source_disabled')
                skipped.append({'id': timer['id'], 'reason': 'source_disabled'})
                continue
            row['forced_enable_disabled'] = True
        detail = client.get('/api/v2/timers/' + timer['namespace'])
        if detail.get('conversation_id') not in (None, conversation):
            raise MoveError('conversation_mismatch')
        if detail['state'] == 'enabled':
            owner, _ = _v1_owner(v1, timer['id'])
            row['result'] = 'already_v2' if owner == 'v2' else 'v2_enabled_without_v1_fence'
            if owner != 'v2' and apply:
                # Complete an interrupted move: the fence must exist for one owner.
                v1.handoff(timer['id'], _handoff_id(timer))
                row['result'] = 'fence_completed'
            continue
        if detail['state'] not in ('paused', 'disabled'):
            row['result'] = 'not_movable:' + detail['state']
            continue
        text = instruction_for(timer, inline_prompt_file)
        if not apply:
            row['result'] = 'would_hand_off'
            continue
        v1.handoff(timer['id'], _handoff_id(timer))
        key = 'handoff:%s:%d' % (timer['namespace'], detail['revision'])
        try:
            enabled = client.post('/api/v2/timers/%s/enable' % timer['namespace'], {
                'expected_revision': detail['revision'], 'request_key': key,
                'conversation_id': conversation, 'text': text})
        except v2_client.ApiError as error:
            if error.status == 0 or error.status >= 500:
                # Unknown outcome: V1 stays fenced (zero owners); rerun to finish.
                row['result'] = 'uncertain_rerun_handoff'
                continue
            v1.handback(timer['id'], _handoff_id(timer))
            row['result'] = 'v2_refused_restored_v1:' + error.code
            continue
        row.update(result='handed_off', next_due_ms=enabled.get('next_due_ms'),
                   controller_armed=enabled.get('controller_armed'))
    return {'conversation_id': conversation, 'applied': apply, 'timers': report, 'skipped': skipped}


def handback(client, v1, bundle, thread, timer_ids=None, keep_disabled=False, apply=False):
    """Disable in V2 first, then lift the V1 fence and restore V1 enablement."""
    report = []
    for timer in _selected(bundle, thread, timer_ids):
        row = {'id': timer['id'], 'namespace': timer['namespace']}
        report.append(row)
        owner, _ = _v1_owner(v1, timer['id'])
        try:
            detail = client.get('/api/v2/timers/' + timer['namespace'])
        except v2_client.ApiError as error:
            if error.status != 404:
                raise
            detail = None
        state = detail['state'] if detail else 'absent'
        if owner != 'v2' and state != 'enabled':
            row['result'] = 'already_v1'
            continue
        if not apply:
            row['result'] = 'would_hand_back'
            continue
        if state in ('enabled', 'exhausted'):
            client.post('/api/v2/timers/%s/control' % timer['namespace'], {
                'expected_revision': detail['revision'], 'action': 'disable',
                'request_key': 'handback:%s:%d' % (timer['namespace'], detail['revision'])})
        if owner == 'v2':
            v1.handback(timer['id'], _handoff_id(timer), keep_disabled=keep_disabled)
        row['result'] = 'handed_back'
    return {'applied': apply, 'timers': report}


def status(client, v1, bundle, thread, conversation):
    v2 = {t['namespace']: t for t in client.get('/api/v2/conversations/%s/timers' % conversation)['timers']}
    v1_timers = {str(t.get('id')): t for t in v1.timers()}
    report = []
    for timer in _selected(bundle, thread):
        old = v1_timers.get(timer['id']) or {}
        new = v2.get(timer['namespace'])
        v1_active = bool(old.get('enabled')) and (old.get('ownedBy') or 'v1') != 'v2'
        v2_active = bool(new) and new['state'] == 'enabled'
        owner = 'conflict' if v1_active and v2_active else 'v2' if v2_active else 'v1' if v1_active else 'none'
        report.append({'id': timer['id'], 'namespace': timer['namespace'], 'owner': owner,
                       'v1_owned_by': old.get('ownedBy') or ('v1' if old else 'missing'),
                       'v1_enabled': bool(old.get('enabled')), 'v2_state': new['state'] if new else 'not_imported',
                       'v2_next_due_ms': new.get('next_due_ms') if new else None,
                       'v2_armed': new.get('controller_armed') if new else None,
                       'v2_hold': new.get('controller_hold') if new else None})
    return {'conversation_id': conversation, 'timers': report,
            'single_owner': all(r['owner'] != 'conflict' for r in report)}
