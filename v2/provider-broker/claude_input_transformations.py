"""Closed Messages API input metadata; validate and discard without authority."""
import re

from protocol import exact, require

MAX_TRANSFORMATIONS = 128
_TYPES = ('thinking_dropped', 'thinking_mismatch_allowed')
_REASONS = ('model_binding_mismatch', 'prefix_binding_mismatch',
            'organization_binding_mismatch', 'end_user_binding_mismatch')
_PATH = re.compile(r'messages\.[0-9]{1,6}\.content\.[0-9]{1,6}')


def validate_input_transformations(value):
    """Accept only the documented bounded shape; retain or emit no values.

    These records describe the API's input processing, not an Orkestr action,
    current-input correlation, provider readiness, output, or control evidence.
    The containing frame still consumes its existing frame/event/wire budget.
    """
    if value is None:
        return
    require(type(value) is list and len(value) <= MAX_TRANSFORMATIONS)
    for item in value:
        require(type(item) is dict)
        exact(item, ('type', 'path', 'reason'))
        require(type(item['type']) is str and item['type'] in _TYPES
                and type(item['reason']) is str and item['reason'] in _REASONS)
        path = item['path']
        require(type(path) is str and len(path) <= 30 and _PATH.fullmatch(path) is not None)
