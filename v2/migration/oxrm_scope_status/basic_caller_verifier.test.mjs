import test from 'node:test';
import assert from 'node:assert/strict';
import { createBasicCallerVerifier } from './basic_caller_verifier.ts';
const authorization = 'Basic ' + Buffer.from('demo:fake-password').toString('base64');
const request = { headers: { authorization }, raw: { rawHeaders: ['Authorization', authorization] } };
const authority = { enabled: true, revision: 'revision-demo', username: 'demo', passwordHash: '$2b$12$'+'a'.repeat(53), principal: { subject: 'demo', scope: { outreachWorkspaceId: 'workspace-demo', linkedinAccountAlias: 'account-demo' }, canReadScopeStatus: true } };
test('disabled default never trusts Basic header', async () => assert.equal(await createBasicCallerVerifier()(request), null));
test('explicit current authority and password backend required', async () => {
 let calls=0;
 const verify=createBasicCallerVerifier({current:async()=>authority,verifyPassword:async(p,h)=>{calls++;assert.equal(p,'fake-password');assert.equal(h,authority.passwordHash);return true;}});
 assert.deepEqual(await verify(request),authority.principal);assert.equal(calls,1);
});
test('wrong password and revoked authority refuse', async () => {
 assert.equal(await createBasicCallerVerifier({current:async()=>authority,verifyPassword:async()=>false})(request),null);
 let n=0;
 assert.equal(await createBasicCallerVerifier({current:async()=>++n===1?authority:null,verifyPassword:async()=>true})(request),null);
});
test('rotation or scope change during bcrypt check refuses', async () => {
 for(const change of [{revision:'next-demo'},{principal:{...authority.principal,subject:'other-demo'}}]) {
 let n=0;assert.equal(await createBasicCallerVerifier({current:async()=>++n===1?authority:{...authority,...change},verifyPassword:async()=>true})(request),null);
 }
});
test('duplicate authorization and malformed encoding refuse before backend', async () => {
 const verify=createBasicCallerVerifier({current:async()=>{throw Error('must not read');},verifyPassword:async()=>{throw Error('must not verify');}});
 assert.equal(await verify({...request,raw:{rawHeaders:[...request.raw.rawHeaders,...request.raw.rawHeaders]}}),null);
 assert.equal(await verify({headers:{authorization:'Basic !!!!'},raw:request.raw}),null);
});
