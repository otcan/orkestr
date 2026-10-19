"""Discard closed thinking metadata only; return validated genuine text or none."""
import json
import math
import uuid

from claude_control import canonical, correlated
from protocol import exact, require


def contains_thinking(frame):
    message = frame.get('message')
    blocks = message.get('content') if isinstance(message, dict) else None
    return isinstance(blocks, list) and any(isinstance(block, dict) and
        block.get('type') in ('thinking', 'redacted_thinking') for block in blocks)


def bounded(value, maximum=512):
    require(isinstance(value, str) and len(value.encode()) <= maximum)


def sanitize_assistant(frame, native, message):
    required = {'type', 'session_id', 'user_message_uuid', 'uuid', 'message'}
    optional = {'parent_tool_use_id', 'user_message_uuids', 'request_id',
                'narration_block_indexes', 'narration_hint', 'thinking_duration_ms'}
    require(required <= set(frame) and set(frame) <= required | optional)
    require(frame['type'] == 'assistant' and frame.get('parent_tool_use_id') is None)
    correlated(frame, native, message)
    event = canonical(frame['uuid'])
    require(all(uuid.UUID(canonical(value)).int != 0 for value in (native, message, event)))
    require(event not in (native, message))
    require(len(json.dumps(frame, allow_nan=False).encode()) <= 16384)
    if 'request_id' in frame: bounded(frame['request_id'])
    if 'narration_hint' in frame: require(frame['narration_hint'] in ('hidden', 'faint'))
    if 'thinking_duration_ms' in frame:
        value = frame['thinking_duration_ms']
        require(type(value) in (int, float) and math.isfinite(value) and 0 <= value < 2**53)
    envelope = frame['message']
    require(isinstance(envelope, dict) and {'role', 'content'} <= set(envelope)
            and set(envelope) <= {'role', 'content', 'id', 'type', 'model', 'stop_reason',
                'stop_sequence', 'usage', 'container', 'context_management', 'stop_details', 'diagnostics'})
    require(envelope['role'] == 'assistant')
    for key in ('id', 'model'):
        if key in envelope: bounded(envelope[key])
    if 'type' in envelope: require(envelope['type'] == 'message')
    if 'stop_reason' in envelope:
        require(envelope['stop_reason'] in (None, 'end_turn', 'max_tokens', 'stop_sequence', 'refusal'))
    if envelope.get('stop_sequence') is not None: bounded(envelope['stop_sequence'])
    for key in ('container', 'context_management', 'stop_details', 'diagnostics'):
        require(envelope.get(key) is None)
    if 'usage' in envelope: require(isinstance(envelope['usage'], dict))
    blocks = envelope['content']
    require(isinstance(blocks, list) and 0 < len(blocks) <= 128)
    text, thought_indexes = [], []
    text_bytes = metadata_bytes = 0
    for index, block in enumerate(blocks):
        require(isinstance(block, dict))
        kind = block.get('type')
        if kind == 'text':
            require({'type', 'text'} <= set(block) and set(block) <= {'type', 'text', 'citations'})
            require(block.get('citations') in (None, []))
            bounded(block['text'], 8192)
            text_bytes += len(block['text'].encode())
            text.append({'type': 'text', 'text': block['text']})
        else:
            fields = ('type', 'thinking', 'signature') if kind == 'thinking' else ('type', 'data')
            require(kind in ('thinking', 'redacted_thinking'))
            exact(block, fields)
            for key in fields[1:]:
                bounded(block[key], 8192)
                metadata_bytes += len(block[key].encode())
            if kind == 'thinking': thought_indexes.append(index)
    require(text_bytes <= 8192 and metadata_bytes <= 8192)
    if 'narration_block_indexes' in frame:
        indexes = frame['narration_block_indexes']
        require(isinstance(indexes, list) and len(indexes) <= 128
                and all(type(index) is int and index in thought_indexes for index in indexes)
                and indexes == sorted(set(indexes)))
    # Build the output only after the complete envelope and every block validate.
    # Thinking text/signature/data are neither retained nor emitted.
    return {'type': 'assistant', 'session_id': native, 'user_message_uuid': message,
            'uuid': event, 'message': {'role': 'assistant', 'content': text}}
