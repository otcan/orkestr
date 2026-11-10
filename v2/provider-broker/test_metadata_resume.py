"""Closed metadata resume is local binding, never execution authority."""
import unittest
from protocol import Channel, Refused
from test_protocol import IDENTITY, PROTOCOL, request


class MetadataResumeTests(unittest.TestCase):
    def channel(self, expected="synthetic-native"):
        channel = Channel("/synthetic/workspace", expected_native=expected)
        channel.client({"id":1,"method":"OpenOwnedSession","params":{
            "protocol":PROTOCOL,"identity":IDENTITY}})
        channel.stage = "subscription"  # account/read contract tested separately
        return channel

    def frame(self):
        return {"id":3,"method":"thread/resume","params":{
            "threadId":"synthetic-native","cwd":"/synthetic/workspace",
            "approvalPolicy":"never","sandbox":"read-only","modelProvider":"openai"}}

    def reply(self):
        return {"id":3,"result":{"thread":{"id":"synthetic-native",
            "cwd":"/synthetic/workspace","ephemeral":False,"modelProvider":"openai"},
            "cwd":"/synthetic/workspace","approvalPolicy":"never","modelProvider":"openai",
            "sandbox":{"type":"readOnly","networkAccess":False}}}

    def test_exact_resume_then_duplicate_reply_refuses(self):
        channel=self.channel()
        frame=self.frame()
        self.assertEqual(request(channel,frame)[0],frame)
        channel.provider(self.reply())
        self.assertEqual(channel.native,"synthetic-native")
        self.assertFalse(channel.committed)
        with self.assertRaises(Refused):channel.provider(self.reply())

    def test_no_fresh_fallback_or_client_selected_native(self):
        for field,value in (("threadId","foreign"),("cwd","/foreign"),
                            ("modelProvider","external"),("ephemeral",False),
                            ("sandbox","danger-full-access")):
            channel=self.channel();frame=self.frame();frame["params"][field]=value
            with self.subTest(field=field), self.assertRaises(Refused):request(channel,frame)
        with self.assertRaises(Refused):request(self.channel(None),self.frame())
        frame=self.frame();frame["method"]="thread/start";del frame["params"]["threadId"]
        frame["params"]["ephemeral"]=False
        with self.assertRaises(Refused):request(self.channel(),frame)

    def test_reply_binding_policy_mismatch_refuses(self):
        for field,value in (("id","foreign"),("cwd","/foreign"),
                            ("modelProvider","external"),("ephemeral",True)):
            channel=self.channel();request(channel,self.frame());reply=self.reply()
            reply["result"]["thread"][field]=value
            with self.subTest(field=field),self.assertRaises(Refused):channel.provider(reply)
