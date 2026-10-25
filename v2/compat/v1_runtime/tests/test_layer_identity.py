"""Metadata joins remain original-input scoped and frozen across retries."""
import unittest
from v2.compat.v1_runtime.layer_identity import attach_scope, post_identity
from v2.compat.v1_runtime.tests.test_conversation_posts import post
from v2.compat.v1_runtime.tests.test_timer_relay import Base

PUBLIC='10000000-0000-4000-8000-000000000001'
OTHER='20000000-0000-4000-8000-000000000002'

class LayerTests(Base):
    def owner(self, public=PUBLIC):
        return self.ledger.enqueue(dict(publicThreadId='v1-thread',publicMessageId=public,chatId='chat@g.us',accountId='account',text='Original synthetic request'))[0]

    def test_post_preserves_own_identity_and_links_exact_original_not_latest_input(self):
        original=self.owner();later=self.owner(OTHER)
        reply,_=self.ledger.enqueue_post(post(request_key='coordinator-input:'+PUBLIC+':answer'), {'provider':'codex','model':'native-wrong'})
        self.assertEqual((reply['provider'],reply['model'],reply['layer'],reply['identitySource']),('claude','synthetic-model','coordinator','post'))
        self.assertEqual(reply['sourceInputId'],original['remote_id'])
        self.assertNotEqual(reply['sourceInputId'],later['remote_id'])
        again,existed=self.ledger.enqueue_post(post(request_key='coordinator-input:'+PUBLIC+':answer'), {'provider':'codex','model':'changed-wrong'})
        self.assertTrue(existed);self.assertEqual(again,reply)

    def test_foreign_or_legacy_post_never_infers_original_from_sequence_or_text(self):
        self.owner()
        for key in ['coordinator-input:'+OTHER+':answer','legacy-timestamp-key','coordinator-input:invalid:answer']:
            with self.ledger.connect() as db:
                self.assertNotIn('sourceInputId',post_identity(db,post(request_key=key)))

    def test_fast_pseudo_parent_preserves_original_scope_and_observed_effort(self):
        original=self.owner();message=dict(layer='fast',provider='codex',model='mini-example',observedReasoningEffort='low')
        attach_scope(message,dict(remote_id=OTHER,first_response_for=dict(input_id=original['remote_id'])))
        self.assertEqual(message['sourceInputId'],original['remote_id'])
        attach_scope(message,dict(remote_id=OTHER))
        self.assertEqual(message['sourceInputId'],original['remote_id'])

    def test_unlinked_post_is_never_linked_to_its_pseudo_parent(self):
        reply={};attach_scope(reply,dict(remote_id=OTHER,post=dict(id='synthetic-post')))
        self.assertNotIn('sourceInputId',reply)
