"""Value-free header-key projection; never a parser or authority decision.

Standalone so a separately authenticated diagnostic collector can path-load this
exact file without changing module search paths. Input is already bounded JSON.
"""

MESSAGE_REQUIRED_KEYS = ('id', 'role', 'content')
MESSAGE_OPTIONAL_KEYS = (
    'type', 'model', 'stop_reason', 'stop_sequence', 'usage', 'container',
    'context_management', 'stop_details', 'diagnostics', 'resumable',
)
EXTRA_LIMIT = 64
_REQUIRED_ALL = (1 << len(MESSAGE_REQUIRED_KEYS)) - 1
_OPTIONAL_ALL = (1 << len(MESSAGE_OPTIONAL_KEYS)) - 1
_FIELDS = frozenset(('version', 'kind', 'required_mask', 'optional_mask',
                     'extra_count', 'extra_overflow'))


def message_header_shape(message):
    """Return fixed masks/counts only, never key names, values, or their hashes."""
    result = dict(version=1, kind='not_object', required_mask=0, optional_mask=0,
                  extra_count=0, extra_overflow=False)
    # JSON produces exact dicts. Refuse subclasses without calling their hooks.
    if type(message) is not dict:
        return result
    required = sum(1 << i for i, key in enumerate(MESSAGE_REQUIRED_KEYS) if key in message)
    optional = sum(1 << i for i, key in enumerate(MESSAGE_OPTIONAL_KEYS) if key in message)
    extra = len(message) - required.bit_count() - optional.bit_count()
    kind = ('missing_required' if required != _REQUIRED_ALL else
            'extra_fields' if extra else 'closed_keys')
    result.update(kind=kind, required_mask=required, optional_mask=optional,
                  extra_count=min(extra, EXTRA_LIMIT), extra_overflow=extra > EXTRA_LIMIT)
    return result


def valid_header_shape(value):
    """Validate the projection's closed schema, not the original message."""
    if type(value) is not dict or value.keys() != _FIELDS:
        return False
    if type(value['version']) is not int or value['version'] != 1:
        return False
    for key, maximum in (('required_mask', _REQUIRED_ALL),
                         ('optional_mask', _OPTIONAL_ALL), ('extra_count', EXTRA_LIMIT)):
        if type(value[key]) is not int or not 0 <= value[key] <= maximum:
            return False
    if type(value['extra_overflow']) is not bool or type(value['kind']) is not str:
        return False
    extra, overflow = value['extra_count'], value['extra_overflow']
    if overflow and extra != EXTRA_LIMIT:
        return False
    required, optional, kind = value['required_mask'], value['optional_mask'], value['kind']
    if kind == 'not_object':
        return required == optional == extra == 0 and not overflow
    if required != _REQUIRED_ALL:
        return kind == 'missing_required'
    return kind == ('extra_fields' if extra else 'closed_keys')
