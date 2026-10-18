"""Separate Claude stream channel. Private pipe correlation is not Core proof."""
import secrets
from protocol import PROTOCOL, exact, identifier, require


class ClaudeChannel:
    def __init__(self, session):
        self.native = str(session.native)
        self.handle = None
        self.seen = set()
        self.messages = set()
        self.initialized = False
        self.active = None
        self.terminal = False

    def client(self, request):
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
        exact(frame, ("type", "session_id", "parent_tool_use_id", "message"))
        require(frame["type"] == "user" and frame["session_id"] == self.native
                and frame["parent_tool_use_id"] is None)
        exact(frame["message"], ("role", "content"))
        content = frame["message"]["content"]
        require(frame["message"]["role"] == "user" and isinstance(content, str)
                and 0 < len(content.encode()) <= 32768)
        self.messages.add(message)
        self.active, self.terminal = outer, False
        return frame, None

    def provider(self, frame):
        require(isinstance(frame, dict) and self.handle is not None)
        require(frame.get("session_id") == self.native)
        require(not any(key in frame for key in ("sessionId", "parent_tool_use_id"))
                or frame.get("parent_tool_use_id") is None and "sessionId" not in frame)
        kind = frame.get("type")
        if kind == "system":
            require(frame.get("subtype") == "init" and not self.initialized and self.active is None)
            self.initialized = True
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
            self.terminal = True
            clean = {key: frame[key] for key in ("type", "session_id", "subtype", "is_error", "result")}
        else:
            require(False)  # No tool requests, raw controls or unknown passthrough.
        return {"method": "BrokerOutput", "params": {"owned_handle": self.handle,
                "request_id": self.active, "frame": clean}}
