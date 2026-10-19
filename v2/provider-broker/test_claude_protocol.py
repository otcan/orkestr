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
                "type":"user","uuid":"33333333-3333-4333-8333-333333333333","session_id":self.native,"parent_tool_use_id":None,
                "message":{"role":"user","content":"synthetic durable input"}}}}

    def init(self):
        self.channel.client({"id":100,"method":"BrokerMetadata","params":{
            "owned_handle":self.handle,"frame":{"type":"control_request",
            "request_id":"setup:1","request":{"subtype":"initialize","hooks":None}}}})
        return self.channel.provider({"type":"control_response","response":{
            "subtype":"success","request_id":"setup:1","response":{"private":"synthetic-private"}}})

    def test_terminal_does_not_authorize_continuation_or_replayed_result(self):
        self.assertNotIn("synthetic-private", str(self.init()))
        self.channel.client(self.request(2))
        prior = {"type":"result","subtype":"success","is_error":False,
            "uuid":"22222222-2222-4222-8222-222222222222",
            "user_message_uuid":"33333333-3333-4333-8333-333333333333","session_id":self.native,"result":"synthetic output"}
        self.channel.provider(prior)
        with self.assertRaises(Refused):
            self.channel.client(self.request(3, "message:2"))
        with self.assertRaises(Refused):
            self.channel.provider(prior)
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

    def test_setup_ack_correlation_and_closed_metadata(self):
        self.init()
        self.assertTrue(self.channel.initialized)
        self.assertFalse(self.channel.system_seen)
        with self.assertRaises(Refused):
            self.channel.provider({"type":"control_response","response":{
                "subtype":"success","request_id":"setup:1","response":{}}})

    def test_unsolicited_init_is_not_metadata_readiness(self):
        with self.assertRaises(Refused):
            self.channel.provider({"type":"system","subtype":"init","session_id":self.native})
        self.assertFalse(self.channel.initialized)

    def test_metadata_cannot_submit_user_or_change_controls(self):
        for inner in ({"subtype":"interrupt","hooks":None},
                      {"subtype":"initialize","hooks":{}},
                      {"subtype":"initialize","hooks":None,"model":"external"}):
            with self.assertRaises(Refused):
                self.channel.client({"id":10+len(self.channel.seen),"method":"BrokerMetadata",
                    "params":{"owned_handle":self.handle,"frame":{"type":"control_request",
                    "request_id":"setup:1","request":inner}}})
        self.assertFalse(self.channel.initialized)

    def test_foreign_native_and_duplicate_message_refused(self):
        self.init()
        request = self.request(2)
        request["params"]["frame"]["session_id"] = "foreign"
        with self.assertRaises(Refused):
            self.channel.client(request)
        self.channel.client(self.request(3))
        self.channel.provider({"type":"result","subtype":"success","is_error":False,
            "user_message_uuid":"33333333-3333-4333-8333-333333333333","uuid":"55555555-5555-4555-8555-555555555555","session_id":self.native,"result":"output"})
        with self.assertRaises(Refused):
            self.channel.client(self.request(4))
