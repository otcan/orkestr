"""Closed API context-edit summaries; discarded metadata grants no authority."""
from protocol import exact, require

MAX_APPLIED_EDITS = 16
_COUNTERS = {
    'clear_tool_uses_20250919': ('cleared_input_tokens', 'cleared_tool_uses'),
    'clear_thinking_20251015': ('cleared_input_tokens', 'cleared_thinking_turns'),
}


def validate_context_management(value):
    """Validate a bounded SDK response without retaining or emitting its values.

    These historical edit counts are not tool permission, input correlation,
    output, control acknowledgement, or completion evidence. The containing
    frame still consumes its existing frame/event/wire budget.
    """
    if value is None:
        return
    require(type(value) is dict)
    exact(value, ('applied_edits',))
    edits = value['applied_edits']
    require(type(edits) is list and len(edits) <= MAX_APPLIED_EDITS)
    for edit in edits:
        require(type(edit) is dict)
        kind = edit.get('type')
        require(type(kind) is str and kind in _COUNTERS)
        fields = _COUNTERS[kind]
        exact(edit, ('type', *fields))
        for field in fields:
            count = edit[field]
            require(type(count) is int and 0 <= count < 2**53)
