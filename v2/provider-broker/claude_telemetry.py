"""Closed non-authoritative native telemetry; selected-account data never forwarded."""
import json
import math
from protocol import exact, require
from claude_control import canonical

# Per-request turn progress scales with turn length (one "requesting" status
# per model request, one thinking estimate per thinking delta), so it has its
# own per-channel bound, like keep-alives and drained tool frames.
PROGRESS_LIMIT = 65536
PROGRESS_FIELDS = {
    'thinking_tokens': (('type', 'subtype', 'estimated_tokens', 'estimated_tokens_delta',
                         'session_id', 'uuid'), 'user_message_uuid'),
    'status': (('type', 'subtype', 'status', 'session_id', 'uuid'), 'user_message_uuids'),
}


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def progress_notice(frame, input_uuid):
    """Whether a system frame is installed-CLI turn progress; refuses a bad shape.

    Only `thinking_tokens` and `status: requesting` qualify, each with its exact
    installed fields plus the optional join key the CLI stamps on them. A join
    key must name this channel's one input. Metadata only, never forwarded.
    """
    subtype = frame.get('subtype')
    if not isinstance(subtype, str) or subtype not in PROGRESS_FIELDS:
        return False
    if subtype == 'status' and frame.get('status') != 'requesting':
        return False  # Other status notices stay in the rare-notice budget.
    fields, join = PROGRESS_FIELDS[subtype]
    require(set(frame) in (set(fields), set(fields) | {join}))
    canonical(frame['uuid'])
    if subtype == 'thinking_tokens':
        require(all(number(frame[key]) and frame[key] <= 2 ** 32
                    for key in ('estimated_tokens', 'estimated_tokens_delta')))
    if join in frame:
        require(input_uuid is not None and
                frame[join] == (input_uuid if subtype == 'thinking_tokens' else [input_uuid]))
    return True


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
