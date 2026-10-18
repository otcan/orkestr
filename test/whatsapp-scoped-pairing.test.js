import test from 'node:test';
import assert from 'node:assert/strict';
import {createScopedPairingPermit} from '../packages/connectors/src/whatsapp-scoped-pairing.js';
import {createScopedNativeWorkerPolicy,createPreservingNativeAuth} from '../packages/connectors/src/whatsapp-scoped-native-worker.js';
const at=Date.parse('2026-01-01T00:00:00Z');
const config={workerAccountId:'fixture',ownChatId:'15550000001@c.us',groups:[{threadId:'home',chatId:'120000000001@g.us'}],routeControl:{threadId:'home'},pairingAttempt:{issuedAt:new Date(at).toISOString(),expiresAt:new Date(at+600000).toISOString()}};
const url=new URL('http://local/accounts/fixture/start-phone');
const body={phoneNumber:'15550000001',showNotification:false,intervalMs:1800000};
test('pairing requires a live, bounded operator permit and the exact existing account number',()=>{
 let time=at;const p=createScopedPairingPermit(config,{now:()=>time});
 assert.equal(p.allowsAuthentication(),false);
 assert.equal(p.requestAllowed('POST',url),true);
 assert.equal(p.requestAllowed('POST',url,body),true);
 for(const patch of [{phoneNumber:'15550000002'},{resetRuntime:true},{showNotification:true},{intervalMs:180000}])assert.equal(p.requestAllowed('POST',url,{...body,...patch}),false);
 for(const path of ['/send-text','/accounts/fixture/logout','/accounts/other/start-phone'])assert.equal(p.requestAllowed('POST',new URL(path,url),body),false);
 p.claim(body.phoneNumber);assert.equal(p.allowsAuthentication(),true);assert.throws(()=>p.claim(body.phoneNumber));
 time+=600000;assert.equal(p.allowsAuthentication(),false);assert.equal(p.requestAllowed('POST',url,body),false);
});
test('absent, expired, future and excessively long grants fail closed',()=>{
 for(const attempt of [undefined,{issuedAt:new Date(at+1).toISOString(),expiresAt:new Date(at+1000).toISOString()},{issuedAt:new Date(at).toISOString(),expiresAt:new Date(at+1800001).toISOString()},config.pairingAttempt]){
  const now=attempt===config.pairingAttempt?at+600000:at;
  const p=createScopedPairingPermit({...config,pairingAttempt:attempt},{now:()=>now});assert.equal(p.requestAllowed('POST',url,body),false);assert.throws(()=>p.claim(body.phoneNumber));
 }
});
test('authentication permission never authorizes logout or a second registration attempt',async()=>{
 class Base{async logout(){throw new Error('should_not_reach');}}
 let permitted=false;const auth=new (createPreservingNativeAuth(Base,{allowPairing:()=>permitted}))();
 assert.equal((await auth.onAuthenticationNeeded()).failed,true);permitted=true;
 assert.deepEqual(await auth.onAuthenticationNeeded(),{failed:false,restart:false,failureEventPayload:'scoped_worker_existing_authentication_required'});
 await assert.rejects(auth.logout(),/logout_blocked/);
 const p=createScopedNativeWorkerPolicy(config);assert.throws(()=>p.checkRequest('POST',url,body),/denied/);
});
