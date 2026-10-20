"""Closed non-authoritative native telemetry; selected-account data never forwarded."""
import json
import math
from protocol import exact, require


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def validate_telemetry(frame, input_uuid):
    if frame['type'] == 'command_lifecycle':
        exact(frame, ('type', 'session_id', 'uuid', 'command_uuid', 'state'))
        require(input_uuid is not None and frame['command_uuid'] == input_uuid)
        # Native command fate is metadata, including removal or failed turns.
        # None of these states is an interrupt acknowledgement or run terminal.
        require(frame['state'] in ('queued', 'started', 'completed',
                                   'cancelled', 'discarded', 'refused'))
        return
    exact(frame, ('type', 'session_id', 'uuid', 'rate_limit_info'))
    info = frame['rate_limit_info']
    # Account rate-limit telemetry is never forwarded and grants nothing. The
    # installed CLI adds fields over time (e.g. overageEnabled); refusing an
    # unknown informational field would kill the turn, so only its shape and
    # size are bounded. Quota failure itself arrives as the assistant error.
    require(isinstance(info, dict) and isinstance(info.get('status'), str)
            and 0 < len(info['status']) <= 64 and len(info) <= 32
            and all(isinstance(key, str) and len(key) <= 64 for key in info)
            and len(json.dumps(info, allow_nan=False).encode()) <= 4096)
