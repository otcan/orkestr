import assert from 'node:assert/strict';
import test from 'node:test';
import { ownerSelfChatFailureCode, startOwnerSelfChatPolling } from '../packages/connectors/src/whatsapp-owner-selfchat-runtime.js';
import { createOwnerSelfChatWrapper } from '../packages/connectors/src/whatsapp-owner-selfchat-wrapper.js';

test('server integration is entirely inert without an explicit private config path',async()=>{
  const result=await startOwnerSelfChatPolling({}, {readConfig:()=>{throw new Error('should not read');}});
  assert.equal(result.enabled,false);result.close();
});

test('bad private config pauses only this integration, not the server',async()=>{
  const errors=[];
  const result=await startOwnerSelfChatPolling({ORKESTR_OWNER_SELFCHAT_CONFIG:'/unused'},
    {readConfig:async()=>{throw new Error('denied');},onError:error=>errors.push(error.message)});
  assert.equal(result.enabled,false);assert.deepEqual(errors,['denied']);
});

test('malformed scope is disabled before any polling or wrapper invocation',async()=>{
  const errors=[];
  const result=await startOwnerSelfChatPolling({ORKESTR_OWNER_SELFCHAT_CONFIG:'/unused'},
    {readConfig:async()=>({scope:{enabled:true}}),onError:error=>errors.push(error.message)});
  assert.equal(result.enabled,false);assert.deepEqual(errors,['selfchat_transport_not_configured']);
});

test('wrapper cannot run without existing runtime and implementation preconditions',()=>{
  assert.throws(()=>createOwnerSelfChatWrapper({}),/wrapper_preconditions_required/);
});

test('pause diagnostics retain a bounded error code without provider payloads',()=>{
  assert.equal(ownerSelfChatFailureCode(new Error('selfchat_identity_or_eligibility_unverified')),
    'selfchat_identity_or_eligibility_unverified');
  for(const message of ['provider error with private text','selfchat_error\nprivate payload',
    `selfchat_${'a'.repeat(97)}`]) {
    assert.equal(ownerSelfChatFailureCode(new Error(message)),'selfchat_unexpected_error');
  }
  assert.equal(ownerSelfChatFailureCode(null),'selfchat_unexpected_error');
});
