"""Convert V1-style timers into one calendar timer, keeping the old ones paused.

A recipe names the V1 timers a calendar timer replaces (for example twelve
hourly triage timers plus the weekday/weekend controllers) and the rule, silent
mode and digest of the new timer. The tool works in three reviewed steps:

  calendar-plan      read-only; prints the derived rule in plain words, what is
                     replaced, and a digest that apply must be given back
  calendar-apply     one owner at every step: fence/disable the old timers,
                     then enable the new one; idempotent by deterministic keys
  calendar-rollback  disable the new timer, then restore the old ones
                     (re-enable in V2, or hand back to V1)

The old timers are never deleted: V2 copies stay disabled and V1 copies stay
fenced (`ownedBy: v2`) or disabled, so rollback is a state change, not a
restore from backup. Timer instructions are read from the bundle and sent only
to the owner's own V2; reports contain identifiers, states and the rule.
"""
import hashlib
import json
from pathlib import Path
import re
import uuid

import timer_moves
import v2_client

RECIPE_SCHEMA = 'orkestr.calendar-recipe.v1'
NAMESPACE = uuid.UUID('b8d1f0c2-6c1e-5a4b-9d73-2f5e8a1c4b60')
WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
SOURCE_NAMESPACE = 'orkestr:calendar'


class ConvertError(RuntimeError):
    pass


# -- the rule ---------------------------------------------------------------

def clock(minutes):
    return '%02d:%02d' % (minutes // 60, minutes % 60)


def parse_clock(text):
    minute = timer_moves._clock(text)
    if minute is None:
        raise ConvertError('invalid_clock')
    return minute


def normalize(rule):
    """Same checks as the server's CalendarRule::normalized."""
    rule = dict(rule)
    days = sorted(set(rule.get('weekdays') or []))
    minutes = sorted(set(rule.get('minutes') or []))
    if any(type(d) is not int or not 1 <= d <= 7 for d in days):
        raise ConvertError('weekday_range')
    if len(days) == 7:
        days = []
    if not minutes or any(type(m) is not int or not 0 <= m < 60 for m in minutes):
        raise ConvertError('minutes_range')
    start, end, every = rule.get('start_minute'), rule.get('end_minute'), rule.get('every_hours', 1)
    if type(start) is not int or type(end) is not int or not 0 <= start <= end < 1440:
        raise ConvertError('window_range')
    if type(every) is not int or not 1 <= every <= 24:
        raise ConvertError('every_hours_range')
    zone = str(rule.get('timezone') or '')
    if not zone or timer_moves._zone(zone) is None:
        raise ConvertError('timezone_unknown')
    normal = {'kind': 'calendar', 'timezone': zone, 'weekdays': days, 'start_minute': start,
              'end_minute': end, 'every_hours': every, 'minutes': minutes}
    if not day_minutes(normal):
        raise ConvertError('rule_never_fires')
    return normal


def day_minutes(rule):
    first = rule['start_minute'] // 60
    return [h * 60 + m for h in range(first, 24, rule['every_hours']) for m in rule['minutes']
            if rule['start_minute'] <= h * 60 + m <= rule['end_minute']]


def _days(weekdays):
    if not weekdays:
        return 'every day'
    parts, i = [], 0
    while i < len(weekdays):
        j = i
        while j + 1 < len(weekdays) and weekdays[j + 1] == weekdays[j] + 1:
            j += 1
        name = lambda d: WEEKDAY_NAMES[d - 1]
        if j == i:
            parts.append(name(weekdays[i]))
        elif j == i + 1:
            parts.append('%s, %s' % (name(weekdays[i]), name(weekdays[j])))
        else:
            parts.append('%s–%s' % (name(weekdays[i]), name(weekdays[j])))
        i = j + 1
    return ', '.join(parts)


def describe(rule):
    """Plain words, identical to the server's CalendarRule::describe."""
    offsets = [':%02d' % m for m in rule['minutes']]
    offsets = offsets[0] if len(offsets) == 1 else '%s and %s' % (', '.join(offsets[:-1]), offsets[-1])
    times = day_minutes(rule)
    days = _days(rule['weekdays'])
    if len(times) == 1:
        if not rule['weekdays']:
            return 'Every day at %s %s' % (clock(times[0]), rule['timezone'])
        return 'At %s %s, %s' % (clock(times[0]), rule['timezone'], days)
    cadence = 'Hourly' if rule['every_hours'] == 1 else 'Every %d hours' % rule['every_hours']
    return '%s at %s, %s, %s–%s %s' % (cadence, offsets, days, clock(rule['start_minute']),
                                             clock(rule['end_minute']), rule['timezone'])


def derive_ladder(timers):
    """Window, step and minute offset of daily timers that fire on a regular ladder."""
    zones, clocks = set(), []
    for timer in timers:
        schedule = timer['schedule']
        if schedule.get('kind') != 'zoned_clock' or schedule.get('weekday') is not None:
            raise ConvertError('not_daily_clock:' + timer['id'])
        zones.add(schedule['timezone'])
        clocks.append(schedule['minute_of_day'])
    if len(zones) != 1:
        raise ConvertError('mixed_timezones')
    clocks.sort()
    offsets = {c % 60 for c in clocks}
    hours = [c // 60 for c in clocks]
    if len(offsets) != 1 or len(set(hours)) != len(hours):
        raise ConvertError('not_a_ladder')
    steps = {b - a for a, b in zip(hours, hours[1:])}
    if len(steps) > 1:
        raise ConvertError('uneven_ladder')
    return {'timezone': zones.pop(), 'start_minute': clocks[0], 'end_minute': clocks[-1],
            'every_hours': steps.pop() if steps else 1, 'minutes': [offsets.pop()]}


# -- recipe -----------------------------------------------------------------

def load_recipe(path):
    recipe = json.loads(Path(path).read_text())
    if not isinstance(recipe, dict) or recipe.get('schema') != RECIPE_SCHEMA:
        raise ConvertError('recipe_schema')
    for key in ('name', 'thread', 'label', 'replace'):
        if not recipe.get(key):
            raise ConvertError('recipe_missing:' + key)
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', recipe['name']):
        raise ConvertError('recipe_name')
    if len(recipe['label']) > 200:
        raise ConvertError('recipe_label')
    return recipe


def _match(bundle, thread, selector, role):
    rows = [t for t in bundle['timers'] if t['thread'] == thread]
    ids = set(selector.get('ids') or [])
    prefixes = tuple(selector.get('label_prefix') or ())
    if isinstance(selector.get('label_prefix'), str):
        prefixes = (selector['label_prefix'],)
    chosen = [t for t in rows if t['id'] in ids or (prefixes and t['label'].startswith(prefixes))]
    if ids - {t['id'] for t in chosen}:
        raise ConvertError('%s_timer_not_in_bundle' % role)
    return chosen


def new_namespace(bundle, recipe):
    return str(uuid.uuid5(NAMESPACE, '%s\n%s\n%s' % (bundle['source_instance'], recipe['name'], recipe['thread'])))


def resolve(bundle, recipe, inline_prompt_file=True):
    """The rule, policy, instruction and timers a recipe stands for."""
    replaced = _match(bundle, recipe['thread'], recipe['replace'], 'replaced')
    retired = _match(bundle, recipe['thread'], recipe.get('retire') or {}, 'retired')
    if not replaced:
        raise ConvertError('nothing_to_replace')
    if {t['id'] for t in replaced} & {t['id'] for t in retired}:
        raise ConvertError('replaced_and_retired_overlap')
    spec = dict(recipe.get('schedule') or {})
    if spec.get('derive'):
        rule = derive_ladder(replaced)
        rule.update({k: v for k, v in spec.items() if k in ('timezone', 'every_hours', 'minutes')})
        if 'start' in spec:
            rule['start_minute'] = parse_clock(spec['start'])
        if 'end' in spec:
            rule['end_minute'] = parse_clock(spec['end'])
        if 'weekdays' not in spec:
            raise ConvertError('weekdays_required')
        rule['weekdays'] = spec['weekdays']
    else:
        rule = {'timezone': spec.get('timezone'), 'weekdays': spec.get('weekdays') or [],
                'start_minute': parse_clock(spec.get('start')), 'end_minute': parse_clock(spec.get('end')),
                'every_hours': spec.get('every_hours', 1), 'minutes': spec.get('minutes')}
    rule = normalize(rule)
    texts = {timer_moves.instruction_for(t, inline_prompt_file) for t in replaced}
    if len(texts) != 1:
        raise ConvertError('instructions_differ')
    instruction = texts.pop()
    suffix = str(recipe.get('instruction_suffix') or '').strip()
    if suffix:
        # Only ever appended: the carried-over V1 prompt (and its guards) stays byte for byte.
        instruction = instruction + '\n\n' + suffix
        if len(instruction.encode()) > timer_moves.MAX_INSTRUCTION:
            raise ConvertError('instruction_too_long')
    options = recipe.get('policy') or {}
    policy = {'silent_mode': 'unless_changed' if options.get('silent', True) else 'off',
              'skip_dates': sorted(options.get('skip_dates') or []), 'digest': None, 'trigger': None}
    if options.get('digest'):
        digest = options['digest']
        policy['digest'] = {'timezone': digest.get('timezone') or rule['timezone'],
                            'minutes': sorted({parse_clock(t) for t in digest['times']})}
    if options.get('trigger'):
        policy['trigger'] = {'sources': sorted(set(options['trigger']['sources'])),
                             'min_interval_s': int(options['trigger'].get('min_interval_s', 60))}
    return {'rule': rule, 'policy': policy, 'instruction': instruction, 'replaced': replaced, 'retired': retired,
            'namespace': new_namespace(bundle, recipe)}


def plan_digest(resolved, conversation):
    """What `apply` must be given back: binds the reviewed rule, policy and set of timers."""
    body = json.dumps({'rule': resolved['rule'], 'policy': resolved['policy'], 'conversation': conversation,
                       'instruction': hashlib.sha256(resolved['instruction'].encode()).hexdigest(),
                       'replaced': sorted(t['id'] for t in resolved['replaced']),
                       'retired': sorted(t['id'] for t in resolved['retired']),
                       'namespace': resolved['namespace']}, sort_keys=True)
    return hashlib.sha256(body.encode()).hexdigest()[:16]


# -- state ------------------------------------------------------------------

def _v1_state(v1_by_id, timer):
    old = v1_by_id.get(timer['id']) or {}
    return {'v1_owned_by': old.get('ownedBy') or ('v1' if old else 'missing'), 'v1_enabled': bool(old.get('enabled'))}


def _v2_timers(client, conversation):
    if client is None or not conversation:
        return {}
    return {t['namespace']: t for t in client.get('/api/v2/conversations/%s/timers' % conversation)['timers']}


def inspect(client, v1, bundle, recipe, resolved, conversation):
    v2 = _v2_timers(client, conversation)
    v1_by_id = {str(t.get('id')): t for t in v1.timers()} if v1 else {}

    def row(timer):
        current = v2.get(timer['namespace'])
        return dict(id=timer['id'], label=timer['label'], namespace=timer['namespace'], **_v1_state(v1_by_id, timer),
                    v2_state=current['state'] if current else 'not_imported')
    new = v2.get(resolved['namespace'])
    return {'replaced': [row(t) for t in resolved['replaced']], 'retired': [row(t) for t in resolved['retired']],
            'new': {'namespace': resolved['namespace'], 'state': new['state'] if new else 'absent',
                    'revision': new['revision'] if new else None,
                    'next_due_ms': new.get('next_due_ms') if new else None}}


def plan(client, v1, bundle, recipe, conversation=None, inline_prompt_file=True):
    resolved = resolve(bundle, recipe, inline_prompt_file)
    state = inspect(client, v1, bundle, recipe, resolved, conversation)
    blocked = None
    if not conversation:
        blocked = 'thread_not_on_v2: move the thread to V2 first, then re-run with --conversation'
    elif any(r['v1_enabled'] and r['v1_owned_by'] != 'v2' for r in state['retired']):
        blocked = 'a retired V1 controller is still enabled; pause it first'
    return {'recipe': recipe['name'], 'thread': recipe['thread'], 'conversation_id': conversation,
            'rule': resolved['rule'], 'summary': describe(resolved['rule']), 'policy': resolved['policy'],
            'new_timer': state['new'], 'replaced': state['replaced'], 'retired': state['retired'],
            'instruction_sha256': hashlib.sha256(resolved['instruction'].encode()).hexdigest(),
            'plan_digest': plan_digest(resolved, conversation), 'blocked': blocked,
            'then': ['fence or disable the replaced timers', 'create the calendar timer paused',
                     'enable it with the unchanged instruction', 'keep controllers and old timers off']}


def _handoff_id(timer):
    return 'v2:' + timer['namespace']


def apply(client, v1, bundle, recipe, conversation, confirm, inline_prompt_file=True):
    """Fence first, then create, then enable: at no step do old and new both run."""
    resolved = resolve(bundle, recipe, inline_prompt_file)
    if not conversation:
        raise ConvertError('thread_not_on_v2')
    if confirm != plan_digest(resolved, conversation):
        raise ConvertError('plan_digest_mismatch')
    state = inspect(client, v1, bundle, recipe, resolved, conversation)
    if any(r['v1_enabled'] and r['v1_owned_by'] != 'v2' for r in state['retired']):
        raise ConvertError('v1_controller_enabled')
    namespace, report = resolved['namespace'], []

    def step(name, result, **extra):
        report.append(dict(step=name, result=result, **extra))

    # 1. Replaced timers still run by V1 are fenced so V1 can no longer fire them.
    v1_by_id = {str(t.get('id')): t for t in v1.timers()}
    for timer in resolved['replaced']:
        old = v1_by_id.get(timer['id']) or {}
        if (old.get('ownedBy') or 'v1') != 'v2' and old.get('enabled'):
            v1.handoff(timer['id'], _handoff_id(timer))
            step('v1_fence', 'fenced', id=timer['id'])
    # 2. The new timer exists, paused, before anything old is turned off.
    v2 = _v2_timers(client, conversation)
    current = v2.get(namespace)
    if current is None:
        body = {'namespace': namespace, 'conversation_id': conversation, 'label': recipe['label'][:200],
                'schedule': resolved['rule'], 'policy': resolved['policy']}
        current = client.post('/api/v2/timers/calendar', body)
        step('create', 'created_paused')
    else:
        step('create', 'exists:' + current['state'])
    # 3. Old V2 copies go off (kept for rollback), controllers stay as they are.
    for timer in resolved['replaced']:
        old = v2.get(timer['namespace'])
        if old and old['state'] in ('enabled', 'exhausted'):
            client.post('/api/v2/timers/%s/control' % timer['namespace'], {
                'expected_revision': old['revision'], 'action': 'disable',
                'request_key': 'calendar-retire:%s:%d' % (namespace, old['revision'])})
            step('disable_old', 'disabled', id=timer['id'])
        else:
            step('disable_old', 'already_off:' + (old['state'] if old else 'absent'), id=timer['id'])
    # 4. Enable the new timer with the unchanged instruction.
    if current['state'] == 'enabled':
        step('enable', 'already_enabled')
    elif current['state'] in ('paused', 'disabled'):
        try:
            enabled = client.post('/api/v2/timers/%s/enable' % namespace, {
                'expected_revision': current['revision'], 'request_key': 'calendar-enable:%s:%d' % (namespace, current['revision']),
                'conversation_id': conversation, 'text': resolved['instruction']})
        except v2_client.ApiError as error:
            # Zero owners is safe; rerunning apply (or rollback) finishes the job.
            step('enable', 'refused:%s:%s' % (error.status, error.code))
            return {'applied': True, 'complete': False, 'steps': report}
        step('enable', 'enabled', next_due_ms=enabled.get('next_due_ms'), armed=enabled.get('controller_armed'))
    else:
        step('enable', 'not_movable:' + current['state'])
        return {'applied': True, 'complete': False, 'steps': report}
    return {'applied': True, 'complete': True, 'steps': report, 'rule': describe(resolved['rule'])}


def rollback(client, v1, bundle, recipe, conversation, to='v2', inline_prompt_file=True):
    """Disable the new timer first, then give the old ones back."""
    resolved = resolve(bundle, recipe, inline_prompt_file)
    namespace, report = resolved['namespace'], []
    v2 = _v2_timers(client, conversation)
    new = v2.get(namespace)
    if new and new['state'] in ('enabled', 'exhausted'):
        client.post('/api/v2/timers/%s/control' % namespace, {
            'expected_revision': new['revision'], 'action': 'disable',
            'request_key': 'calendar-rollback:%s:%d' % (namespace, new['revision'])})
        report.append({'step': 'disable_new', 'result': 'disabled'})
    else:
        report.append({'step': 'disable_new', 'result': 'already_off:' + (new['state'] if new else 'absent')})
    v1_by_id = {str(t.get('id')): t for t in v1.timers()}
    for timer in resolved['replaced']:
        old = v2.get(timer['namespace'])
        fenced = (v1_by_id.get(timer['id']) or {}).get('ownedBy') == 'v2'
        if to == 'v1' or old is None:
            if fenced:
                v1.handback(timer['id'], _handoff_id(timer))
                report.append({'step': 'restore', 'id': timer['id'], 'result': 'handed_back_to_v1'})
            else:
                report.append({'step': 'restore', 'id': timer['id'], 'result': 'already_v1'})
            continue
        if old['state'] == 'enabled':
            report.append({'step': 'restore', 'id': timer['id'], 'result': 'already_enabled'})
            continue
        client.post('/api/v2/timers/%s/enable' % timer['namespace'], {
            'expected_revision': old['revision'], 'request_key': 'calendar-restore:%s:%d' % (timer['namespace'], old['revision']),
            'conversation_id': conversation, 'text': timer_moves.instruction_for(timer, inline_prompt_file)})
        report.append({'step': 'restore', 'id': timer['id'], 'result': 're_enabled_in_v2'})
    return {'rolled_back': True, 'to': to, 'steps': report}


def status(client, v1, bundle, recipe, conversation, inline_prompt_file=True):
    resolved = resolve(bundle, recipe, inline_prompt_file)
    state = inspect(client, v1, bundle, recipe, resolved, conversation)
    old_active = [r['id'] for r in state['replaced']
                  if r['v2_state'] == 'enabled' or (r['v1_enabled'] and r['v1_owned_by'] != 'v2')]
    new_active = state['new']['state'] == 'enabled'
    return {'new': state['new'], 'old_active': old_active, 'new_active': new_active,
            'single_owner': not (old_active and new_active), 'retired': state['retired']}
