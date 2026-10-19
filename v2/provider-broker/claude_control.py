"""Closed no-tools interrupt observations; private JSON is not Core authority."""
import datetime
import json
import re
import uuid
from protocol import exact, require
from claude_stop_metadata import without_stop_metadata


def canonical(value):
    require(isinstance(value, str))
    try:
        require(str(uuid.UUID(value)) == value)
    except ValueError:
        require(False)
    return value


def correlated(frame, native, message):
    require(frame.get('session_id') == native and frame.get('user_message_uuid') == message)
    if 'user_message_uuids' in frame:
        require(frame['user_message_uuids'] == [message])


def notice_timestamp(value):
    # The native interrupted-user marker carries Date.toISOString() display
    # metadata. Its clock does not order events or grant lifecycle authority.
    require(isinstance(value, str) and len(value) == 24 and re.fullmatch(
        r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z', value))
    try:
        datetime.datetime.fromisoformat(value[:-1])
    except ValueError:
        require(False)


class ClaudeControl:
    def __init__(self, outer, frame, native, message, setup_id):
        exact(frame, ('type', 'request_id', 'request'))
        require(frame['type'] == 'control_request')
        key = frame['request_id']
        require(isinstance(key, str) and 0 < len(key.encode()) <= 128
                and not any(ord(c) < 32 or ord(c) == 127 for c in key) and key != setup_id)
        exact(frame['request'], ('subtype', 'cancel_queued', 'for_user_message_uuids'))
        require(frame['request']['subtype'] == 'interrupt'
                and frame['request']['cancel_queued'] is False
                and frame['request']['for_user_message_uuids'] == [canonical(message)])
        self.outer, self.key, self.native, self.message = outer, key, native, message
        self.ack = False
        self.terminal = None
        self.notices = 0
        self.notice_ids = set()

    def response(self, frame):
        require(not self.ack)
        exact(frame, ('type', 'response'))
        require(frame['type'] == 'control_response')
        response = frame['response']
        require(isinstance(response, dict))
        pending = ('pending_permission_requests', 'pending_user_dialog_requests')
        require(set(response) <= {'subtype', 'request_id', 'response', *pending})
        require(all(response[k] == [] for k in pending if k in response))
        require(response.get('subtype') == 'success' and response.get('request_id') == self.key)
        payload = response.get('response')
        require(isinstance(payload, dict) and {'turn'} <= set(payload)
                and set(payload) <= {'turn', 'still_queued'})
        # Native interrupt receipts include the surviving queue. This channel
        # submits one input only; any survivor is outside that owned lifetime.
        require('still_queued' not in payload or payload['still_queued'] == [])
        require(payload['turn'] == 'stopped')
        self.ack = True
        return {'type':'control_response', 'response':{'subtype':'success',
                'request_id':self.key, 'response':{'turn':'stopped'}}}

    def result(self, frame, telemetry):
        require(self.terminal is None)
        frame = without_stop_metadata(frame)
        correlated(frame, self.native, self.message)
        value = canonical(frame.get('uuid'))
        require(value not in (self.native, self.message) and value not in telemetry
                and value not in self.notice_ids)
        required = {'type','uuid','session_id','user_message_uuid','subtype','is_error','terminal_reason'}
        optional = {'user_message_uuids','result','errors','duration_ms','duration_api_ms',
                    'num_turns','total_cost_usd','usage','modelUsage','permission_denials',
                    'stop_reason','fast_mode_state'}
        require(required <= set(frame) and set(frame) <= required | optional)
        require(len(json.dumps(frame, allow_nan=False).encode()) <= 16384)
        if 'result' in frame:require(isinstance(frame['result'], str) and len(frame['result'].encode()) <= 8192)
        if 'errors' in frame:
            require(isinstance(frame['errors'], list) and len(frame['errors']) <= 128
                    and all(isinstance(v,str) and len(v.encode()) <= 8192 for v in frame['errors']))
        for key in ('duration_ms','duration_api_ms','num_turns','total_cost_usd'):
            if key in frame:require(type(frame[key]) in (int,float) and frame[key] >= 0)
        for key in ('usage','modelUsage'):
            if key in frame:require(isinstance(frame[key],dict))
        if 'permission_denials' in frame:require(frame['permission_denials'] == [])
        for key in ('stop_reason','fast_mode_state'):
            if key in frame:require(frame[key] is None or isinstance(frame[key],str) and len(frame[key]) <= 128)
        require(frame.get('subtype') == 'error_during_execution'
                and frame.get('is_error') is True
                and frame.get('terminal_reason') == 'aborted_streaming')
        # Raw errors, usage, model/account metadata and result text never escape.
        self.terminal = value
        return {'type':'result', 'session_id':self.native, 'uuid':value,
                'user_message_uuid':self.message, 'subtype':'error_during_execution',
                'is_error':True, 'terminal_reason':'aborted_streaming'}

    def notice(self, frame, telemetry):
        # Bounded discard only. No control/tool/system passthrough or authority.
        require(self.terminal is None and self.notices < 128)
        kind = frame.get('type')
        require(kind in ('user', 'assistant', 'stream_event'))
        require(frame.get('session_id') == self.native)
        if 'user_message_uuid' in frame:
            correlated(frame, self.native, self.message)
        if 'user_message_uuids' in frame:require(frame['user_message_uuids'] == [self.message])
        for key in ('isSynthetic','isReplay'):
            if key in frame:require(type(frame[key]) is bool)
        require(len(json.dumps(frame, allow_nan=False).encode()) <= 16384)
        if kind in ('user', 'assistant'):
            optional = set()
            if kind == 'user' and 'timestamp' in frame:
                notice_timestamp(frame['timestamp'])
                optional.add('timestamp')
            require(set(frame) <= {'type','session_id','uuid','user_message_uuid',
                'user_message_uuids','parent_tool_use_id','message','isSynthetic','isReplay'} | optional)
            require(frame.get('parent_tool_use_id') is None)
            canonical(frame.get('uuid'))
            message = frame.get('message')
            require(isinstance(message, dict) and {'role','content'} <= set(message)
                    and set(message) <= {'role','content','id','type','model','stop_reason',
                        'stop_sequence','usage','context_management','container'})
            require(message['role'] == kind)
            content = message['content']
            if isinstance(content, str):
                require(len(content.encode()) <= 8192)
            else:
                require(isinstance(content, list) and len(content) <= 128)
                for block in content:
                    exact(block, ('type','text'))
                    require(block['type'] == 'text' and isinstance(block['text'], str)
                            and len(block['text'].encode()) <= 8192)
        else:
            exact(frame, ('type','session_id','uuid','event','parent_tool_use_id'))
            canonical(frame['uuid'])
            require(frame['parent_tool_use_id'] is None)
            event = frame['event']
            require(isinstance(event, dict))
            # Only text deltas and structural stops; no tool/input JSON deltas.
            if event.get('type') == 'content_block_delta':
                exact(event, ('type','index','delta'))
                require(type(event['index']) is int and 0 <= event['index'] < 128)
                exact(event['delta'], ('type','text'))
                require(event['delta']['type'] == 'text_delta'
                        and isinstance(event['delta']['text'], str)
                        and len(event['delta']['text'].encode()) <= 8192)
            else:
                require(event.get('type') in ('content_block_stop','message_stop'))
                exact(event, ('type','index') if event['type']=='content_block_stop' else ('type',))
                if 'index' in event:require(type(event['index']) is int and 0 <= event['index'] < 128)
        value = canonical(frame['uuid'])
        require(value not in (self.native,self.message) and value not in self.notice_ids
                and value not in telemetry)
        self.notice_ids.add(value)
        self.notices += 1
