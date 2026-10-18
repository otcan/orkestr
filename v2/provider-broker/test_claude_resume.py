"""Owned synthetic processes only; no installed Claude or account access."""
import array
import copy
import json
import os
from pathlib import Path
import select
import socket
import tempfile
import unittest
import uuid
from claude_connector import ClaudeConfiguration
from claude_protocol import ClaudeChannel
from claude_resume import ResumeSpec, retire
from protocol import PROTOCOL, Refused, encode
from test_protocol import IDENTITY
from transport import Pump


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="claude-resume-synthetic-")
        root = Path(self.temp.name).resolve()
        native = root / "native"
        native.write_text('''#!/usr/bin/python3
import json,sys,uuid
flag="--resume" if "--resume" in sys.argv else "--session-id"
session=sys.argv[sys.argv.index(flag)+1]
print(json.dumps({"type":"system","subtype":"init","session_id":session}),flush=True)
value=json.loads(sys.stdin.readline())
print(json.dumps({"type":"result","subtype":"success","is_error":False,
"session_id":session,"uuid":str(uuid.uuid4()),"user_message_uuid":value["uuid"],
"result":"synthetic"}),flush=True)
''')
        native.chmod(0o700)
        self.config = ClaudeConfiguration(native, root, root, root, root)
        self.resources = []

    def tearDown(self):
        for pump, writer, parent in self.resources:
            try:
                if writer is not None:
                    os.close(writer)
            except OSError:
                pass
            parent.close()
            if pump.child.poll() is None:
                pump.child.kill()
            pump.child.wait(timeout=5)
            pump.child.stdout.close()
            pump.selector.close()
        self.temp.cleanup()

    def launch(self, session):
        channel = ClaudeChannel(session)
        channel.client({"id":1,"method":"OpenOwnedSession","params":{
            "protocol":PROTOCOL,"identity":dict(IDENTITY,provider="claude")}})
        parent, child = socket.socketpair()
        parent.settimeout(5)
        pump = Pump(session, channel, incoming=100, outgoing=101, handoff=child)
        pump.launch()
        _, ancillary, _, _ = parent.recvmsg(64,socket.CMSG_SPACE(4))
        descriptors = array.array("i"); descriptors.frombytes(ancillary[0][2])
        writer = descriptors[0]
        self.resources.append([pump, writer, parent])
        self.observe(pump, channel)
        return pump, channel, writer

    def observe(self, pump, channel):
        self.assertTrue(select.select([pump.child.stdout],[],[],5)[0])
        raw = os.read(pump.child.stdout.fileno(),65536)
        return channel.provider(json.loads(raw))

    def commit(self, channel, writer):
        key = str(uuid.uuid4())
        frame = {"type":"user","uuid":key,"session_id":channel.native,
            "parent_tool_use_id":None,"message":{"role":"user","content":"synthetic"}}
        channel.client({"id":2,"method":"CommitExecution","params":{
            "owned_handle":channel.handle,"message_id":"message:1","frame":frame}})
        os.write(writer,encode(frame))  # synthetic parent, not a Core fence claim
        return key

    def finish(self, pump, channel, writer):
        response = self.observe(pump,channel)
        os.close(writer)
        for resource in self.resources:
            if resource[0] is pump:
                resource[1] = None
        self.assertEqual(pump.child.wait(timeout=5),0)
        pump.child.stdout.close()
        return response["params"]["frame"]

    def test_fresh_pid_same_native_and_late_old_terminal_refused(self):
        first = self.config.new_session()
        pump, channel, writer = self.launch(first)
        self.commit(channel,writer)
        old = self.finish(pump,channel,writer)
        ticket = retire(first,channel,writer_closed=True,
            completion_accepted=lambda session,outer,terminal:
                session is first and outer == 2 and terminal == old["uuid"])
        with self.assertRaises(TypeError):
            copy.copy(ticket)
        resumed = self.config.resumed_session(ticket)
        self.assertEqual(first.native,resumed.native)
        self.assertIn("--resume",resumed.command())
        self.assertNotIn("--session-id",resumed.command())
        with self.assertRaises(Refused):
            self.config.resumed_session(ticket)
        next_pump, next_channel, next_writer = self.launch(resumed)
        self.assertNotEqual(pump.child.pid,next_pump.child.pid)
        self.commit(next_channel,next_writer)
        # Original terminal UUID and unseen old UUID must both refuse.
        for identifier in (old["uuid"],str(uuid.uuid4())):
            late = dict(old,uuid=identifier)
            with self.assertRaises(Refused):
                next_channel.provider(late)
        # A bad frame quarantines the channel; even a later valid result refuses.
        with self.assertRaises(Refused):
            self.observe(next_pump,next_channel)


    def test_new_process_correlated_terminal_succeeds(self):
        first = self.config.new_session()
        pump,channel,writer = self.launch(first)
        self.commit(channel,writer)
        self.finish(pump,channel,writer)
        ticket = retire(first,channel,writer_closed=True,completion_accepted=lambda *_:True)
        resumed = self.config.resumed_session(ticket)
        pump2,channel2,writer2 = self.launch(resumed)
        key = self.commit(channel2,writer2)
        output = self.finish(pump2,channel2,writer2)
        self.assertEqual(output["user_message_uuid"],key)
        self.assertEqual(first.native,resumed.native)
        self.assertNotEqual(pump.child.pid,pump2.child.pid)

    def test_resumed_unbound_or_late_assistant_is_not_relabelled(self):
        from types import SimpleNamespace
        for extra in ({}, {"user_message_uuid":str(uuid.uuid4())}):
            session = SimpleNamespace(native=uuid.uuid4(),resumed=True)
            channel = ClaudeChannel(session)
            channel.client({"id":1,"method":"OpenOwnedSession","params":{
                "protocol":PROTOCOL,"identity":dict(IDENTITY,provider="claude")}})
            channel.provider({"type":"system","subtype":"init","session_id":str(session.native)})
            key = str(uuid.uuid4())
            channel.client({"id":2,"method":"CommitExecution","params":{
                "owned_handle":channel.handle,"message_id":"message:1","frame":{
                    "type":"user","uuid":key,"session_id":str(session.native),
                    "parent_tool_use_id":None,"message":{"role":"user","content":"synthetic"}}}})
            for kind in ("assistant", "result"):
                with self.assertRaises(Refused):
                    channel.provider(dict({"type":kind,"session_id":str(session.native),
                        "uuid":str(uuid.uuid4()),"message":{"role":"assistant","content":[
                            {"type":"text","text":"late historical output"}]},
                        "subtype":"success","is_error":False,"result":"late"},**extra))
            self.assertTrue(channel.poisoned)

    def test_no_ticket_before_terminal_or_owner_acceptance(self):
        session = self.config.new_session()
        pump,channel,writer = self.launch(session)
        with self.assertRaises(Refused):
            retire(session,channel,writer_closed=True,completion_accepted=lambda *_:True)
        self.commit(channel,writer)
        self.finish(pump,channel,writer)
        with self.assertRaises(Refused):
            retire(session,channel,writer_closed=False,completion_accepted=lambda *_:True)
        with self.assertRaises(Refused):
            retire(session,channel,writer_closed=True,completion_accepted=lambda *_:False)
        with self.assertRaises(Refused):
            retire(session,channel,writer_closed=True,completion_accepted=lambda *_:True)

    def test_json_or_unsealed_ticket_cannot_select_session(self):
        with self.assertRaises(ValueError):
            self.config.resumed_session({"native":str(uuid.uuid4())})
        with self.assertRaises(Refused):
            ResumeSpec(None,self.config,uuid.uuid4())
