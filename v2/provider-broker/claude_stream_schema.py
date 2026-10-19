"""Closed no-tools partial-message shapes; discarded metadata is never authority."""
import json
import math
import uuid

from claude_control import canonical
from claude_input_transformations import validate_input_transformations
from claude_stream_diagnostic import MESSAGE_OPTIONAL_KEYS, MESSAGE_REQUIRED_KEYS
from protocol import exact, require

MAX_TEXT = 32768
MAX_DELTA = 8192
MAX_FRAME = 65536
MAX_RAW = 1048576
MAX_EVENTS = 1024
MAX_BLOCKS = 128
MAX_THINKING = 262144
STOP_REASONS = ('end_turn', 'max_tokens', 'stop_sequence', 'refusal')


def text(value, maximum=512, nonempty=False):
    require(isinstance(value, str) and '\0' not in value)
    raw = value.encode('utf-8')
    require(len(raw) <= maximum and (not nonempty or bool(raw)))
    return raw


def number(value, integer=False):
    require(type(value) in ((int,) if integer else (int, float))
            and math.isfinite(value) and 0 <= value < 2**53)


def event_id(value, native, message):
    value = canonical(value)
    require(uuid.UUID(value).int != 0 and value not in (native, message))
    return value


def frame_size(frame):
    # Decoded object bound; ClaudePump separately supplies exact original wire bytes.
    size = len(json.dumps(frame, allow_nan=False, ensure_ascii=False,
                          separators=(',', ':')).encode('utf-8'))
    require(size <= MAX_FRAME)
    return size


def echo(frame, message, required=False):
    if 'user_message_uuid' in frame:
        require(frame['user_message_uuid'] == message)
        if 'user_message_uuids' in frame:
            require(frame['user_message_uuids'] == [message])
    else:
        require(not required and 'user_message_uuids' not in frame)


def usage(value):
    numeric = {'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'}
    optional = {'cache_creation', 'server_tool_use', 'service_tier', 'inference_geo',
                'iterations', 'output_tokens_details', 'fallback_credit', 'speed'}
    require(isinstance(value, dict) and set(value) <= numeric | optional)
    for key in numeric & set(value):
        if value[key] is not None: number(value[key], integer=True)
    for key, fields in (
            ('cache_creation', {'ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'}),
            ('server_tool_use', {'web_search_requests', 'web_fetch_requests'}),
            ('output_tokens_details', {'reasoning_tokens', 'thinking_tokens'})):
        if value.get(key) is not None:
            item = value[key]
            require(isinstance(item, dict) and set(item) <= fields)
            for count in item.values(): number(count, integer=True)
            if key == 'server_tool_use': require(not any(item.values()))
    for key in ('service_tier', 'inference_geo'):
        if value.get(key) is not None: text(value[key], 128)
    require(value.get('speed') in (None, 'standard', 'fast'))
    require(value.get('iterations') in (None, []))
    require(value.get('fallback_credit') is None)


def message_header(message, empty=False):
    required = set(MESSAGE_REQUIRED_KEYS)
    optional = set(MESSAGE_OPTIONAL_KEYS)
    require(isinstance(message, dict) and required <= set(message)
            and set(message) <= required | optional)
    text(message['id'], nonempty=True)
    require(message['role'] == 'assistant' and isinstance(message['content'], list))
    if empty: require(message['content'] == [])
    if 'type' in message: require(message['type'] == 'message')
    if 'model' in message: text(message['model'], nonempty=True)
    require(message.get('stop_reason') in (None, *STOP_REASONS))
    if empty: require(message.get('stop_reason') is None)
    if message.get('stop_sequence') is not None: text(message['stop_sequence'])
    for key in ('container', 'context_management', 'stop_details', 'diagnostics', 'resumable'):
        require(message.get(key) is None)
    validate_input_transformations(message.get('input_transformations'))
    if 'usage' in message: usage(message['usage'])


def stream_envelope(frame, native, message):
    required = {'type', 'session_id', 'parent_tool_use_id', 'uuid', 'event'}
    optional = {'api_message_id', 'user_message_uuid', 'user_message_uuids', 'ttft_ms',
                'thinking_display', 'abandoned_blocks'}
    require(required <= set(frame) and set(frame) <= required | optional)
    require(frame['type'] == 'stream_event' and frame['session_id'] == native
            and frame['parent_tool_use_id'] is None and isinstance(frame['event'], dict))
    echo(frame, message)
    event = frame['event']; kind = event.get('type')
    if kind == 'ping':
        exact(frame, tuple(required)); exact(event, ('type',))
        return kind
    text(frame.get('api_message_id'), nonempty=True)
    if 'ttft_ms' in frame:
        require(kind == 'message_start'); number(frame['ttft_ms'], integer=True)
    if 'thinking_display' in frame:
        require(kind == 'message_start'
                or kind == 'content_block_start' and event.get('content_block', {}).get('type') == 'thinking'
                or kind == 'content_block_delta' and event.get('delta', {}).get('type') == 'thinking_delta')
        text(frame['thinking_display'], 128)
    if 'abandoned_blocks' in frame:
        require(kind == 'message_stop')
        item = frame['abandoned_blocks']
        exact(item, ('api_message_id', 'from_block_index'))
        require(item['api_message_id'] == frame['api_message_id'])
        number(item['from_block_index'], integer=True)
        require(item['from_block_index'] <= MAX_BLOCKS)
    return kind


def block(value, start=False):
    require(isinstance(value, dict))
    kind = value.get('type')
    if kind == 'text':
        require({'type', 'text'} <= set(value) and set(value) <= {'type', 'text', 'citations'})
        require(value.get('citations') in (None, []))
        raw = text(value['text'], MAX_TEXT)
        if start: require(not raw)
        return kind, raw
    if kind == 'thinking':
        exact(value, ('type', 'thinking', 'signature'))
        thinking = text(value['thinking'], MAX_TEXT)
        signature = text(value['signature'], MAX_DELTA)
        if start: require(not thinking and not signature)
        return kind, len(thinking) + len(signature)
    require(kind == 'redacted_thinking')
    exact(value, ('type', 'data'))
    return kind, len(text(value['data'], MAX_TEXT))


def assistant_envelope(frame, native, message):
    required = {'type', 'session_id', 'uuid', 'message'}
    optional = {'parent_tool_use_id', 'user_message_uuid', 'user_message_uuids', 'request_id',
                'narration_block_indexes', 'narration_hint', 'thinking_duration_ms', 'timestamp'}
    require(required <= set(frame) and set(frame) <= required | optional)
    require(frame['type'] == 'assistant' and frame['session_id'] == native
            and frame.get('parent_tool_use_id') is None)
    echo(frame, message)
    if 'request_id' in frame: text(frame['request_id'], nonempty=True)
    if 'timestamp' in frame: text(frame['timestamp'], 128)
    if 'thinking_duration_ms' in frame: number(frame['thinking_duration_ms'])
    if 'narration_hint' in frame: require(frame['narration_hint'] in ('hidden', 'faint'))
    if 'narration_block_indexes' in frame: require(frame['narration_block_indexes'] in ([], [0]))
    message_header(frame['message'])
    require(len(frame['message']['content']) == 1)
