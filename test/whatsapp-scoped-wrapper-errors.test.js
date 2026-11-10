import assert from 'node:assert/strict';
import test from 'node:test';
import {wrapperErrorCode,wrapperRejection,sendWithQuoteFallback} from '../packages/connectors/src/whatsapp-scoped-wrapper-errors.js';
import {scopedRelayErrorCode} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';
const failure=code=>({message:'Command failed: /secret/argv private-body',stderr:'diagnostic prefix\n'+JSON.stringify({ok:false,error:code})+'\n'});

test('relay extracts only bounded closed last-line wrapper code, never argv/stdout/raw error',()=>{
  const e=failure('delivery_route_delivery_unresolved');
  assert.equal(wrapperErrorCode(e),'delivery_route_delivery_unresolved');
  assert.equal(scopedRelayErrorCode(e),'delivery_route_delivery_unresolved');
  for(const stderr of ['private-token',JSON.stringify({ok:false,error:'private_secret'}),
    JSON.stringify({ok:false,error:'delivery_route_delivery_unresolved',token:'secret'}),
    'x'.repeat(65537)+'\n'+JSON.stringify({ok:false,error:'delivery_route_delivery_unresolved'}),
    JSON.stringify({ok:false,error:'delivery_route_delivery_unresolved'})+'\nnot-json']) {
    assert.equal(scopedRelayErrorCode({...e,stderr,stdout:'secret'}),'operation_failed');
  }
});

test('only proven pre-dispatch codes are definitive, old overloaded fences and provider ambiguity are not',()=>{
  for(const code of ['group_transport_configuration_changed','delivery_route_blocked_before_reservation'])
    assert.equal(wrapperRejection(failure(code)).definitive,true);
  for(const code of ['delivery_route_delivery_unresolved','delivery_route_attempt_unresolved','group_transport_delivery_uncertain',
    'whatsapp_worker_timeout','timer_notification_proof_denied'])assert.equal(wrapperRejection(failure(code)).definitive,false);
});

test('unquoted denial cannot erase an earlier ambiguous quoted provider attempt',async()=>{
  let calls=0;
  await assert.rejects(sendWithQuoteFallback(async()=>{throw failure(++calls===1?'group_transport_delivery_uncertain':'group_transport_configuration_changed');},'quoted'),
    e=>e.message==='group_transport_delivery_uncertain' && e.definitive===false);
  assert.equal(calls,2);
  calls=0;
  await assert.rejects(sendWithQuoteFallback(async()=>{throw failure(++calls===1?'scoped_reply_invalid':'delivery_route_blocked_before_reservation');},'quoted'),
    e=>e.message==='delivery_route_blocked_before_reservation' && e.definitive===true);
});
