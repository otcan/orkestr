"""Synthetic closed telemetry and initialize-envelope regressions."""
import uuid
import unittest
import test_claude_protocol as fixtures
from protocol import Refused


class ClaudeTelemetryTests(unittest.TestCase):
    setUp = fixtures.ClaudeProtocolTests.setUp
    init = fixtures.ClaudeProtocolTests.init
    request = fixtures.ClaudeProtocolTests.request
    def request(self, outer, message="message:1"):
        request = fixtures.ClaudeProtocolTests.request(self, outer, message)
        request['params']['frame']['uuid'] = '33333333-3333-4333-8333-333333333333'
        return request

    def telemetry(self, kind="command_lifecycle"):
        frame = {"type": kind, "session_id": self.native, "uuid": str(uuid.uuid4())}
        if kind == 'command_lifecycle':
            frame.update(command_uuid='33333333-3333-4333-8333-333333333333', state='queued')
        else:
            frame['rate_limit_info'] = {'status':'allowed', 'isUsingOverage':False,
                'unifiedWindows':{'five_hour':{'utilization':0.1,'resetsAt':123}}}
        return frame

    def test_optional_pending_arrays_empty_only(self):
        self.channel.client({"id":100,"method":"BrokerMetadata","params":{
            "owned_handle":self.handle,"frame":{"type":"control_request",
            "request_id":"setup:1","request":{"subtype":"initialize","hooks":None}}}})
        response = {"subtype":"success","request_id":"setup:1","response":{},
            "pending_permission_requests":[],"pending_user_dialog_requests":[]}
        clean = self.channel.provider({"type":"control_response","response":response})
        self.assertEqual(clean["params"]["frame"]["response"],
                         {"subtype":"success","request_id":"setup:1"})
        self.assertFalse(self.channel.system_seen)

    def test_nonempty_pending_does_not_initialize(self):
        self.channel.client({"id":100,"method":"BrokerMetadata","params":{
            "owned_handle":self.handle,"frame":{"type":"control_request",
            "request_id":"setup:1","request":{"subtype":"initialize","hooks":None}}}})
        with self.assertRaises(Refused):
            self.channel.provider({"type":"control_response","response":{
                "subtype":"success","request_id":"setup:1","response":{},
                "pending_permission_requests":[{}]}})
        self.assertFalse(self.channel.initialized)

    def test_telemetry_before_init_and_after_terminal_is_non_authoritative(self):
        self.init()
        self.channel.client(self.request(2))
        for kind in ("command_lifecycle", "command_lifecycle", "rate_limit_event"):
            self.assertIsNone(self.channel.provider(self.telemetry(kind)))
        self.assertFalse(self.channel.system_seen)
        self.assertFalse(self.channel.terminal)
        self.channel.provider({"type":"result","subtype":"success","is_error":False,
            "session_id":self.native,"result":"synthetic"})
        self.assertIsNone(self.channel.provider(self.telemetry()))
        self.assertTrue(self.channel.terminal)
        with self.assertRaises(Refused):
            self.channel.client(self.request(3, "message:2"))

    def test_telemetry_cannot_supply_readiness(self):
        with self.assertRaises(Refused):
            self.channel.provider(self.telemetry())
        self.assertFalse(self.channel.initialized)

    def test_duplicate_telemetry_poisoned(self):
        self.init()
        self.channel.client(self.request(2))
        frame = self.telemetry()
        self.channel.provider(frame)
        with self.assertRaises(Refused):
            self.channel.provider(frame)
        self.assertTrue(self.channel.poisoned)

    def test_telemetry_bound(self):
        self.init()
        self.channel.client(self.request(2))
        for _ in range(128):
            self.channel.provider(self.telemetry())
        with self.assertRaises(Refused):
            self.channel.provider(self.telemetry())

    def test_foreign_or_extra_telemetry_refused(self):
        self.init()
        self.channel.client(self.request(2))
        frame = self.telemetry()
        frame["request"] = {"subtype":"interrupt"}
        with self.assertRaises(Refused):
            self.channel.provider(frame)

    def test_late_foreign_command_refused(self):
        self.init()
        self.channel.client(self.request(2))
        frame = self.telemetry()
        frame['command_uuid'] = '44444444-4444-4444-8444-444444444444'
        with self.assertRaises(Refused):
            self.channel.provider(frame)

    def test_unknown_rate_payload_refused(self):
        self.init()
        self.channel.client(self.request(2))
        frame = self.telemetry('rate_limit_event')
        frame['rate_limit_info']['unknown_control'] = 'synthetic'
        with self.assertRaises(Refused):
            self.channel.provider(frame)
