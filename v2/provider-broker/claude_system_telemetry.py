"""Two closed headless system notices; neither is execution evidence."""
import uuid

from claude_control import canonical
from protocol import exact, require


def validate_system_telemetry(frame, native, message):
    common = ('type', 'subtype', 'session_id', 'uuid')
    require(frame['type'] == 'system' and frame['session_id'] == native)
    require(uuid.UUID(canonical(native)).int != 0 and uuid.UUID(canonical(message)).int != 0)
    if frame['subtype'] == 'thinking_tokens':
        exact(frame, (*common, 'user_message_uuid', 'estimated_tokens', 'estimated_tokens_delta'))
        require(frame['user_message_uuid'] == message)
        for key in ('estimated_tokens', 'estimated_tokens_delta'):
            require(type(frame[key]) is int and 0 <= frame[key] < 2**53)
    else:
        exact(frame, (*common, 'status', 'user_message_uuids'))
        require(frame['subtype'] == 'status' and frame['status'] == 'requesting'
                and frame['user_message_uuids'] == [message])
    event = canonical(frame['uuid'])
    require(uuid.UUID(event).int != 0 and event not in (native, message))
    return event
