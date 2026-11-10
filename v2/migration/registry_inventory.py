"""Fixed timer-registry structural inventory, without initializer or execution.

Source authority: storage/src/paths.js dataPaths().timers; repositories.js
createTimerRepository().list(); core/src/timers.js normalizeStoredTimer().
Raw persisted shapes only: never claim normalized scheduling or current activity.
"""
import json
import os
import stat

MAX_BYTES = 16 * 1024 * 1024
MAX_ROWS = 100_000


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def project_timers(raw):
    """Only fixed buckets; unknown values never become output keys or strings."""
    if type(raw) is not list or len(raw) > MAX_ROWS:
        raise ValueError('unsupported timer registry shape')
    result = {'rows': len(raw), 'objects': 0, 'non_objects': 0,
              'cadence': dict.fromkeys(('once', 'daily', 'weekly', 'interval', 'missing', 'unknown'), 0),
              'enabled_field': dict.fromkeys(('true', 'false', 'missing', 'unknown'), 0),
              'status': dict.fromkeys(('cancelled', 'canceled', 'disabled', 'failed', 'fired', 'missing', 'unknown'), 0),
              'target_type': dict.fromkeys(('thread', 'agent', 'missing', 'unknown'), 0),
              'required_connector_field_present': 0, 'required_desktop_field_present': 0,
              'legacy_object_present': 0, 'repeat_object_present': 0}
    for row in raw:
        if type(row) is not dict:
            result['non_objects'] += 1
            continue
        result['objects'] += 1
        for field, output in [('cadence', 'cadence'), ('status', 'status'), ('targetType', 'target_type')]:
            value = row.get(field)
            bucket = 'missing' if field not in row else value if type(value) is str and value in result[output] and value not in ('missing', 'unknown') else 'unknown'
            result[output][bucket] += 1
        value = row.get('enabled')
        bucket = 'missing' if 'enabled' not in row else 'true' if value is True else 'false' if value is False else 'unknown'
        result['enabled_field'][bucket] += 1
        for field, output in [('requiredConnector', 'required_connector_field_present'), ('requiredDesktop', 'required_desktop_field_present')]:
            result[output] += int(field in row)
        result['legacy_object_present'] += int(type(row.get('legacy')) is dict)
        result['repeat_object_present'] += int(type(row.get('repeat')) is dict)
    return result


def read_timer_inventory(home):
    """Open only home/timers.json, no symlink, writer, helper or other registry.

    Metadata stability is a bounded file-read check, not an atomic multi-store cut.
    Missing file is unavailable metadata, never evidence of an absent feature.
    """
    if not hasattr(os, 'O_NOFOLLOW'):
        raise ValueError('platform lacks nofollow')
    directory = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fd = os.open('timers.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return {'authority': 'timer_registry', 'coverage': 'missing_file', 'counts': None}
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_BYTES or before.st_nlink != 1:
                raise ValueError('unsupported registry file')
            data = bytearray()
            while len(data) <= MAX_BYTES:
                chunk = os.read(fd, min(65536, MAX_BYTES + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            after = os.fstat(fd)
            identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            current = os.stat('timers.json', dir_fd=directory, follow_symlinks=False)
            if identity(before) != identity(after) or identity(after) != identity(current) or len(data) > MAX_BYTES:
                raise ValueError('registry changed during read')
            try:
                value = json.loads(data, object_pairs_hook=_object, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
                counts = project_timers(value)
            except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
                raise ValueError('malformed registry') from None
            return {'authority': 'timer_registry', 'coverage': 'persisted_structure_only',
                    'consistency': 'one bounded file read with metadata stability check',
                    'activity_proven': False, 'cross_store_consistency': False, 'counts': counts}
        finally:
            os.close(fd)
    finally:
        os.close(directory)
