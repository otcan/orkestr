"""Separate Claude stream channel. Private pipe correlation is not Core proof."""
import json
import secrets
import uuid
from protocol import PROTOCOL, Refused, exact, identifier, require
from claude_telemetry import validate_telemetry
from claude_quota import project
from claude_control import ClaudeControl, canonical, text_blocks
from claude_policy import refusal, reported_model


# Full-access tool traffic that never becomes Orkestr progress.
TOOL_NOTICES = ("user", "tool_progress", "tool_use_summary", "prompt_suggestion")

PROVIDER_ERRORS = ("authentication_failed", "billing_error", "rate_limit", "invalid_request",
                   "server_error", "max_output_tokens", "unknown")


def provider_error(value):
    require(isinstance(value, str) and 0 < len(value) <= 64)
    return value if value in PROVIDER_ERRORS else "unknown"


class ClaudeChannel:
    def __init__(self, session, catalog_warning=None, quota_observer=None):
        require(catalog_warning is None or callable(catalog_warning))
        self.session = session
        self.quota_observer = quota_observer
        self.owner_id = None
        self.catalog_warning = catalog_warning
        self.catalog_warned = False
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
        self.resolved_model = None
        self.current_model = None
        self.policy_refused = False
        # Set once the active input's first assistant frame carries its exact
        # user_message_uuid. The installed CLI omits the key on later blocks
        # and on API messages after a tool result within the same turn.
        self.joined = False
        # Operator full-access session: tools run natively; their frames drain.
        self.tools = getattr(session, "uncontained", False) is True
        self.tool_frames = 0
        self.keepalives = 0
        self.system_notices = 0

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
            if identity["role"] == "fast":
                # Before launch: the native process starts after this request.
                # A session that cannot become read-only never serves Fast.
                restrict = getattr(self.session, "restrict_to_read_only", None)
                require(callable(restrict))
                restrict()
            self.owner_id = identity['owner_id']
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
                                         self.input_uuid, self.setup[1], self.tools)
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
        kind = frame.get("type")
        if kind == "keep_alive":
            # Transport liveness during long native work; never readiness.
            require(set(frame) <= {"type", "uuid", "session_id"} and self.keepalives < 65536)
            self.keepalives += 1
            return None
        require(frame.get("session_id", self.native if kind in TOOL_NOTICES else None) == self.native)
        if self.policy_refused:
            return None
        refused = refusal(self, frame)
        if refused is not None:
            return refused
        if self.tools and self.control is None and (kind in TOOL_NOTICES or (
                kind == "assistant" and frame.get("parent_tool_use_id") is not None)):
            # Tool results, tool progress and subagent turns of THIS joined
            # turn: bounded discard.
            require(self.joined and self.active is not None and not self.terminal
                    and self.tool_frames < 65536 and "sessionId" not in frame
                    and len(json.dumps(frame, allow_nan=False).encode()) <= 4 * 1024 * 1024)
            self.tool_frames += 1
            return None
        require("sessionId" not in frame)
        require(self.tools and self.control is not None
                or frame.get("parent_tool_use_id") is None)
        if kind == "system" and frame.get("subtype") != "init":
            # UI/retry/status notices: bounded discard, never readiness or output.
            limit = 16384
            if self.tools and frame.get("subtype") == "commands_changed":
                # A full-access CLI's installed command descriptions can exceed
                # 16 KiB before its first turn. This closed notice is metadata
                # only: retain the native frame bound, discard all descriptions.
                exact(frame, ("type", "subtype", "session_id", "uuid", "commands"))
                canonical(frame["uuid"])
                require(isinstance(frame["commands"], list) and len(frame["commands"]) <= 4096
                        and all(isinstance(command, dict) for command in frame["commands"]))
                limit = 4 * 1024 * 1024
            size = len(json.dumps(frame, allow_nan=False).encode())
            require(identifier(frame.get("subtype")) and len(frame["subtype"]) <= 64
                    and self.system_notices < 256
                    and size <= limit)
            self.system_notices += 1
            if limit > 16384 and size > 16384 and not self.catalog_warned:
                self.catalog_warned = True
                if self.catalog_warning is not None:
                    self.catalog_warning(size)  # Trusted callback receives only the byte count.
            return None
        if kind in ("command_lifecycle", "rate_limit_event"):
            validate_telemetry(frame, self.input_uuid)
            require(self.initialized and self.active is not None)
            value = frame["uuid"]
            require(isinstance(value, str) and str(uuid.UUID(value)) == value)
            require(value not in (self.native,self.input_uuid,self.terminal_uuid)
                    and (self.control is None or value not in self.control.notice_ids)
                    and value not in self.telemetry_uuids and len(self.telemetry_uuids) < 128)
            self.telemetry_uuids.add(value)
            if kind == 'rate_limit_event' and self.quota_observer is not None:
                try:
                    windows = project(frame['rate_limit_info'])
                    if windows:
                        self.quota_observer(self.owner_id, windows)
                except Refused:
                    raise  # Preserve stop/control signals delivered during metadata I/O.
                except Exception:
                    pass  # Quota metadata cannot fail, renew or complete a turn.
            # Even post-terminal telemetry cannot advance readiness or execution state.
            return None
        if self.control is not None and kind in ("user", "assistant", "stream_event", *TOOL_NOTICES):
            self.control.notice(frame, self.telemetry_uuids)
            return None
        if self.control is not None and kind == "result":
            clean = self.control.result(frame, self.telemetry_uuids)
            self.terminal_uuid = clean["uuid"]
            self.terminal = True
            return {"method":"BrokerOutput", "params":{"owned_handle":self.handle,
                    "request_id":self.active, "frame":clean}}
        if kind in ("assistant", "result"):
            # A fresh reader never relabels historical frames: an uncorrelated
            # assistant frame is accepted only after this turn's own explicitly
            # correlated frame. One channel carries exactly one native input.
            require(self.input_uuid is not None)
            if kind == "assistant" and "user_message_uuid" not in frame \
                    and "user_message_uuids" not in frame:
                require(self.joined)
            else:
                require(frame.get("user_message_uuid") == self.input_uuid)
                if "user_message_uuids" in frame:
                    require(frame["user_message_uuids"] == [self.input_uuid])
        if kind == "system":
            require(frame.get("subtype") == "init" and self.initialized and not self.system_seen)
            self.system_seen = True
            clean = {"type": "system", "subtype": "init", "session_id": self.native}
            self.resolved_model = reported_model(frame.get("model"))
            self.current_model = self.resolved_model
            if self.resolved_model is not None:
                clean["model"] = self.resolved_model
        elif kind == "assistant":
            require(self.initialized and self.active is not None and not self.terminal)
            message = frame.get("message")
            require(isinstance(message, dict) and message.get("role") == "assistant")
            content = message.get("content")
            require(isinstance(content, list) and 0 < len(content) <= 128)
            self.joined = True
            blocks = text_blocks(content, self.tools)
            if not blocks and "error" not in frame:
                # Reasoning-only blocks are never forwarded or persisted.
                return None
            clean = {"type": kind, "session_id": self.native,
                     "message": {"role": kind, "content": blocks}}
            model = reported_model(message.get("model"))
            if model is not None:
                self.current_model = model
                clean["message"]["model"] = model
            if "error" in frame:
                # Closed native failure class (auth, quota, billing...); Runtime
                # records Failed and never retries on another account/provider.
                clean["error"] = provider_error(frame["error"])
        elif kind == "result":
            require(self.active is not None and not self.terminal)
            require(type(frame.get("is_error")) is bool)
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
        if kind == "assistant":
            # Joined above by explicit input UUID or this turn's prior join.
            clean["user_message_uuid"] = self.input_uuid
        return {"method": "BrokerOutput", "params": {"owned_handle": self.handle,
                "request_id": self.active, "frame": clean}}
