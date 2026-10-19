"""Strip closed native result metadata before unchanged Stop evidence checks."""
import json

from protocol import exact, require

FIELDS = {'queued_turn_count', 'result_index', 'safety_stops', 'subagent_stats',
          'fast_mode_disabled_reason', 'origin', 'parent_tool_use_id', 'timestamp'}


def without_stop_metadata(frame):
    # Validate the original size, including every discarded field. This helper
    # cannot supply a missing result/UUID/input/reason or acknowledge a control.
    require(len(json.dumps(frame, allow_nan=False).encode()) <= 16384)
    for key in ('queued_turn_count', 'result_index', 'safety_stops'):
        if key in frame:
            require(type(frame[key]) is int and 0 <= frame[key] < 2**53)
    # Only one input is ever written to this native child. A native queue is
    # outside that contract even if the result otherwise echoes our input.
    if 'queued_turn_count' in frame: require(frame['queued_turn_count'] == 0)
    for key in ('fast_mode_disabled_reason', 'timestamp'):
        if key in frame:
            require(isinstance(frame[key], str) and len(frame[key].encode()) <= 128)
    if 'parent_tool_use_id' in frame: require(frame['parent_tool_use_id'] is None)
    if 'origin' in frame: require(frame['origin'] == {'kind': 'human'})
    if 'subagent_stats' in frame:
        value = frame['subagent_stats']
        exact(value, ('spawned', 'requested', 'started_in_background', 'by_type',
                     'max_depth', 'spawned_by_subagents', 'completed', 'failed',
                     'killed', 'refused'))
        for key in ('spawned', 'started_in_background', 'max_depth',
                    'spawned_by_subagents', 'completed', 'failed'):
            require(type(value[key]) is int and value[key] == 0)
        require(value['by_type'] == {})
        for key, names in (('requested', ('background', 'foreground', 'unset')),
                           ('killed', ('parent', 'user', 'system')),
                           ('refused', ('depth_limit', 'concurrency_limit', 'budget'))):
            exact(value[key], names)
            require(all(type(number) is int and number == 0 for number in value[key].values()))
    return {key: value for key, value in frame.items() if key not in FIELDS}
