"""Separate Claude stream channel. Private pipe correlation is not Core proof."""
import secrets
import uuid
from protocol import PROTOCOL, exact, identifier, require
from claude_telemetry import validate_telemetry
from claude_control import ClaudeControl, canonical
from claude_failure import sanitize_failure
from claude_system_telemetry import validate_system_telemetry
from claude_assistant_metadata import contains_thinking, sanitize_assistant
from claude_assistant_input import AssistantInput
from claude_stream import ClaudeTextStream
from claude_stream_schema import MAX_FRAME, MAX_RAW, frame_size


class ClaudeChannel:
    def __init__(self, session):
        self.session = session
        self.native = str(session.native)
        self.poisoned = False
        self.terminal_uuid = None
        self.input_uuid = None
        self.handle = None
        self.seen = set()
        self.messages = set()
        self.initialized = False
        self.setup = None
        self.system_seen = False
        self.active = None
        self.terminal = False
        self.telemetry_uuids = set()
        self.control = None
        self.output_uuids = set()
        self.output_uuid_overflow = False
        self.assistant_input = None
        self.stream = None
        self.wire_bytes = 0

    def client(self, request):
        require(not self.poisoned)
        exact(request, ("id", "method", "params"))
        outer = request["id"]
        require(type(outer) is int and 0 < outer < 2**53 and outer not in self.seen)
        require(len(self.seen) < 256)
        self.seen.add(outer)
        if self.handle is None:
            require(request["method"] == "OpenOwnedSession")
            exact(request["params"], ("protocol", "identity"))
            require(request["params"]["protocol"] == PROTOCOL)
            identity = request["params"]["identity"]
            exact(identity, ("provider", "role", "owner_id", "session_id", "namespace", "incarnation"))
            require(all(identifier(v) for v in identity.values()))
            require(identity["provider"] == "claude" and identity["role"] in ("fast", "deep"))
            self.handle = secrets.token_hex(24)
            return None, {"id": outer, "result": {"protocol": PROTOCOL, "identity": identity,
                "metadata_only": True, "owned_handle": self.handle, "native_session": self.native}}
        if request["method"] == "BrokerMetadata":
            require(self.setup is None and not self.initialized and self.active is None)
            exact(request["params"], ("owned_handle", "frame"))
            require(request["params"]["owned_handle"] == self.handle)
            frame = request["params"]["frame"]
            exact(frame, ("type", "request_id", "request"))
            require(frame["type"] == "control_request" and identifier(frame["request_id"]))
            exact(frame["request"], ("subtype", "hooks"))
            require(frame["request"] == {"subtype": "initialize", "hooks": None})
            self.setup = (outer, frame["request_id"])
            return frame, None
        if request["method"] == "CancelExecution":
            params = request["params"]
            exact(params, ("owned_handle", "frame"))
            require(params["owned_handle"] == self.handle and self.initialized
                    and self.system_seen and self.active is not None and not self.terminal
                    and self.control is None)
            self.control = ClaudeControl(outer, params["frame"], self.native,
                                         self.input_uuid, self.setup[1])
            return params["frame"], None
        require(request["method"] == "CommitExecution")
        params = request["params"]
        exact(params, ("owned_handle", "message_id", "frame"))
        require(params["owned_handle"] == self.handle)
        # UUID identifies a provider frame, not its originating input turn.
        # Until an issued per-turn correlation is available, this channel is single-use.
        require(self.initialized and self.active is None)
        message = params["message_id"]
        require(identifier(message) and message not in self.messages)
        frame = params["frame"]
        exact(frame, ("type", "session_id", "parent_tool_use_id", "message", "uuid"))
        input_uuid = canonical(frame["uuid"])
        require(frame["type"] == "user" and frame["session_id"] == self.native
                and frame["parent_tool_use_id"] is None)
        exact(frame["message"], ("role", "content"))
        content = frame["message"]["content"]
        require(frame["message"]["role"] == "user" and isinstance(content, str)
                and 0 < len(content.encode()) <= 32768)
        self.input_uuid = input_uuid
        self.assistant_input = AssistantInput(self.native, input_uuid)
        self.stream = ClaudeTextStream(self.native, input_uuid)
        self.messages.add(message)
        self.active, self.terminal = outer, False
        return frame, None

    def provider(self, frame, *, raw_size=None):
        require(not self.poisoned)
        try:
            if self.active is not None:
                size = frame_size(frame) + 1 if raw_size is None else raw_size
                require(type(size) is int and 0 < size <= MAX_FRAME + 1
                        and self.wire_bytes + size <= MAX_RAW)
                self.wire_bytes += size
            return self._provider(frame)
        except Exception:
            self.poisoned = True
            raise

    def _provider(self, frame):
        require(isinstance(frame, dict) and self.handle is not None)
        if frame.get("type") == "control_response" and self.control is not None:
            clean = self.control.response(frame)
            return {"method":"BrokerOutput", "params":{"owned_handle":self.handle,
                    "request_id":self.control.outer, "frame":clean}}
        if frame.get("type") == "control_response":
            require(self.setup is not None and not self.initialized and self.active is None)
            exact(frame, ("type", "response"))
            response = frame["response"]
            require(isinstance(response, dict))
            pending = ("pending_permission_requests", "pending_user_dialog_requests")
            require(set(response) <= {"subtype", "request_id", "response", *pending})
            require(all(response[key] == [] for key in pending if key in response))
            require({"subtype", "request_id", "response"} <= set(response))
            require(response["subtype"] == "success" and response["request_id"] == self.setup[1]
                    and isinstance(response["response"], dict))
            self.initialized = True
            # Sanitize capability/account/model payload. Protocol ACK is not auth proof.
            clean = {"type": "control_response", "response": {"subtype": "success",
                     "request_id": self.setup[1]}}
            return {"method": "BrokerOutput", "params": {"owned_handle": self.handle,
                    "request_id": self.setup[0], "frame": clean}}
        require(frame.get("session_id") == self.native)
        require(not any(key in frame for key in ("sessionId", "parent_tool_use_id"))
                or frame.get("parent_tool_use_id") is None and "sessionId" not in frame)
        kind = frame.get("type")
        if kind in ('stream_event', 'assistant', 'result') and self.stream is not None:
            require(frame.get('uuid') not in self.telemetry_uuids
                    and frame.get('uuid') not in self.output_uuids
                    and frame.get('uuid') != self.terminal_uuid
                    and (self.control is None or frame.get('uuid') not in self.control.notice_ids))
            if kind == 'stream_event':
                require(self.initialized and self.system_seen and self.active is not None
                        and not self.terminal)
                if self.control is not None and not self.stream.started and 'api_message_id' not in frame:
                    # Preserve the older bounded cancellation-only notice path.
                    # It emits nothing, anchors nothing, and cannot acknowledge Stop.
                    self.control.notice(frame, self.telemetry_uuids)
                    return None
                require(not self.assistant_input.events and not self.output_uuids
                        and (self.stream.started or self.control is None or not self.control.notice_ids))
                clean = self.stream.receive(frame, cancelled=self.control is not None)
                if clean is None: return None
                return {'method': 'BrokerOutput', 'params': {'owned_handle': self.handle,
                        'request_id': self.active, 'frame': clean}}
            if self.stream.started:
                require(self.initialized and self.system_seen and not self.terminal)
                if kind == 'assistant':
                    return self.stream.observe_assistant(frame, cancelled=self.control is not None)
                frame = self.stream.finish(frame, cancelled=self.control is not None)
            else:
                require(frame.get('uuid') not in self.stream.events)
        if kind == "system" and frame.get("subtype") in ("thinking_tokens", "status"):
            require(self.initialized and self.system_seen and self.active is not None
                    and not self.output_uuid_overflow)
            event = validate_system_telemetry(frame, self.native, self.input_uuid)
            require(event != self.terminal_uuid and event not in self.telemetry_uuids
                    and event not in self.output_uuids
                    and (self.stream is None or event not in self.stream.events)
                    and (self.control is None or event not in self.control.notice_ids)
                    and len(self.telemetry_uuids) < 128)
            self.telemetry_uuids.add(event)
            # No readiness, progress, result, control ACK or terminal is emitted.
            return None
        if kind in ("command_lifecycle", "rate_limit_event"):
            validate_telemetry(frame, self.input_uuid)
            require(self.initialized and self.active is not None)
            value = frame["uuid"]
            require(isinstance(value, str) and str(uuid.UUID(value)) == value)
            require(value not in (self.native,self.input_uuid,self.terminal_uuid)
                    and (self.control is None or value not in self.control.notice_ids)
                    and (self.stream is None or value not in self.stream.events)
                    and value not in self.telemetry_uuids and len(self.telemetry_uuids) < 128)
            self.telemetry_uuids.add(value)
            # Even post-terminal telemetry cannot advance readiness or execution state.
            return None
        thinking = kind == "assistant" and contains_thinking(frame)
        prepared = None
        if kind == "assistant" and (self.control is None or thinking
                or isinstance(frame.get("message"), dict) and "id" in frame["message"]):
            require(self.assistant_input is not None)
            frame, prepared = self.assistant_input.prepare(frame)
        if thinking or prepared is not None:
            require(self.initialized and self.system_seen and self.active is not None
                    and not self.terminal and not self.output_uuid_overflow)
            frame = sanitize_assistant(frame, self.native, self.input_uuid)
            event = frame["uuid"]
            require(event not in self.telemetry_uuids and event not in self.output_uuids
                    and event != self.terminal_uuid and len(self.telemetry_uuids) < 128)
            if self.control is not None:
                # Existing cancellation fences discard even the genuine text.
                self.control.notice(frame, self.telemetry_uuids)
            if prepared is not None:
                self.assistant_input.commit(prepared)
            if thinking:
                self.telemetry_uuids.add(event)
            if self.control is not None or not frame["message"]["content"]:
                return None
        if self.control is not None and kind in ("user", "assistant", "stream_event"):
            self.control.notice(frame, self.telemetry_uuids)
            return None
        if kind == "result" and self.assistant_input is not None:
            require(frame.get("uuid") not in self.assistant_input.events)
        if self.control is not None and kind == "result":
            clean = self.control.result(frame, self.telemetry_uuids)
            self.terminal_uuid = clean["uuid"]
            self.terminal = True
            return {"method":"BrokerOutput", "params":{"owned_handle":self.handle,
                    "request_id":self.active, "frame":clean}}
        if kind in ("assistant", "result"):
            # Results stay explicitly correlated. Assistant omissions reach
            # here only after the owned input/response anchor validates them.
            require(self.input_uuid is not None
                    and frame.get("user_message_uuid") == self.input_uuid)
            if "user_message_uuids" in frame:
                require(frame["user_message_uuids"] == [self.input_uuid])
        if kind == "system":
            require(frame.get("subtype") == "init" and self.initialized and not self.system_seen)
            self.system_seen = True
            clean = {"type": "system", "subtype": "init", "session_id": self.native}
        elif kind == "assistant":
            require(self.initialized and self.active is not None and not self.terminal)
            message = frame.get("message")
            require(isinstance(message, dict) and message.get("role") == "assistant")
            content = message.get("content")
            require(isinstance(content, list) and 0 < len(content) <= 128)
            blocks = []
            for block in content:
                exact(block, ("type", "text"))
                require(block["type"] == "text" and isinstance(block["text"], str)
                        and len(block["text"].encode()) <= 8192)
                blocks.append(block)
            clean = {"type": kind, "session_id": self.native,
                     "message": {"role": kind, "content": blocks}}
        elif kind == "result":
            require(self.active is not None and not self.terminal)
            require(type(frame.get("is_error")) is bool)
            if frame['is_error']:
                require(not self.output_uuid_overflow)
                clean = sanitize_failure(frame, self.native, self.input_uuid,
                                         self.telemetry_uuids | self.output_uuids)
                self.terminal_uuid, self.terminal = clean['uuid'], True
                return {"method": "BrokerOutput", "params": {"owned_handle": self.handle,
                        "request_id": self.active, "frame": clean}}
            require(identifier(frame.get("subtype")))
            require(isinstance(frame.get("result"), str) and len(frame["result"].encode()) <= 8192)
            require(frame["is_error"] or frame["subtype"] == "success")
            value = canonical(frame.get("uuid"))
            require(value not in (self.native,self.input_uuid) and value not in self.telemetry_uuids)
            self.terminal_uuid = value
            self.terminal = True
            clean = {key: frame[key] for key in ("type", "session_id", "subtype", "is_error", "result")}
        else:
            require(False)  # No tool requests, raw controls or unknown passthrough.
        for key in ("uuid", "user_message_uuid"):
            if key in frame and kind in ("assistant", "result"):
                value = frame[key]
                require(isinstance(value, str) and str(uuid.UUID(value)) == value)
                clean[key] = value
                if key == 'uuid' and kind == 'assistant':
                    # Preserve normal output behavior. If this bounded history
                    # fills, refuse only the new terminal-error acceptance path.
                    if len(self.output_uuids) < 128 or value in self.output_uuids:
                        self.output_uuids.add(value)
                    else:
                        self.output_uuid_overflow = True
        return {"method": "BrokerOutput", "params": {"owned_handle": self.handle,
                "request_id": self.active, "frame": clean}}
