"""One selected child's one submitted input, anchored to one API response."""
import uuid

from claude_control import canonical
from protocol import require


def response_identity(frame):
    message = frame.get('message')
    require(isinstance(message, dict))
    value = message.get('id')
    if value is None:
        return None
    require(isinstance(value, str) and 0 < len(value.encode()) <= 512)
    request = frame.get('request_id')
    if 'request_id' in frame:
        require(isinstance(request, str) and 0 < len(request.encode()) <= 512)
    return value, request


class AssistantInput:
    def __init__(self, native, message):
        self.native, self.message = canonical(native), canonical(message)
        self.response, self.events = None, set()

    def prepare(self, frame):
        # This is reached only from the selected child's private read FD. It
        # cannot create an input, change its UUID, cross an API response, or
        # authorize a terminal. Nothing mutates until whole-frame validation.
        require(frame.get('type') == 'assistant' and frame.get('session_id') == self.native)
        require(frame.get('parent_tool_use_id') is None)
        identity = response_identity(frame)
        if self.response is not None:
            require(identity == self.response)
        if 'user_message_uuid' in frame:
            require(frame['user_message_uuid'] == self.message)
            if 'user_message_uuids' in frame: require(frame['user_message_uuids'] == [self.message])
        else:
            require(self.response is not None and identity == self.response
                    and 'user_message_uuids' not in frame)
        if identity is None:
            # Legacy explicitly correlated text remains supported, but cannot
            # anchor later omitted correlation without an API response ID.
            return frame, None
        event = canonical(frame.get('uuid'))
        require(uuid.UUID(event).int != 0 and event not in (self.native, self.message)
                and event not in self.events and len(self.events) < 128)
        return dict(frame, user_message_uuid=self.message), (identity, event)

    def commit(self, prepared):
        identity, event = prepared
        require(self.response is None or self.response == identity)
        require(event not in self.events and len(self.events) < 128)
        self.response = identity
        self.events.add(event)
