"""Correlated native error result -> redacted Failed observation, never Stop."""
import json
import math
import uuid

from claude_control import canonical, correlated
from protocol import require


def sanitize_failure(frame, native, message, excluded):
    # Native print error results contain errors[], not the success-only result
    # string. Keep this narrow branch separate from interrupted Stop evidence.
    required = {'type', 'subtype', 'session_id', 'uuid', 'user_message_uuid',
                'is_error', 'errors', 'duration_ms', 'duration_api_ms', 'num_turns',
                'stop_reason', 'total_cost_usd', 'usage', 'modelUsage', 'permission_denials'}
    optional = {'user_message_uuids', 'terminal_reason', 'fast_mode_state',
                'fast_mode_disabled_reason', 'queued_turn_count', 'result_index',
                'safety_stops', 'subagent_stats'}
    require(isinstance(frame, dict) and required <= set(frame)
            and set(frame) <= required | optional)
    require(frame['type'] == 'result' and frame['subtype'] == 'error_during_execution'
            and frame['is_error'] is True)
    require(uuid.UUID(canonical(native)).int != 0 and uuid.UUID(canonical(message)).int != 0)
    correlated(frame, native, message)
    terminal = canonical(frame['uuid'])
    require(uuid.UUID(terminal).int != 0 and terminal not in (native, message)
            and terminal not in excluded)
    errors = frame['errors']
    require(isinstance(errors, list) and 0 < len(errors) <= 128
            and all(isinstance(value, str) and len(value.encode()) <= 8192 for value in errors)
            and sum(len(value.encode()) for value in errors) <= 8192)
    require(len(json.dumps(frame, allow_nan=False).encode()) <= 16384)
    for key in ('duration_ms', 'duration_api_ms', 'num_turns', 'queued_turn_count',
                'result_index', 'safety_stops'):
        if key in frame:
            require(type(frame[key]) is int and 0 <= frame[key] < 2**53)
    cost = frame['total_cost_usd']
    require(type(cost) in (int, float) and math.isfinite(cost) and cost >= 0)
    require(isinstance(frame['usage'], dict) and isinstance(frame['modelUsage'], dict))
    require(frame['permission_denials'] == [])  # this channel is tool-disabled
    if 'subagent_stats' in frame:
        require(isinstance(frame['subagent_stats'], dict))
    for key in ('stop_reason', 'fast_mode_state', 'fast_mode_disabled_reason'):
        if key in frame:
            require(frame[key] is None or isinstance(frame[key], str)
                    and len(frame[key].encode()) <= 128)
    if 'terminal_reason' in frame:
        require(frame['terminal_reason'] in ('blocking_limit', 'rapid_refill_breaker',
            'prompt_too_long', 'image_error', 'model_error', 'api_error',
            'malformed_tool_use_exhausted', 'turn_setup_failed'))
    # No error text, usage, model, account, or terminal-reason text escapes.
    # Empty result is the existing Runtime failure contract, not a success.
    return {'type': 'result', 'session_id': native, 'uuid': terminal,
            'user_message_uuid': message, 'subtype': 'error_during_execution',
            'is_error': True, 'result': ''}
