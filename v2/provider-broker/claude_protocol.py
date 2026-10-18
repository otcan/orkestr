"""Separate Claude stream channel. Private pipe correlation is not Core proof."""
import secrets
import uuid
from protocol import PROTOCOL, exact, identifier, require


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
        input_uuid = None
        keys = ("type", "session_id", "parent_tool_use_id", "message")
        if "uuid" in frame:
            exact(frame, keys + ("uuid",))
            value = frame["uuid"]
            require(isinstance(value, str) and str(uuid.UUID(value)) == value)
            input_uuid = value
        else:
            exact(frame, keys)
        require(not getattr(self.session, "resumed", False) or input_uuid is not None)
        require(frame["type"] == "user" and frame["session_id"] == self.native
                and frame["parent_tool_use_id"] is None)
        exact(frame["message"], ("role", "content"))
        content = frame["message"]["content"]
        require(frame["message"]["role"] == "user" and isinstance(content, str)
                and 0 < len(content.encode()) <= 32768)
        self.input_uuid = input_uuid
        self.messages.add(message)
        self.active, self.terminal = outer, False
        return frame, None

    def provider(self, frame):
        require(not self.poisoned)
        try:
            return self._provider(frame)
        except Exception:
            self.poisoned = True
            raise

    def _provider(self, frame):
        require(isinstance(frame, dict) and self.handle is not None)
        if frame.get("type") == "control_response":
            require(self.setup is not None and not self.initialized and self.active is None)
            exact(frame, ("type", "response"))
            response = frame["response"]
            exact(response, ("subtype", "request_id", "response"))
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
        if kind in ("assistant", "result") and getattr(self.session, "resumed", False):
            # No relabeling even for unseen historical frames on a fresh reader.
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
            require(identifier(frame.get("subtype")))
            require(isinstance(frame.get("result"), str) and len(frame["result"].encode()) <= 8192)
            require(frame["is_error"] or frame["subtype"] == "success")
            self.terminal_uuid = frame.get("uuid")
            self.terminal = True
            clean = {key: frame[key] for key in ("type", "session_id", "subtype", "is_error", "result")}
        else:
            require(False)  # No tool requests, raw controls or unknown passthrough.
        for key in ("uuid", "user_message_uuid"):
            if key in frame and kind in ("assistant", "result"):
                value = frame[key]
                require(isinstance(value, str) and str(uuid.UUID(value)) == value)
                clean[key] = value
        return {"method": "BrokerOutput", "params": {"owned_handle": self.handle,
                "request_id": self.active, "frame": clean}}
