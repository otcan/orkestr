import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveryMode } from './headless-beta.mjs';
const blocked = { code: 'beta_unconfigured', message: 'Beta execution is not configured', request_id: 'synthetic', retryable: false };
const configured = { schema_version: 1, provider: 'codex', role: 'deep', conversation_id: '00000000-0000-4000-8000-000000000002', controls: {stop:false,steer:false,accept:false}, limits: {duration_ms:900000,attempts:32,bytes:67108864,cleanup_ms:30000,cleanup_attempts:4,cleanup_bytes:1048576},window:null };
test('only exact structured unconfigured response permits blocked-shell checks', () => {
  assert.deepEqual(discoveryMode(404, blocked), {kind:'unconfigured'});
  for (const [status,body] of [[404,{}],[401,blocked],[403,blocked],[503,blocked],[0,null],[200,blocked],[404,{...blocked,retryable:true}]]) assert.throws(()=>discoveryMode(status,body));
});
test('configured discovery retains exact scope and rejects malformed or foreign window', () => {
  assert.equal(discoveryMode(200,configured).conversation,configured.conversation_id);
  for(const body of [{...configured,role:'worker'},{...configured,conversation_id:'00000000-0000-0000-0000-000000000000'},{...configured,window:{conversation_id:'foreign'}},{...configured,limits:{}}]) assert.throws(()=>discoveryMode(200,body));
});
