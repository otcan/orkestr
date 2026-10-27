"""Closed Codex-only owned-session protocol. Wire identity is NOT Core authority."""
import json
import math
import secrets
import uuid
from enum import IntEnum

PROTOCOL = "orkestr-v2-provider-broker-v1"
MAX_FRAME = 65536


class Failure(IntEnum):
    """Closed diagnostic identifiers; never constructed from provider strings."""
    FRAME_DECODE = 1
    FRAME_BOUND = 2
    FRAME_TRUNCATED = 3
    PROVIDER_EOF = 4
    PROVIDER_READ_IO = 5
    PARENT_INPUT = 6
    TRANSPORT_IO = 7
    PROTOCOL = 8
    LATE_TURN_STARTED = 9
    LATE_TURN_COMPLETED = 10
    LATE_AGENT_DELTA = 11
    BEFORE_COMMIT = 12
    FOREIGN_THREAD = 13
    RETIRED_TURN = 14
    TURN_MISMATCH = 15
    UNEXPECTED_RESPONSE = 16
    RESPONSE_CORRELATION = 17
    TURN_SCHEMA = 18
    SIGNAL = 19
    LAUNCH = 20
    INTERNAL = 21
    UNSUPPORTED_TOOL = 22
    PROVIDER_OUTER = 23


class Refused(Exception):
    def __init__(self, message="", failure=Failure.PROTOCOL):
        super().__init__(message)
        self.failure = failure if type(failure) is Failure else Failure.INTERNAL


CODEX_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")


def launch_model(value):
    """A model Runtime may request (thread/start or turn/start): the same rule
    as Core's launch_model_valid; never a provider name, path or number."""
    return (isinstance(value, str) and 0 < len(value) <= 120 and not value.isdigit()
            and all(c.isascii() and (c.isalnum() or c in "._:-") for c in value)
            and value.lower() not in ("openai", "azure", "openrouter"))


# Item types that are model output, never an action. Any other item (command,
# file change, MCP/dynamic tool call, web search, image view, sub-agent...) is
# a possible side effect, and so is every notification not listed below.
# (Codex 0.163 app-server notification names.)
BENIGN_ITEMS = ("agentMessage", "reasoning", "userMessage", "contextCompaction", "plan")
BENIGN_METHODS = ("turn/started", "turn/completed", "turn/plan/updated", "turn/moderationMetadata",
                  "item/agentMessage/delta", "item/plan/delta", "model/rerouted", "model/verification",
                  "model/safetyBuffering/updated", "thread/started", "thread/settings/updated",
                  "thread/tokenUsage/updated", "thread/status/changed", "thread/readState/changed",
                  "thread/name/updated", "account/updated", "account/rateLimits/updated",
                  "modelProvider/authRecoveryStarted", "modelProvider/authRecoveryCompleted",
                  "mcpServer/startupStatus/updated", "remoteControl/status/changed",
                  "warning", "guardianWarning", "deprecationNotice", "configWarning", "error")
CAPACITY_INFO = ("serverOverloaded", "server_overloaded")
CAPACITY_TEXT = ("selected model is at capacity", "model is at capacity", "server is overloaded")


def capacity_error(error):
    """Closed capacity/overload evidence from Codex's own error class (or its
    fixed message): server overloaded, or HTTP 429 after retries ran out.
    Never forwards provider text; the result is a boolean only."""
    if not isinstance(error, dict):
        return False
    info = error.get("codexErrorInfo", error.get("codex_error_info"))
    if isinstance(info, str) and info in CAPACITY_INFO:
        return True
    if isinstance(info, dict):
        for key in ("responseTooManyFailedAttempts", "response_too_many_failed_attempts"):
            detail = info.get(key)
            if isinstance(detail, dict) and 429 in (detail.get("httpStatusCode"), detail.get("http_status_code")):
                return True
    message = error.get("message")
    return isinstance(message, str) and any(text in message.lower() for text in CAPACITY_TEXT)


def side_effect(method, params):
    """Whether a provider notification is evidence of a possible side effect."""
    if method in ("item/started", "item/completed"):
        item = params.get("item") if isinstance(params, dict) else None
        return not (isinstance(item, dict) and item.get("type") in BENIGN_ITEMS)
    if method.startswith("item/reasoning/"):
        return False
    return method not in BENIGN_METHODS


def reported_model(value):
    return (isinstance(value, str) and 0 < len(value) <= 120 and
            all(c.isascii() and (c.isalnum() or c in "-_.:/") for c in value))


def require(condition, failure=Failure.PROTOCOL):
    if not condition:
        raise Refused("broker protocol refused", failure)


def exact(value, fields):
    require(isinstance(value, dict) and set(value) == set(fields))


def identifier(value):
    return isinstance(value, str) and 0 < len(value) <= 512


def agent_item(item):
    require(isinstance(item, dict) and item.get("type") == "agentMessage"
            and identifier(item.get("id")) and isinstance(item.get("text"), str)
            and len(item["text"].encode()) <= 8192
            and item.get("phase") in (None, "commentary", "partial_answer", "final_answer")
            and item.get("delivery") in (None, "async"),
            Failure.TURN_SCHEMA)
    clean = {"type": "agentMessage", "id": item["id"], "text": item["text"],
             "phase": item.get("phase")}
    # `request_user_input_async`: an interim question, not the turn's final.
    if item.get("delivery") == "async":
        clean["delivery"] = "async"
    return clean


def decode(raw, limit=MAX_FRAME):
    require(len(raw) <= limit, Failure.FRAME_BOUND)
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result)
            result[key] = value
        return result
    def finite(text):
        value = float(text)
        require(math.isfinite(value))
        return value
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=unique,
                          parse_float=finite,
                          parse_constant=lambda _: require(False))
    except Refused as error:
        error.failure = Failure.FRAME_DECODE
        raise
    except (ValueError, UnicodeError, RecursionError) as error:
        raise Refused("invalid frame", Failure.FRAME_DECODE) from error


def encode(value):
    raw = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode() + b"\n"
    require(len(raw) <= MAX_FRAME + 1, Failure.FRAME_BOUND)
    return raw


# Fast runs in parallel with Deep on the same input. Any Fast side effect would
# happen twice (once per layer), so Fast never gets more than read-only.
FAST_SANDBOX = ("read-only", "readOnly")


class Channel:
    def __init__(self, workspace, *, expected_native=None, offline_python=False, workspace_exec=False,
                 workspace_trusted=False, host_full_access=False, conversation_workspaces=(),
                 fast_only=False, quota_observer=None):
        # Operator instance opt-in only: Codex danger-full-access on the host.
        require(type(host_full_access) is bool)
        # Optional passive quota cache (codex_quota.QuotaSink.observe). Never
        # execution evidence; see provider() for its isolation.
        require(quota_observer is None or callable(quota_observer))
        self.quota_observer = quota_observer
        self.owner_id = None
        # The dedicated Fast broker serves only Fast identities.
        require(type(fast_only) is bool)
        self.fast_only = fast_only
        # Operator-pinned per-conversation working directories (host full
        # access only). Runtime selects one for a Deep/Fast thread; no other
        # directory is ever accepted.
        conversation_workspaces = tuple(str(path) for path in conversation_workspaces)
        require(not conversation_workspaces or host_full_access)
        require(all(path.startswith("/") and "\0" not in path for path in conversation_workspaces))
        self.conversation_workspaces = frozenset(conversation_workspaces)
        self.sandbox = ("danger-full-access", "dangerFullAccess") if host_full_access else (
            "read-only", "readOnly")
        require(type(offline_python) is bool and type(workspace_exec) is bool
                and type(workspace_trusted) is bool and not (offline_python and workspace_exec)
                and (workspace_exec or not workspace_trusted))
        self.workspace_trusted = workspace_trusted
        self.offline_python = offline_python
        self.workspace_exec = workspace_exec
        self.tool_enabled = offline_python or workspace_exec
        self.offline_route = None
        if offline_python:
            from offline_route import OfflineRoute
            self.offline_route = OfflineRoute()
        if workspace_exec:
            from workspace_route import WorkspaceRoute
            self.offline_route = WorkspaceRoute(workspace_trusted)
        require(expected_native is None or identifier(expected_native))
        self.expected_native = expected_native
        self.workspace = str(workspace)
        self.handle = None
        self.parallel_deep = False
        self.stage = "new"
        self.pending = None
        self.seen = set()
        self.last_outer = 0
        self.retired_turns = set()
        self.last_turn_inner = 0
        self.requested_model = None
        self.model_observed = False
        # Current turn: any possible side effect, and a closed capacity error.
        self.side_effects = False
        self.capacity = False
        self.activity = False
        self.native = None
        self.committed = False
        self.turn = None
        self.terminal = False
        self.messages = set()
        self.cancelled = False
        self.cancelled_tool = False
        self.steer_ids = set()

    def client(self, request):
        exact(request, ("id", "method", "params"))
        outer = request["id"]
        require(type(outer) is int and 0 < outer < 2**53 and outer not in self.seen)
        require(len(self.seen) < 256)
        require(outer > self.last_outer)
        self.last_outer = outer
        self.seen.add(outer)
        method, params = request["method"], request["params"]
        if self.handle is None:
            require(method == "OpenOwnedSession")
            exact(params, ("protocol", "identity"))
            require(params["protocol"] == PROTOCOL)
            identity = params["identity"]
            exact(identity, ("provider", "role", "owner_id", "session_id", "namespace", "incarnation"))
            require(identity["provider"] == "codex")  # ClaudeUnsupported; no fallback.
            require(all(identifier(value) for value in identity.values()))
            # Closed transport metadata only. Core must separately issue Worker
            # parent/task admission; role JSON cannot create that authority.
            require(identity["role"] in ("fast", "deep", "worker"))
            require(not self.tool_enabled or identity["role"] == "worker")
            # The read-only (Fast) service broker also serves a read-only
            # parallel Deep slot (docs/v2/parallel-deep.md): same sandbox,
            # same native profile without MCP servers, apps or hooks.
            require(not self.fast_only or identity["role"] in ("fast", "deep"))
            self.role = identity["role"]
            self.owner_id = identity["owner_id"]
            self.parallel_deep = self.fast_only and self.role == "deep"
            if self.role == "fast" or self.fast_only:
                # Fast is read-only on every instance, including host full
                # access: Codex's read-only sandbox denies file writes and
                # network to every command. Runtime must request it and the
                # provider must confirm it (see thread/start below).
                self.sandbox = FAST_SANDBOX
            self.handle = secrets.token_hex(24)
            return None, {"id": outer, "result": {"protocol": PROTOCOL,
                    "identity": identity, "metadata_only": True, "owned_handle": self.handle}}
        exact(params, ("owned_handle", "frame"))
        require(params["owned_handle"] == self.handle)
        require(method in ("BrokerMetadata", "CommitExecution", "CancelExecution", "ToolResult", "SteerExecution"))
        frame = params["frame"]
        require(self.pending is None)
        require(isinstance(frame, dict))
        if method == "ToolResult":
            require(self.tool_enabled and self.committed and self.turn is not None
                    and not self.terminal and not self.cancelled)
            clean = self.offline_route.submit(request, self.handle)
            return clean, {"id": outer, "result": {"owned_handle": self.handle, "frame": None}}
        if method == "BrokerMetadata":
            kind = self.metadata(frame)
            if kind == "initialized":
                self.stage = "initialized"
                return frame, {"id": outer, "result": {"owned_handle": self.handle, "frame": None}}
        elif method == "SteerExecution":
            # Exclusively owned parent pipe; only Core-issued consumed steer
            # authority may derive this frame. JSON is not that authority.
            # A read-only parallel Deep turn is never steered (only the writer).
            require(self.role in ("fast", "deep") and not self.parallel_deep and not self.tool_enabled
                    and self.committed and self.turn is not None
                    and not self.terminal and not self.cancelled)
            exact(frame, ("id", "method", "params"))
            request_id = frame["id"]
            require(isinstance(request_id, str))
            try:
                require(str(uuid.UUID(request_id)) == request_id)
            except ValueError:
                raise Refused("steer request identity refused") from None
            require(request_id not in self.steer_ids and len(self.steer_ids) < 128)
            require(frame["method"] == "turn/steer")
            exact(frame["params"], ("threadId", "expectedTurnId", "input"))
            params = frame["params"]
            require(params["threadId"] == self.native and params["expectedTurnId"] == self.turn)
            require(isinstance(params["input"], list) and len(params["input"]) == 1)
            item = params["input"][0]
            exact(item, ("type", "text", "text_elements"))
            require(item["type"] == "text" and isinstance(item["text"], str)
                    and 0 < len(item["text"].encode()) <= 32768 and "\0" not in item["text"]
                    and item["text_elements"] == [])
            self.steer_ids.add(request_id)  # burn before preparation/partial write
            kind = "turn/steer"
        elif method == "CancelExecution":
            # Parent must hold Core cancellation fence for the ORIGINAL binding
            # and receipt.new_fenced_admission. JSON is not issuer evidence.
            # A terminal may already be in flight to Runtime: an interrupt for
            # the same, just-ended turn is forwarded and its refusal tolerated.
            require(self.committed and self.turn is not None and not self.cancelled)
            exact(frame, ("id", "method", "params"))
            require(type(frame["id"]) is int and frame["id"] > 0 and frame["method"] == "turn/interrupt")
            exact(frame["params"], ("threadId", "turnId"))
            require(frame["params"] == {"threadId": self.native, "turnId": self.turn})
            if self.offline_route is not None:
                self.cancelled_tool = self.offline_route.cancel()
            self.cancelled = True  # a lost acknowledgement never permits retry
            kind = "turn/interrupt"
        else:
            # Only trusted Runtime may send this on its exclusively owned pipe,
            # after consuming the real Core capability under the durable fence.
            # This server cannot authenticate Core authority from JSON.
            require(self.stage == "ready" and (not self.committed or self.terminal))
            require(self.offline_route is None or self.offline_route.pending is None)
            self.validate_turn(frame)
            require(frame["id"] > self.last_turn_inner)
            self.last_turn_inner = frame["id"]
            self.requested_model = frame["params"].get("model")
            self.model_observed = False
            self.side_effects = False
            self.capacity = False
            self.activity = False
            message = frame["params"]["clientUserMessageId"]
            require(message not in self.messages and len(self.messages) < 256)
            self.messages.add(message)
            if self.turn is not None:
                self.retired_turns.add(self.turn)
            self.turn, self.terminal, self.cancelled = None, False, False
            self.cancelled_tool = False
            self.committed = True  # latch BEFORE a possible partial provider write
            kind = "turn/start"
        self.pending = (outer, frame["id"], kind)
        return frame, None

    def metadata(self, frame):
        kind = frame.get("method")
        if kind == "initialized":
            exact(frame, ("method",))
            require(self.stage == "initialize-replied")
            return kind
        exact(frame, ("id", "method", "params"))
        require(type(frame["id"]) is int and frame["id"] > 0)
        params = frame["params"]
        if kind == "initialize":
            require(self.stage == "new")
            exact(params, ("clientInfo", "capabilities"))
            exact(params["clientInfo"], ("name", "title", "version"))
            require(all(identifier(v) for v in params["clientInfo"].values()))
            require(params["capabilities"] == {"experimentalApi": self.tool_enabled}
                    and params["capabilities"]["experimentalApi"] is self.tool_enabled)
        elif kind == "account/read":
            require(self.stage == "initialized" and params == {"refreshToken": False}
                    and params["refreshToken"] is False)
        elif kind in ("thread/start", "thread/resume"):
            require(self.stage == "subscription")
            require((kind == "thread/resume") == (self.expected_native is not None))
            if kind == "thread/resume":
                require(isinstance(params, dict) and params.get("threadId") == self.expected_native
                        and params.get("excludeTurns") is True)
                params = dict(params)
                del params["threadId"]
                del params["excludeTurns"]
                require("ephemeral" not in params)
                params["ephemeral"] = False
            if self.tool_enabled:
                if self.workspace_exec:
                    from workspace_tool import advertisement
                else:
                    from offline_tool import advertisement
                tool = advertisement(self.workspace_trusted) if self.workspace_exec else advertisement()
                require(isinstance(params, dict) and params.get("dynamicTools") == [tool])
                params = dict(params)
                del params["dynamicTools"]
            if kind == "thread/start" and isinstance(params, dict) and "model" in params:
                # Optional explicit model for a fresh thread (bounded Fast). It
                # is a request only; the native start reply is the evidence.
                require(launch_model(params["model"]))
                params = dict(params)
                del params["model"]
            cwd = params.get("cwd") if isinstance(params, dict) else None
            if cwd != self.workspace and cwd in self.conversation_workspaces:
                self.workspace = cwd
            require(params == {"cwd": self.workspace, "approvalPolicy": "never",
                               "sandbox": self.sandbox[0], "ephemeral": False, "modelProvider": "openai"}
                    and params["ephemeral"] is False)
        else:
            raise Refused("metadata method refused")
        return kind

    def validate_turn(self, frame):
        exact(frame, ("id", "method", "params"))
        require(type(frame["id"]) is int and frame["id"] > 0 and frame["method"] == "turn/start")
        params = frame["params"]
        # Optional owner conversation settings, as V1 turnStartParams sends them.
        overrides = tuple(key for key in ("model", "effort") if isinstance(params, dict) and key in params)
        if "model" in overrides:
            require(launch_model(params["model"]))
        if "effort" in overrides:
            require(params["effort"] in CODEX_EFFORTS)
        exact(params, ("threadId", "clientUserMessageId", "input") + overrides)
        require(params["threadId"] == self.native and identifier(params["clientUserMessageId"]))
        require(isinstance(params["input"], list) and len(params["input"]) == 1)
        item = params["input"][0]
        exact(item, ("type", "text", "text_elements"))
        require(item["type"] == "text" and isinstance(item["text"], str) and item["text_elements"] == [])

    def observed_model(self, params):
        # Settings lack a turnId. Bind only a native-confirmed explicit override
        # to this channel's current committed request; never forward settings.
        if not self.committed or self.terminal or self.cancelled or self.model_observed \
                or not isinstance(params, dict) or params.get("threadId") != self.native:
            return None
        settings = params.get("threadSettings")
        model = settings.get("model") if isinstance(settings, dict) else None
        if not reported_model(model) or model != self.requested_model \
                or settings.get("modelProvider") != "openai":
            return None
        self.model_observed = True
        return {"method": "BrokerOutput", "params": {"owned_handle": self.handle, "frame": {
            "method": "model/observed", "params": {"threadId": self.native,
                "requestId": self.last_turn_inner, "model": model}}}}

    def activity_marker(self, params):
        """One `turn/activity` per turn: the model produced its first item."""
        if (self.activity or not self.committed or self.terminal or self.cancelled
                or params.get("item", {}).get("type") == "userMessage"
                or params.get("threadId") != self.native or not identifier(params.get("turnId"))
                or (self.turn is not None and params["turnId"] != self.turn)
                or params["turnId"] in self.retired_turns):
            return None
        self.activity = True
        self.turn = params["turnId"]
        return {"method": "BrokerOutput", "params": {"owned_handle": self.handle, "frame": {
            "method": "turn/activity", "params": {"threadId": self.native, "turnId": self.turn}}}}

    def observe_effects(self, method, params):
        """Record side-effect and capacity evidence for the committed turn."""
        if not self.committed or self.terminal:
            return
        if not isinstance(params, dict):
            # No thread or item to inspect: only a known benign method is safe.
            if method not in BENIGN_METHODS:
                self.side_effects = True
            return
        thread = params.get("threadId")
        if isinstance(thread, str) and thread and self.native is not None and thread != self.native:
            self.side_effects = True  # A sub-agent thread of this turn acted.
            return
        if method == "error":
            if params.get("willRetry") is False and capacity_error(params.get("error")):
                self.capacity = True
            return
        if side_effect(method, params):
            self.side_effects = True

    def provider(self, frame):
        require(isinstance(frame, dict), Failure.PROVIDER_OUTER)
        if frame.get("method") == "item/tool/call":
            self.side_effects = True
            require(self.tool_enabled and self.pending is None and self.committed
                    and self.turn is not None and not self.terminal and not self.cancelled,
                    Failure.UNSUPPORTED_TOOL)
            clean = self.offline_route.receive(frame, self.native, self.turn)
            return {"method": "BrokerOutput", "params": {"owned_handle": self.handle, "frame": clean}}
        if "id" not in frame:
            # Never pass server tool/approval requests through as notifications.
            require(isinstance(frame.get("method"), str) and "params" in frame,
                    Failure.PROVIDER_OUTER)
            self.observe_effects(frame["method"], frame["params"])
            if frame["method"] == "account/rateLimits/updated":
                # Account-wide usage metadata: never forwarded, and it cannot
                # start, renew, finish or cancel a turn.
                if self.quota_observer is not None and self.owner_id is not None:
                    try:
                        self.quota_observer(self.owner_id, frame["params"])
                    except Refused:
                        raise  # Preserve stop/control signals delivered during metadata I/O.
                    except Exception:
                        pass  # Quota metadata cannot fail a turn.
                return None
            if frame["method"] == "thread/settings/updated":
                return self.observed_model(frame["params"])
            item_event = frame["method"] in ("item/started", "item/completed")
            if item_event:
                params = frame["params"]
                require(isinstance(params, dict) and isinstance(params.get("item"), dict),
                        Failure.TURN_SCHEMA)
                if params["item"].get("type") != "agentMessage":
                    # Tool items remain metadata, never an execution grant. The
                    # first model item of a turn yields one closed activity
                    # marker (no item content) for Runtime's stall watchdog.
                    return self.activity_marker(params)
            if not item_event and frame["method"] not in (
                    "turn/started", "turn/completed", "item/agentMessage/delta", "model/rerouted"):
                return None
            foreign = frame["params"].get("threadId") if isinstance(frame["params"], dict) else None
            if (self.sandbox[1] == "dangerFullAccess" and self.native is not None
                    and isinstance(foreign, str) and foreign and foreign != self.native):
                # Host full access runs the operator's Codex with its own
                # features, e.g. spawn_agent sub-agents. Their thread events are
                # internal to this turn: never forwarded, never fatal.
                return None
            require(self.committed, Failure.BEFORE_COMMIT)
            require(not self.terminal, {
                "turn/started": Failure.LATE_TURN_STARTED,
                "turn/completed": Failure.LATE_TURN_COMPLETED,
                "item/agentMessage/delta": Failure.LATE_AGENT_DELTA,
            }.get(frame["method"], Failure.PROTOCOL))
            params = frame["params"]
            require(isinstance(params, dict), Failure.TURN_SCHEMA)
            require(params.get("threadId") == self.native, Failure.FOREIGN_THREAD)
            if "threadId" in params:
                require(params["threadId"] == self.native)
            if frame["method"] == "item/agentMessage/delta":
                require(identifier(params.get("turnId")) and isinstance(params.get("delta"), str)
                        and len(params["delta"].encode()) <= 8192, Failure.TURN_SCHEMA)
                turn_id = params["turnId"]
                clean = {k: params[k] for k in ("threadId", "turnId", "delta")}
                if "itemId" in params:
                    require(identifier(params["itemId"]), Failure.TURN_SCHEMA)
                    clean["itemId"] = params["itemId"]
            elif frame["method"] == "model/rerouted":
                require(identifier(params.get("turnId")) and reported_model(params.get("toModel")), Failure.TURN_SCHEMA)
                turn_id = params["turnId"]
                clean = {k: params[k] for k in ("threadId", "turnId", "toModel")}
            elif item_event:
                item = params["item"]
                require(identifier(params.get("turnId")), Failure.TURN_SCHEMA)
                turn_id = params["turnId"]
                clean = {"threadId": self.native, "turnId": turn_id,
                         "item": agent_item(item)}
            else:
                turn = params.get("turn")
                require(isinstance(turn, dict), Failure.TURN_SCHEMA)
                turn_id = turn.get("id")
                require(identifier(turn_id) and turn.get("status") in
                        ("inProgress", "completed", "failed", "interrupted"), Failure.TURN_SCHEMA)
                clean = {"threadId": self.native, "turn": {"id": turn_id, "status": turn["status"]}}
                if frame["method"] == "turn/completed" and "items" in turn:
                    require(isinstance(turn["items"], list) and len(turn["items"]) <= 128
                            and all(isinstance(item, dict) for item in turn["items"])
                            and turn.get("itemsView", "full") in ("full", "summary", "notLoaded"),
                            Failure.TURN_SCHEMA)
                    clean["turn"]["items"] = [agent_item(item) for item in turn["items"]
                                              if item.get("type") == "agentMessage"]
                    clean["turn"]["itemsView"] = turn.get("itemsView", "full")
                    if any(item.get("type") not in BENIGN_ITEMS for item in turn["items"]):
                        self.side_effects = True
                if frame["method"] == "turn/completed" and turn["status"] in ("failed", "interrupted"):
                    # Closed evidence only: Runtime may retry a capacity failure
                    # (or its own stall interrupt) once on a fallback model,
                    # never after a side effect.
                    if turn["status"] == "failed" and (self.capacity or capacity_error(turn.get("error"))):
                        clean["turn"]["error"] = {"class": "capacity"}
                    clean["turn"]["sideEffects"] = self.side_effects
            require(turn_id not in self.retired_turns, Failure.RETIRED_TURN)
            if self.turn is not None:
                require(turn_id == self.turn, Failure.TURN_MISMATCH)
            else:
                self.turn = turn_id
            if frame["method"] == "turn/completed":
                require(self.offline_route is None or self.offline_route.pending is None)
                if self.cancelled_tool:
                    require(self.cancelled and clean["turn"]["status"] == "interrupted")
                require(clean["turn"]["status"] in ("completed", "failed", "interrupted"))
                self.terminal = True
            frame = {"method": frame["method"], "params": clean}
            return {"method": "BrokerOutput", "params": {"owned_handle": self.handle, "frame": frame}}
        require(self.pending is not None, Failure.UNEXPECTED_RESPONSE)
        outer, inner, kind = self.pending
        if kind == "turn/interrupt" and isinstance(frame, dict) and set(frame) == {"id", "error"}:
            # A late interrupt (the turn had just ended) may be refused by the
            # native. Forward a closed refusal only; Runtime decides.
            require(type(frame["id"]) is type(inner) and frame["id"] == inner,
                    Failure.RESPONSE_CORRELATION)
            require(isinstance(frame["error"], dict))
            code = frame["error"].get("code")
            self.pending = None
            return {"id": outer, "result": {"owned_handle": self.handle, "frame": {
                "id": inner, "error": {"code": code if type(code) is int else 0}}}}
        exact(frame, ("id", "result"))
        require(type(frame["id"]) is type(inner) and frame["id"] == inner,
                Failure.RESPONSE_CORRELATION)
        result = frame["result"]
        require(isinstance(result, dict))
        if kind == "initialize":
            require(all(identifier(result.get(k)) for k in ("userAgent", "platformFamily", "platformOs", "codexHome")))
            # A canonical account directory must never escape the trusted broker.
            frame = {"id": inner, "result": {key: result[key] for key in ("userAgent", "platformFamily", "platformOs")}}
            frame["result"]["codexHome"] = "broker-private"
            self.stage = "initialize-replied"
        elif kind == "account/read":
            require(result.get("requiresOpenaiAuth") is True)
            account = result.get("account")
            require(isinstance(account, dict) and account.get("type") == "chatgpt")
            frame = {"id": inner, "result": {"requiresOpenaiAuth": result["requiresOpenaiAuth"],
                                             "account": {"type": "chatgpt"}}}
            self.stage = "subscription"
        elif kind in ("thread/start", "thread/resume"):
            thread = result.get("thread")
            require(isinstance(thread, dict))
            if kind == "thread/resume":
                # Metadata-only setup must not hydrate historical turns. The
                # transport frame limit remains unchanged if a peer ignores it.
                require(thread.get("turns", []) == [])
            require(result.get("modelProvider") == thread.get("modelProvider") == "openai")
            require(identifier(thread.get("id")) and thread.get("ephemeral") is False)
            require(self.expected_native is None or thread["id"] == self.expected_native)
            require(thread.get("cwd") == self.workspace and result.get("cwd") == self.workspace)
            require(result.get("approvalPolicy") == "never")
            sandbox = result.get("sandbox")
            require(isinstance(sandbox, dict))
            require(sandbox.get("type") == self.sandbox[1] and (
                self.sandbox[1] == "dangerFullAccess" or sandbox.get("networkAccess", False) is False))
            self.native = thread["id"]
            self.stage = "ready"
            frame = {"id": inner, "result": {"thread": {k: thread[k] for k in ("id", "cwd", "ephemeral", "modelProvider")},
                     "cwd": self.workspace, "approvalPolicy": "never", "modelProvider": "openai",
                     "sandbox": {"type": "readOnly", "networkAccess": False}
                     if self.sandbox[1] == "readOnly" else {"type": "dangerFullAccess"}}}
            if reported_model(result.get("model")):
                frame["result"]["model"] = result["model"]
        elif kind == "turn/start":
            require(isinstance(result.get("turn"), dict))
            require(identifier(result["turn"].get("id")))
            require(result["turn"].get("status") == "inProgress")
            require(self.turn is None or self.turn == result["turn"]["id"])
            self.turn = result["turn"]["id"]
            frame = {"id": inner, "result": {"turn": {"id": self.turn, "status": "inProgress"}}}
        elif kind == "turn/steer":
            require(not self.terminal and not self.cancelled)
            exact(result, ("turnId",))
            require(result["turnId"] == self.turn)
            frame = {"id": inner, "result": {"turnId": self.turn}}
        elif kind == "turn/interrupt":
            exact(result, ())
            frame = {"id": inner, "result": {}}
        self.pending = None
        return {"id": outer, "result": {"owned_handle": self.handle, "frame": frame}}
