import unittest
from pathlib import Path
from protocol import Channel, PROTOCOL, Refused, decode, encode

IDENTITY = {"provider": "codex", "role": "deep", "owner_id": "synthetic-owner",
            "session_id": "synthetic-session", "namespace": "subscription:local",
            "incarnation": "synthetic-boot"}


def opened():
    channel = Channel(Path("/synthetic/workspace"))
    _, response = channel.client({"id": 1, "method": "OpenOwnedSession",
        "params": {"protocol": PROTOCOL, "identity": dict(IDENTITY)}})
    return channel, response["result"]["owned_handle"]


def request(channel, frame, method="BrokerMetadata", outer=2):
    return channel.client({"id": outer, "method": method,
        "params": {"owned_handle": channel.handle, "frame": frame}})


def ready(channel, native="synthetic-native"):
    request(channel, {"id": 1, "method": "initialize", "params": {
        "clientInfo": {"name": "synthetic", "title": "Synthetic", "version": "1"},
        "capabilities": {"experimentalApi": False}}})
    reply = channel.provider({"id": 1, "result": {"userAgent": "synthetic", "platformFamily": "unix",
        "platformOs": "linux", "codexHome": "/synthetic/private", "token": "fake-secret"}})
    assert "fake-secret" not in str(reply) and "/synthetic/private" not in str(reply)
    request(channel, {"method": "initialized"}, outer=3)
    request(channel, {"id": 2, "method": "account/read", "params": {"refreshToken": False}}, outer=4)
    reply = channel.provider({"id": 2, "result": {"requiresOpenaiAuth": True,
        "account": {"type": "chatgpt", "token": "fake-secret"}}})
    assert "fake-secret" not in str(reply)
    request(channel, {"id": 3, "method": "thread/start", "params": {"cwd": channel.workspace,
        "approvalPolicy": "never", "sandbox": "read-only", "ephemeral": False, "modelProvider": "openai"}}, outer=5)
    channel.provider({"id": 3, "result": {"thread": {"id": native, "cwd": channel.workspace,
        "ephemeral": False, "modelProvider": "openai"}, "modelProvider": "openai", "cwd": channel.workspace, "approvalPolicy": "never",
        "sandbox": {"type": "readOnly", "networkAccess": False}}})


def turn(native="synthetic-native"):
    return {"id": 4, "method": "turn/start", "params": {"threadId": native,
        "clientUserMessageId": "synthetic-message", "input": [
            {"type": "text", "text": "synthetic durable text", "text_elements": []}]}}


class ProtocolTests(unittest.TestCase):
    def test_fresh_thread_may_request_a_valid_model_only(self):
        start = {"cwd": "/synthetic/workspace", "approvalPolicy": "never", "sandbox": "read-only",
                 "ephemeral": False, "modelProvider": "openai"}
        def to_thread(params):
            channel, _ = opened()
            request(channel, {"id": 1, "method": "initialize", "params": {
                "clientInfo": {"name": "synthetic", "title": "Synthetic", "version": "1"},
                "capabilities": {"experimentalApi": False}}})
            channel.provider({"id": 1, "result": {"userAgent": "synthetic", "platformFamily": "unix",
                "platformOs": "linux", "codexHome": "/synthetic/private"}})
            request(channel, {"method": "initialized"}, outer=3)
            request(channel, {"id": 2, "method": "account/read", "params": {"refreshToken": False}}, outer=4)
            channel.provider({"id": 2, "result": {"requiresOpenaiAuth": True, "account": {"type": "chatgpt"}}})
            return request(channel, {"id": 3, "method": "thread/start", "params": params}, outer=5)
        forwarded = to_thread({**start, "model": "synthetic-fast-model"})
        self.assertNotIn("error", forwarded)
        for model in ("a b", 5, "", None):
            with self.assertRaises(Refused):
                to_thread({**start, "model": model})
    def test_native_model_reroute_is_scoped_and_strips_private_details(self):
        channel, _ = opened()
        ready(channel)
        request(channel, turn(), "CommitExecution", 6)
        channel.provider({"id": 4, "result": {"turn": {"id": "synthetic-turn", "status": "inProgress"}}})
        result = channel.provider({"method": "model/rerouted", "params": {
            "threadId": "synthetic-native", "turnId": "synthetic-turn", "toModel": "native-answer-model",
            "fromModel": "native-original-model", "reason": "private provider detail"}})
        self.assertEqual(result["params"]["frame"]["params"], {
            "threadId": "synthetic-native", "turnId": "synthetic-turn", "toModel": "native-answer-model"})
        with self.assertRaises(Refused):
            channel.provider({"method": "model/rerouted", "params": {
                "threadId": "synthetic-native", "turnId": "foreign", "toModel": "foreign-model"}})

    def test_fresh_metadata_and_single_commit(self):
        channel, _ = opened()
        ready(channel)
        outgoing, _ = request(channel, turn(), "CommitExecution", 6)
        self.assertEqual(outgoing, turn())
        reply = channel.provider({"id": 4, "result": {"turn": {"id": "synthetic-turn", "status": "inProgress"}}})
        self.assertEqual(reply["id"], 6)
        with self.assertRaises(Refused):
            request(channel, turn(), "CommitExecution", 7)

    def test_owner_model_and_effort_overrides_are_closed(self):
        allowed = turn()
        allowed["params"].update(model="gpt-5.1-codex", effort="xhigh")
        channel, _ = opened()
        ready(channel)
        outgoing, _ = request(channel, allowed, "CommitExecution", 6)
        self.assertEqual(outgoing, allowed)
        for key, value in [("model", "openai"), ("model", "a b"), ("model", 5), ("effort", "extreme"),
                           ("sandboxPolicy", {"type": "dangerFullAccess"}), ("cwd", "/")]:
            denied = turn()
            denied["params"][key] = value
            channel, _ = opened()
            ready(channel)
            with self.assertRaises(Refused):
                request(channel, denied, "CommitExecution", 6)

    def test_metadata_never_commits_and_foreign_native_refused(self):
        for kind in ["BrokerMetadata", "CommitExecution"]:
            channel, _ = opened()
            with self.assertRaises(Refused):
                request(channel, turn(), kind)
        channel, _ = opened()
        ready(channel)
        with self.assertRaises(Refused):
            request(channel, turn("foreign-native"), "CommitExecution", 6)

    def test_foreign_handle_client_options_and_claude_refused(self):
        channel, _ = opened()
        with self.assertRaises(Refused):
            channel.client({"id": 2, "method": "BrokerMetadata", "params": {"owned_handle": "foreign", "frame": {}}})
        for field in ["argv", "environment", "path", "socket", "profile"]:
            with self.assertRaises(Refused):
                Channel("/synthetic").client({"id": 1, "method": "OpenOwnedSession", "params": {
                    "protocol": PROTOCOL, "identity": IDENTITY, field: "forbidden"}})
        with self.assertRaises(Refused):
            Channel("/synthetic").client({"id": 1, "method": "OpenOwnedSession", "params": {
                "protocol": PROTOCOL, "identity": dict(IDENTITY, provider="claude")}})

    def test_nonpersistent_or_foreign_readiness_and_api_key_refused(self):
        for changed in [{"ephemeral": True}, {"ephemeral": 0}, {"cwd": "/foreign"}, {"sandbox": "danger-full-access"}]:
            channel, _ = opened()
            channel.stage = "subscription"
            params = {"cwd": channel.workspace, "approvalPolicy": "never", "sandbox": "read-only", "ephemeral": False, "modelProvider": "openai"}
            params.update(changed)
            with self.assertRaises(Refused):
                request(channel, {"id": 1, "method": "thread/start", "params": params})
        channel, _ = opened()
        channel.stage = "initialized"
        request(channel, {"id": 1, "method": "account/read", "params": {"refreshToken": False}})
        with self.assertRaises(Refused):
            channel.provider({"id": 1, "result": {"requiresOpenaiAuth": False, "account": {"type": "apiKey"}}})

    def test_bounds_duplicates_unsolicited_requests_and_cross_turn(self):
        for raw in [b'{"id":1,"id":2}', b'NaN', b' ' * 65537]:
            with self.assertRaises(Refused):
                decode(raw)
        with self.assertRaises(Refused):
            encode({"text": "x" * 65536})
        channel, _ = opened()
        with self.assertRaises(Refused):
            channel.provider({"id": 1, "method": "exec", "params": {}})
        ready(channel)
        request(channel, turn(), "CommitExecution", 6)
        channel.provider({"id": 4, "result": {"turn": {"id": "synthetic-turn", "status": "inProgress"}}})
        with self.assertRaises(Refused):
            channel.provider({"method": "item/agentMessage/delta", "params": {
                "threadId": "synthetic-native", "turnId": "foreign-turn", "delta": "x"}})


if __name__ == "__main__":
    unittest.main()
