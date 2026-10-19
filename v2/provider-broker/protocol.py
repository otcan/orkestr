"""Closed Codex-only owned-session protocol. Wire identity is NOT Core authority."""
import json
import math
import secrets

PROTOCOL = "orkestr-v2-provider-broker-v1"
MAX_FRAME = 65536


class Refused(Exception):
    pass


def require(condition):
    if not condition:
        raise Refused("broker protocol refused")


def exact(value, fields):
    require(isinstance(value, dict) and set(value) == set(fields))


def identifier(value):
    return isinstance(value, str) and 0 < len(value) <= 512


def decode(raw):
    require(len(raw) <= MAX_FRAME)
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
    except (ValueError, UnicodeError, RecursionError) as error:
        raise Refused("invalid frame") from error


def encode(value):
    raw = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode() + b"\n"
    require(len(raw) <= MAX_FRAME + 1)
    return raw


class Channel:
    def __init__(self, workspace, *, expected_native=None, offline_python=False):
        require(type(offline_python) is bool)
        self.offline_python = offline_python
        self.offline_route = None
        if offline_python:
            from offline_route import OfflineRoute
            self.offline_route = OfflineRoute()
        require(expected_native is None or identifier(expected_native))
        self.expected_native = expected_native
        self.workspace = str(workspace)
        self.handle = None
        self.stage = "new"
        self.pending = None
        self.seen = set()
        self.last_outer = 0
        self.retired_turns = set()
        self.last_turn_inner = 0
        self.native = None
        self.committed = False
        self.turn = None
        self.terminal = False
        self.messages = set()
        self.cancelled = False
        self.cancelled_tool = False

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
            require(not self.offline_python or identity["role"] == "worker")
            self.handle = secrets.token_hex(24)
            return None, {"id": outer, "result": {"protocol": PROTOCOL,
                    "identity": identity, "metadata_only": True, "owned_handle": self.handle}}
        exact(params, ("owned_handle", "frame"))
        require(params["owned_handle"] == self.handle)
        require(method in ("BrokerMetadata", "CommitExecution", "CancelExecution", "ToolResult"))
        frame = params["frame"]
        require(self.pending is None)
        require(isinstance(frame, dict))
        if method == "ToolResult":
            require(self.offline_python and self.committed and self.turn is not None
                    and not self.terminal and not self.cancelled)
            clean = self.offline_route.submit(request, self.handle)
            return clean, {"id": outer, "result": {"owned_handle": self.handle, "frame": None}}
        if method == "BrokerMetadata":
            kind = self.metadata(frame)
            if kind == "initialized":
                self.stage = "initialized"
                return frame, {"id": outer, "result": {"owned_handle": self.handle, "frame": None}}
        elif method == "CancelExecution":
            # Parent must hold Core cancellation fence for the ORIGINAL binding
            # and receipt.new_fenced_admission. JSON is not issuer evidence.
            require(self.committed and self.turn is not None and not self.terminal and not self.cancelled)
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
            require(params["capabilities"] == {"experimentalApi": self.offline_python}
                    and params["capabilities"]["experimentalApi"] is self.offline_python)
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
            if self.offline_python:
                from offline_tool import advertisement
                require(isinstance(params, dict) and params.get("dynamicTools") == [advertisement()])
                params = dict(params)
                del params["dynamicTools"]
            require(params == {"cwd": self.workspace, "approvalPolicy": "never",
                               "sandbox": "read-only", "ephemeral": False, "modelProvider": "openai"}
                    and params["ephemeral"] is False)
        else:
            raise Refused("metadata method refused")
        return kind

    def validate_turn(self, frame):
        exact(frame, ("id", "method", "params"))
        require(type(frame["id"]) is int and frame["id"] > 0 and frame["method"] == "turn/start")
        params = frame["params"]
        exact(params, ("threadId", "clientUserMessageId", "input"))
        require(params["threadId"] == self.native and identifier(params["clientUserMessageId"]))
        require(isinstance(params["input"], list) and len(params["input"]) == 1)
        item = params["input"][0]
        exact(item, ("type", "text", "text_elements"))
        require(item["type"] == "text" and isinstance(item["text"], str) and item["text_elements"] == [])

    def provider(self, frame):
        require(isinstance(frame, dict))
        if frame.get("method") == "item/tool/call":
            require(self.offline_python and self.pending is None and self.committed
                    and self.turn is not None and not self.terminal and not self.cancelled)
            clean = self.offline_route.receive(frame, self.native, self.turn)
            return {"method": "BrokerOutput", "params": {"owned_handle": self.handle, "frame": clean}}
        if "id" not in frame:
            # Never pass server tool/approval requests through as notifications.
            require(isinstance(frame.get("method"), str) and "params" in frame)
            if frame["method"] not in ("turn/started", "turn/completed", "item/agentMessage/delta"):
                return None
            require(self.committed and not self.terminal)
            params = frame["params"]
            require(isinstance(params, dict) and params.get("threadId") == self.native)
            if "threadId" in params:
                require(params["threadId"] == self.native)
            if frame["method"] == "item/agentMessage/delta":
                require(identifier(params.get("turnId")) and isinstance(params.get("delta"), str)
                        and len(params["delta"].encode()) <= 8192)
                turn_id = params["turnId"]
                clean = {k: params[k] for k in ("threadId", "turnId", "delta")}
            else:
                turn = params.get("turn")
                require(isinstance(turn, dict))
                turn_id = turn.get("id")
                require(identifier(turn_id) and turn.get("status") in
                        ("inProgress", "completed", "failed", "interrupted"))
                clean = {"threadId": self.native, "turn": {"id": turn_id, "status": turn["status"]}}
            require(turn_id not in self.retired_turns)
            if self.turn is not None:
                require(turn_id == self.turn)
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
        require(self.pending is not None)
        outer, inner, kind = self.pending
        exact(frame, ("id", "result"))
        require(type(frame["id"]) is int and frame["id"] == inner)
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
            require(sandbox.get("type") == "readOnly" and sandbox.get("networkAccess", False) is False)
            self.native = thread["id"]
            self.stage = "ready"
            frame = {"id": inner, "result": {"thread": {k: thread[k] for k in ("id", "cwd", "ephemeral", "modelProvider")},
                     "cwd": self.workspace, "approvalPolicy": "never", "modelProvider": "openai",
                     "sandbox": {"type": "readOnly", "networkAccess": False}}}
        elif kind == "turn/start":
            require(isinstance(result.get("turn"), dict))
            require(identifier(result["turn"].get("id")))
            require(result["turn"].get("status") == "inProgress")
            require(self.turn is None or self.turn == result["turn"]["id"])
            self.turn = result["turn"]["id"]
            frame = {"id": inner, "result": {"turn": {"id": self.turn, "status": "inProgress"}}}
        elif kind == "turn/interrupt":
            exact(result, ())
            frame = {"id": inner, "result": {}}
        self.pending = None
        return {"id": outer, "result": {"owned_handle": self.handle, "frame": frame}}
