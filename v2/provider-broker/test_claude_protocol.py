"""Closed Claude composition contracts; synthetic identity, no provider launch."""
from types import SimpleNamespace
import unittest
from claude_protocol import ClaudeChannel
from protocol import PROTOCOL, Refused
from test_protocol import IDENTITY


class ClaudeProtocolTests(unittest.TestCase):
    def setUp(self):
        self.native = "11111111-1111-4111-8111-111111111111"
        self.channel = ClaudeChannel(SimpleNamespace(native=self.native))
        identity = dict(IDENTITY, provider="claude")
        _, response = self.channel.client({"id":1,"method":"OpenOwnedSession",
            "params":{"protocol":PROTOCOL,"identity":identity}})
        self.handle = response["result"]["owned_handle"]

    def request(self, outer, message="message:1"):
        return {"id":outer,"method":"CommitExecution","params":{
            "owned_handle":self.handle,"message_id":message,"frame":{
                "type":"user","session_id":self.native,"parent_tool_use_id":None,
                "message":{"role":"user","content":"synthetic durable input"}}}}

    def init(self):
        return self.channel.provider({"type":"system","subtype":"init",
            "session_id":self.native,"apiKey":"synthetic-private"})

    def test_readiness_then_terminal_gated_followup(self):
        self.assertNotIn("synthetic-private", str(self.init()))
        self.channel.client(self.request(2))
        self.channel.provider({"type":"result","subtype":"success","is_error":False,
            "session_id":self.native,"result":"synthetic output"})
        self.channel.client(self.request(3, "message:2"))
        with self.assertRaises(Refused):
            self.channel.client(self.request(4, "message:3"))

    def test_before_readiness_and_raw_control_refused(self):
        with self.assertRaises(Refused):
            self.channel.client(self.request(2))
        self.init()
        request = self.request(3)
        request["method"] = "CancelExecution"
        with self.assertRaises(Refused):
            self.channel.client(request)

    def test_foreign_native_and_duplicate_message_refused(self):
        self.init()
        request = self.request(2)
        request["params"]["frame"]["session_id"] = "foreign"
        with self.assertRaises(Refused):
            self.channel.client(request)
        self.channel.client(self.request(3))
        self.channel.provider({"type":"result","subtype":"success","is_error":False,
            "session_id":self.native,"result":"output"})
        with self.assertRaises(Refused):
            self.channel.client(self.request(4))
