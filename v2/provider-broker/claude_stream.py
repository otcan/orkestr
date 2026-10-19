"""One current input/one API message; partial text has no terminal authority."""
import hashlib
import uuid

from claude_assistant_input import AssistantInput
from claude_control import canonical, correlated
from claude_context_management import validate_context_management
from claude_input_transformations import validate_input_transformations
from claude_stream_schema import (MAX_BLOCKS, MAX_DELTA, MAX_EVENTS, MAX_RAW, MAX_TEXT,
    MAX_THINKING, STOP_REASONS, assistant_envelope, block, echo, event_id, frame_size,
    message_header, number, stream_envelope, text, usage)
from protocol import exact, require


class ClaudeTextStream:
    def __init__(self, native, message):
        self.native, self.message = canonical(native), canonical(message)
        require(uuid.UUID(native).int != 0 and uuid.UUID(message).int != 0 and native != message)
        self.assistants = AssistantInput(native, message)
        self.state = 'waiting'
        self.api = self.model = None
        self.events, self.raw_bytes = set(), 0
        self.blocks, self.active, self.full = [], None, 0
        self.text_bytes = self.thinking_bytes = 0
        self.poisoned = False

    @property
    def started(self):
        return self.api is not None

    def _record(self, frame):
        require(not self.poisoned and self.state != 'terminal')
        value = event_id(frame.get('uuid'), self.native, self.message)
        size = frame_size(frame)
        require(value not in self.events and len(self.events) < MAX_EVENTS
                and self.raw_bytes + size <= MAX_RAW)
        self.events.add(value); self.raw_bytes += size

    def receive(self, frame, cancelled=False):
        try:
            return self._receive(frame, cancelled)
        except Exception:
            self.poisoned = True
            raise

    def _receive(self, frame, cancelled):
        self._record(frame)
        kind = stream_envelope(frame, self.native, self.message)
        if kind == 'ping': return None
        event = frame['event']
        if kind == 'message_start':
            require(self.state == 'waiting')
            echo(frame, self.message, required=True)
            exact(event, ('type', 'message')); message_header(event['message'], empty=True)
            require(event['message']['id'] == frame['api_message_id'])
            self.api, self.model = frame['api_message_id'], event['message'].get('model')
            self.state = 'message'
            return None
        require(self.state in ('message', 'ending') and frame['api_message_id'] == self.api)
        if kind == 'content_block_start':
            exact(event, ('type', 'index', 'content_block'))
            require(self.state == 'message' and self.active is None
                    and type(event['index']) is int and event['index'] == len(self.blocks)
                    and len(self.blocks) < MAX_BLOCKS)
            block_kind, value = block(event['content_block'], start=True)
            if block_kind != 'text': self._discard(value)
            self.active = len(self.blocks)
            self.blocks.append({'kind': block_kind, 'bytes': 0, 'hash': hashlib.sha256(),
                                'closed': False, 'verified': False})
        elif kind == 'content_block_delta':
            exact(event, ('type', 'index', 'delta'))
            current = self._active(event['index'])
            require(not current['verified'])
            delta = event['delta']; require(isinstance(delta, dict))
            if current['kind'] == 'text':
                exact(delta, ('type', 'text')); require(delta['type'] == 'text_delta')
                value = text(delta['text'], MAX_DELTA)
                require(self.text_bytes + len(value) <= MAX_TEXT)
                self.text_bytes += len(value); current['bytes'] += len(value)
                current['hash'].update(value)
                if value and not cancelled:
                    return {'type': 'assistant', 'session_id': self.native,
                            'uuid': frame['uuid'], 'user_message_uuid': self.message,
                            'message': {'role': 'assistant', 'content': [
                                {'type': 'text', 'text': delta['text']}]}}
            else:
                require(current['kind'] == 'thinking')
                if delta.get('type') == 'thinking_delta':
                    require({'type'} < set(delta) <= {'type', 'thinking', 'estimated_tokens'})
                    if 'thinking' in delta: self._discard(len(text(delta['thinking'], MAX_DELTA)))
                    if 'estimated_tokens' in delta:
                        if delta['estimated_tokens'] is None:
                            # Native/API thinking deltas use null when no display
                            # estimate is due. It supplies no execution evidence.
                            require('thinking' in delta)
                        else:
                            number(delta['estimated_tokens'], integer=True)
                else:
                    exact(delta, ('type', 'signature')); require(delta['type'] == 'signature_delta')
                    self._discard(len(text(delta['signature'], MAX_DELTA)))
        elif kind == 'content_block_stop':
            exact(event, ('type', 'index'))
            self._active(event['index'])['closed'] = True
            self.active = None
        elif kind == 'message_delta':
            require(self.state == 'message' and self.active is None)
            require({'type', 'delta', 'usage'} <= set(event)
                    and set(event) <= {'type', 'delta', 'usage', 'context_management',
                                      'input_transformations'})
            validate_context_management(event.get('context_management'))
            validate_input_transformations(event.get('input_transformations'))
            delta = event['delta']; require(isinstance(delta, dict)
                and {'stop_reason'} <= set(delta)
                and set(delta) <= {'stop_reason', 'stop_sequence', 'stop_details', 'container'})
            require(delta.get('stop_details') is None and delta.get('container') is None)
            if delta['stop_reason'] is None:
                # Native closes an interrupted partial stream before its result.
                # This is discard-only framing, never an ACK or terminal receipt.
                require(cancelled is True and delta.get('stop_sequence') is None)
            else:
                require(delta['stop_reason'] in STOP_REASONS)
            if delta.get('stop_sequence') is not None: text(delta['stop_sequence'])
            usage(event['usage']); self.state = 'ending'
        else:
            require(kind == 'message_stop' and self.active is None)
            exact(event, ('type',))
            require(self.state == 'ending' or cancelled)
            require('abandoned_blocks' not in frame or cancelled)
            self.state = 'stopped'
        return None

    def _active(self, index):
        require(self.state == 'message' and type(index) is int and self.active is not None
                and index == self.active)
        return self.blocks[index]

    def _discard(self, count):
        require(self.thinking_bytes + count <= MAX_THINKING)
        self.thinking_bytes += count  # Never retain thinking/signature/redacted bytes or hashes.

    def observe_assistant(self, frame, *, cancelled=False):
        try:
            self._record(frame)
            # Native emits the complete assistant immediately before that
            # block's stop. A delayed full block cannot validate old output.
            require(self.state == 'message' and self.active == self.full
                    and self.full < len(self.blocks))
            assistant_envelope(frame, self.native, self.message, cancelled=cancelled)
            require(frame['message']['id'] == self.api
                    and frame['message'].get('model') == self.model)
            _, prepared = self.assistants.prepare(frame)
            require(prepared is not None)
            current = self.blocks[self.full]
            kind, value = block(frame['message']['content'][0])
            require(kind == current['kind'] and not current['verified'])
            if kind == 'text':
                require(len(value) == current['bytes']
                        and hashlib.sha256(value).digest() == current['hash'].digest())
            else:
                self._discard(value)
            self.assistants.commit(prepared)
            current['verified'] = True; self.full += 1
            return None
        except Exception:
            self.poisoned = True
            raise

    def finish(self, frame, cancelled=False):
        try:
            self._record(frame)
            correlated(frame, self.native, self.message)
            require(frame.get('type') == 'result' and type(frame.get('is_error')) is bool)
            if not cancelled and not frame['is_error']:
                require(self.state == 'stopped' and self.blocks
                        and self.full == len(self.blocks) and all(b['closed'] for b in self.blocks))
                last = self.blocks[-1]; value = text(frame.get('result'), MAX_TEXT)
                require(last['kind'] == 'text' and len(value) == last['bytes']
                        and hashlib.sha256(value).digest() == last['hash'].digest())
                # Native's success result repeats its last assistant text block.
                # Progress already carried every byte. Do not widen Rust strings.
                frame = dict(frame, result='')
            self.state = 'terminal'
            return frame
        except Exception:
            self.poisoned = True
            raise
