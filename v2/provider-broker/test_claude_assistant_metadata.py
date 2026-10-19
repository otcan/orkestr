"""Thinking metadata has no progress, cancellation, replay or text authority."""
import json
import unittest
import uuid
import test_claude_control as control
from protocol import Refused


class AssistantMetadataTests(unittest.TestCase):
    def setUp(self):
        self.fixture = control.ClaudeControlTests(); self.fixture.setUp()
        self.channel = self.fixture.channel

    def frame(self, blocks=None):
        if blocks is None:
            blocks = [{'type': 'thinking', 'thinking': 'synthetic-private-thought',
                       'signature': 'synthetic-private-signature'}]
        return {'type': 'assistant', 'session_id': self.channel.native,
                'user_message_uuid': self.channel.input_uuid, 'uuid': str(uuid.uuid4()),
                'message': {'role': 'assistant', 'content': blocks}}

    def refused(self, mutate):
        self.setUp(); frame = self.frame(); mutate(frame)
        with self.assertRaises((Refused, ValueError, TypeError, OverflowError)):
            self.channel.provider(frame)
        self.assertTrue(self.channel.poisoned)
        self.assertFalse(self.channel.terminal)
        self.assertEqual(self.channel.output_uuids, set())

    def test_metadata_only_never_returns_an_observation_or_thought_content(self):
        for block in ({'type':'thinking','thinking':'synthetic-thought','signature':''},
                      {'type':'redacted_thinking','data':'synthetic-data'}):
            frame = self.frame([block])
            self.assertIsNone(self.channel.provider(frame))
            self.assertIn(frame['uuid'], self.channel.telemetry_uuids)
            self.assertFalse(self.channel.terminal or self.channel.output_uuids)
            self.assertIsNone(self.channel.control)

    def test_mixed_whole_frame_emits_only_genuine_text(self):
        frame = self.frame()
        frame['message'].update(id='synthetic-api-message',type='message',model='synthetic-model',
            stop_reason=None,usage={'input_tokens':1},diagnostics=None,container=None)
        frame['message']['content'] += [{'type':'text','text':'genuine synthetic text','citations':None},
                                       {'type':'redacted_thinking','data':'synthetic-private-data'}]
        frame.update(narration_block_indexes=[0],narration_hint='faint',thinking_duration_ms=3)
        result = self.channel.provider(frame)
        clean = result['params']['frame']
        self.assertEqual(clean['message']['content'],[{'type':'text','text':'genuine synthetic text'}])
        self.assertEqual(clean['user_message_uuid'], self.channel.input_uuid)
        for forbidden in ('thought','signature','synthetic-private','model','usage','narration'):
            self.assertNotIn(forbidden,json.dumps(result))
        self.assertFalse(self.channel.terminal)

    def test_complete_validation_before_text_tool_unknown_or_malformed_refusal(self):
        for bad in ({'type':'tool_use','id':'synthetic','name':'tool','input':{}},
                    {'type':'unknown','content':'synthetic'},
                    {'type':'thinking','thinking':'secret'},
                    {'type':'thinking','thinking':{},'signature':''},
                    {'type':'redacted_thinking','data':'opaque','extra':True}):
            self.refused(lambda f,b=bad: f['message']['content'].extend([
                {'type':'text','text':'must not emit'},b]))
        self.refused(lambda f:f.update(provider_auth='forbidden'))
        self.refused(lambda f:f['message'].update(role='user'))
        self.refused(lambda f:f['message'].update(stop_reason='tool_use'))
        self.refused(lambda f:f.update(historical=True))

    def test_exact_current_identity_and_shared_replay_bound(self):
        for field in ('uuid','session_id','user_message_uuid'):
            self.refused(lambda f,k=field:f.pop(k))
        for field in ('session_id','user_message_uuid'):
            self.refused(lambda f,k=field:f.update({k:str(uuid.uuid4())}))
        self.refused(lambda f:f.update(uuid=str(uuid.UUID(int=0))))
        self.refused(lambda f:f.update(user_message_uuids=[]))
        self.refused(lambda f:f.update(parent_tool_use_id='foreign-tool'))
        self.setUp();frame=self.frame();self.channel.provider(frame)
        with self.assertRaises(Refused):self.channel.provider(frame)
        self.setUp();self.channel.telemetry_uuids.update(str(uuid.uuid4()) for _ in range(128))
        with self.assertRaises(Refused):self.channel.provider(self.frame())
        self.setUp();frame=self.frame();self.channel.output_uuids.add(frame['uuid'])
        with self.assertRaises(Refused):self.channel.provider(frame)

    def test_metadata_size_and_shape_bounds(self):
        for field in ('thinking','signature'):
            self.refused(lambda f,k=field:f['message']['content'][0].update({k:'x'*8193}))
        self.refused(lambda f:f['message']['content'].extend([{'type':'text','text':'x'*4097}]*2))
        self.refused(lambda f:f['message'].update(content=f['message']['content']*129))
        for indexes in ([True],[1],[0,0],[-1]):
            self.refused(lambda f,v=indexes:f.update(narration_block_indexes=v))
        for value in (True,-1,float('nan'),2**53):
            self.refused(lambda f,v=value:f.update(thinking_duration_ms=v))
        self.refused(lambda f:f['message']['content'].append({'type':'text','text':'safe','citations':[{}]}))

    def test_before_init_after_terminal_and_cancel_fences_remain(self):
        self.channel.system_seen=False
        with self.assertRaises(Refused):self.channel.provider(self.frame())
        self.setUp();self.channel.client(self.fixture.request())
        frame=self.frame();frame['message']['content'].append({'type':'text','text':'late text'})
        self.assertIsNone(self.channel.provider(frame))
        self.assertFalse(self.channel.control.ack or self.channel.terminal)
        self.assertEqual(self.channel.control.notices,1)
        self.channel.provider(self.fixture.ack());self.assertFalse(self.channel.terminal)
        self.channel.provider(self.fixture.terminal());terminal=self.channel.terminal_uuid
        with self.assertRaises(Refused):self.channel.provider(self.frame())
        self.assertEqual(self.channel.terminal_uuid,terminal)

    def test_subsequent_unstamped_text_is_still_refused_not_relabelled(self):
        # Pinned native SDK stamps only its first assistant frame. This leaf does
        # not invent correlation for later frames: a separate port is required.
        self.assertIsNone(self.channel.provider(self.frame()))
        frame=self.frame([{'type':'text','text':'unbound subsequent text'}])
        frame.pop('user_message_uuid')
        with self.assertRaises(Refused):self.channel.provider(frame)
        self.assertFalse(self.channel.terminal or self.channel.output_uuids)


if __name__ == '__main__':unittest.main()
