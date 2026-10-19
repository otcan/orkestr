"""One native reader/current input/API response; no omission without its anchor."""
import copy
import unittest
import uuid
import test_claude_control as control
import test_claude_protocol as protocol
from protocol import Refused


class AssistantInputTests(unittest.TestCase):
    def setUp(self):
        self.fixture=control.ClaudeControlTests();self.fixture.setUp();self.channel=self.fixture.channel

    def frame(self, *, first=False, thinking=False):
        content=[{'type':'thinking','thinking':'synthetic-private','signature':''}] if thinking else [
            {'type':'text','text':'genuine synthetic text','citations':None}]
        frame={'type':'assistant','session_id':self.channel.native,'uuid':str(uuid.uuid4()),
               'request_id':'synthetic-request','timestamp':'2026-01-01T00:00:00Z',
               'message':{'id':'synthetic-api-message','type':'message','role':'assistant','content':content}}
        if first:frame.update(user_message_uuid=self.channel.input_uuid,user_message_uuids=[self.channel.input_uuid])
        return frame

    def anchor(self):
        frame=self.frame(first=True,thinking=True)
        self.assertIsNone(self.channel.provider(frame));return frame

    def reject_after_anchor(self, change):
        self.setUp();self.anchor();frame=self.frame();change(frame)
        with self.assertRaises((Refused,TypeError,ValueError)):self.channel.provider(frame)
        self.assertFalse(self.channel.terminal)
        self.assertEqual(self.channel.output_uuids,set())

    def test_source_proven_omission_same_response_after_explicit_first(self):
        first=self.anchor();later=self.frame();before=copy.deepcopy(later)
        output=self.channel.provider(later)['params']['frame']
        self.assertEqual(output['user_message_uuid'],self.channel.input_uuid)
        self.assertEqual(output['message']['content'],[{'type':'text','text':'genuine synthetic text'}])
        self.assertEqual(later,before)
        self.assertNotIn('synthetic-private',str(output))
        self.assertEqual(len(self.channel.assistant_input.events),2)
        self.assertIn(first['uuid'],self.channel.telemetry_uuids)

    def test_unanchored_missing_id_or_invalid_first_cannot_establish_binding(self):
        with self.assertRaises(Refused):self.channel.provider(self.frame())
        self.setUp();frame=self.frame(first=True,thinking=True)
        frame['message']['content'].append({'type':'tool_use','id':'fake','name':'fake','input':{}})
        with self.assertRaises(Refused):self.channel.provider(frame)
        self.assertIsNone(self.channel.assistant_input.response)
        self.assertEqual(self.channel.assistant_input.events,set())
        self.setUp();frame=self.frame(first=True,thinking=True);frame['message'].pop('id')
        self.assertIsNone(self.channel.provider(frame))
        with self.assertRaises(Refused):self.channel.provider(self.frame())

    def test_foreign_scope_request_or_history_cannot_borrow_anchor(self):
        changes=[lambda f:f.update(session_id=str(uuid.uuid4())),
                 lambda f:f.update(user_message_uuid=str(uuid.uuid4())),
                 lambda f:f.update(user_message_uuids=[self.channel.input_uuid]),
                 lambda f:f['message'].update(id='different-api-message'),
                 lambda f:f['message'].pop('id'),lambda f:f.update(request_id='different-request'),
                 lambda f:f.pop('request_id'),lambda f:f.update(parent_tool_use_id='tool'),
                 lambda f:f.update(historical=True),lambda f:f.update(isReplay=True),
                 lambda f:f.update(agent_id='other-agent')]
        for change in changes:self.reject_after_anchor(change)

    def test_request_absence_is_fixed_and_cannot_be_upgraded(self):
        first=self.frame(first=True,thinking=True);first.pop('request_id')
        self.assertIsNone(self.channel.provider(first))
        later=self.frame();later.pop('request_id')
        self.assertIsNotNone(self.channel.provider(later))
        with self.assertRaises(Refused):self.channel.provider(self.frame())

    def test_events_replay_bounds_and_terminal_identity_cannot_be_borrowed(self):
        first=self.anchor()
        frame=self.frame();frame['uuid']=first['uuid']
        with self.assertRaises(Refused):self.channel.provider(frame)
        self.setUp();self.anchor();self.channel.assistant_input.events.update(str(uuid.uuid4()) for _ in range(127))
        with self.assertRaises(Refused):self.channel.provider(self.frame())
        self.setUp();self.anchor();frame=self.frame();self.channel.provider(frame)
        terminal=self.fixture.terminal();terminal['uuid']=frame['uuid']
        with self.assertRaises(Refused):self.channel.provider(terminal)
        self.assertFalse(self.channel.terminal)

    def test_new_child_has_no_anchor_even_when_native_session_is_resumed(self):
        old=self.anchor();later=self.frame()
        fresh=protocol.ClaudeProtocolTests();fresh.setUp();fresh.init()
        request=fresh.request(2);request['params']['frame']['uuid']=str(uuid.uuid4())
        fresh.channel.client(request)
        fresh.channel.provider({'type':'system','subtype':'init','session_id':fresh.native})
        with self.assertRaises(Refused):fresh.channel.provider(later)
        self.assertIsNone(fresh.channel.assistant_input.response)
        self.assertNotEqual(fresh.handle,self.fixture.fixture.handle)
        self.assertNotEqual(old['user_message_uuid'],fresh.channel.input_uuid)

    def test_second_input_result_omission_and_postterminal_still_refuse(self):
        self.anchor()
        with self.assertRaises(Refused):self.channel.client(self.fixture.fixture.request(9,'another-input'))
        terminal=self.fixture.terminal();terminal.pop('user_message_uuid')
        with self.assertRaises(Refused):self.channel.provider(terminal)
        self.assertFalse(self.channel.terminal)
        self.setUp();self.anchor();self.channel.client(self.fixture.request())
        self.channel.provider(self.fixture.ack());self.channel.provider(self.fixture.terminal())
        with self.assertRaises(Refused):self.channel.provider(self.frame())

    def test_cancel_omitted_late_output_is_discard_only_and_ack_is_not_terminal(self):
        self.anchor();self.channel.client(self.fixture.request())
        self.assertIsNone(self.channel.provider(self.frame()))
        self.assertFalse(self.channel.control.ack or self.channel.terminal)
        self.channel.provider(self.fixture.ack());self.assertFalse(self.channel.terminal)
        self.channel.provider(self.fixture.terminal());self.assertTrue(self.channel.terminal)


if __name__=='__main__':unittest.main()
