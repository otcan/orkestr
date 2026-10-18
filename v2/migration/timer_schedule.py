"""Pure dormant schedule adapter. No Store, registry I/O, scheduler or dispatch.

Source: packages/core/src/timers.js normalizeStoredTimer, nextRunAt,
nextZonedClockRunAt, parseIntervalMs. Input must already be normalized metadata.
This intentionally refuses legacy defaults, implicit host time and DST ambiguity.
"""
import copy
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class TimerRefusal(ValueError):
    pass


def _text(value, limit=128):
    if not isinstance(value, str) or not value or len(value.encode('utf-8')) > limit or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise TimerRefusal('invalid bounded metadata')
    return value


def _instant(value):
    try:
        value = datetime.fromisoformat(_text(value, 64).replace('Z', '+00:00'))
        if value.tzinfo is None:
            raise ValueError()
        return value.astimezone(timezone.utc)
    except (ValueError, OverflowError) as exc:
        raise TimerRefusal('explicit instant required') from exc


def _iso(value):
    return value.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def export_schedule(namespace, metadata):
    """Project only schedule metadata; never copy owner, payload or bindings.

    No normalization/initializer is invoked. Callers retain the source snapshot
    boundary externally. Hash covers this projection, not the excluded workload.
    """
    if not isinstance(metadata, dict):
        raise TimerRefusal('normalized object required')
    cadence = metadata.get('cadence')
    if cadence not in ('once', 'interval', 'daily', 'weekly'):
        raise TimerRefusal('unknown cadence')
    # Terminal/uncertain legacy effects cannot be reconstructed as a schedule.
    if metadata.get('status', '') not in ('', 'active', 'pending') or metadata.get('legacy'):
        raise TimerRefusal('legacy or uncertain state requires review')
    if type(metadata.get('enabled')) is not bool:
        raise TimerRefusal('explicit enabled provenance required')
    schedule = {'cadence': cadence}
    if cadence == 'once':
        schedule['runAt'] = _iso(_instant(metadata.get('runAt')))
    elif cadence == 'interval':
        match = re.fullmatch(r'([0-9]+)\s*(m|h|d)', str(metadata.get('every', '')).strip(), re.I)
        if not match:
            raise TimerRefusal('invalid interval; legacy fallback refused')
        amount = max(1, int(match[1]))
        seconds = amount * {'m': 60, 'h': 3600, 'd': 86400}[match[2].lower()]
        if seconds > 366 * 86400:
            raise TimerRefusal('interval exceeds adapter bound')
        schedule['everySeconds'] = seconds
    else:
        clock = metadata.get('time', '')
        if not isinstance(clock, str) or not re.fullmatch(r'(?:[01]?[0-9]|2[0-3]):[0-5][0-9]', clock):
            raise TimerRefusal('clock fallback/clamping refused')
        zone = _text(metadata.get('timezone'), 80)
        try:
            ZoneInfo(zone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise TimerRefusal('unknown explicit timezone') from exc
        schedule.update(time=clock, timezone=zone)
    projection = {'version': 1, 'sourceNamespace': _text(namespace),
                  'sourceTimerId': _text(metadata.get('id')),
                  'sourceEnabled': metadata['enabled'], 'schedule': schedule}
    return {'projection': projection, 'scheduleDigest': fingerprint(projection), 'state': 'PAUSED'}


def validate_export(value):
    if not isinstance(value, dict) or set(value) != {'projection', 'scheduleDigest', 'state'} or value['state'] != 'PAUSED':
        raise TimerRefusal('invalid dormant export')
    p = value['projection']
    if not isinstance(p, dict) or set(p) != {'version', 'sourceNamespace', 'sourceTimerId', 'sourceEnabled', 'schedule'} or type(p['version']) is not int or p['version'] != 1:
        raise TimerRefusal('invalid provenance')
    s = p['schedule']
    if not isinstance(s, dict):
        raise TimerRefusal('invalid schedule')
    cadence = s.get('cadence')
    keys = {'once': {'cadence', 'runAt'}, 'interval': {'cadence', 'everySeconds'},
            'daily': {'cadence', 'time', 'timezone'}, 'weekly': {'cadence', 'time', 'timezone'}}
    if not isinstance(cadence, str) or cadence not in keys or set(s) != keys[cadence]:
        raise TimerRefusal('unknown schedule fields')
    metadata = {'id': p['sourceTimerId'], 'enabled': p['sourceEnabled'], **s}
    if cadence == 'interval':
        seconds = s['everySeconds']
        if type(seconds) is not int or seconds < 60 or seconds % 60:
            raise TimerRefusal('invalid interval seconds')
        metadata['every'] = str(seconds // 60) + 'm'
    expected = export_schedule(p['sourceNamespace'], metadata)
    if expected != value:
        raise TimerRefusal('noncanonical or changed projection')
    return copy.deepcopy(value)


def next_due(value, now):
    """Fake-clock preview only, never admission. Overdue once refuses catch-up."""
    s = validate_export(value)['projection']['schedule']
    now = _instant(now)
    cadence = s['cadence']
    if cadence == 'once':
        due = _instant(s['runAt'])
        if due <= now:
            raise TimerRefusal('overdue once requires explicit reschedule')
        return _iso(due)
    if cadence == 'interval':
        return _iso(now + timedelta(seconds=s['everySeconds']))
    zone = ZoneInfo(s['timezone'])
    local = now.astimezone(zone)
    hour, minute = map(int, s['time'].split(':'))
    wall = local.replace(hour=hour, minute=minute, second=0, microsecond=0, tzinfo=None)

    def resolve(wall):
        candidates = {wall.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc)
                      for fold in (0, 1)
                      if wall.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None) == wall}
        if len(candidates) != 1:
            raise TimerRefusal('DST ambiguous/nonexistent wall time requires review')
        return candidates.pop()

    due = resolve(wall)
    if due <= now:
        due = resolve(wall + timedelta(days=7 if cadence == 'weekly' else 1))
    return _iso(due)


def prepare_import(value, target_namespace):
    return {'export': validate_export(value), 'targetNamespace': _text(target_namespace), 'state': 'PAUSED'}


def prepare_enable(value, target_namespace, expected_revision, request_key, now):
    """Intent for a future Core port, NOT authenticated authority or Store write."""
    if type(expected_revision) is not int or expected_revision < 1:
        raise TimerRefusal('invalid expected revision')
    return {'import': prepare_import(value, target_namespace), 'expectedRevision': expected_revision,
            'requestKey': _text(request_key), 'previewDueAt': next_due(value, now)}
