import test from 'node:test';
import assert from 'node:assert/strict';
import {quotaCards, providerQuotaRequest} from '../src/provider_quota.mjs';
const now = Date.parse('2026-01-01T12:00:00Z');
const q = {fiveHourRemainingPct:75,weeklyRemainingPct:0,fiveHourResetsAt:'2026-01-01T13:00:00Z',weeklyResetsAt:'2026-01-03T12:00:00Z',observedAt:'2026-01-01T11:59:00Z',stale:false,limited:false};
test('reported windows retain zero quota and reset times, stripping private metadata',()=>{
 const cards=quotaCards({quota:{codex:{...q,account_ref:'private'},claude:q}},now);
 assert.equal(cards.length,2);assert.equal(cards[0].name,'OpenAI / Codex');assert.equal(cards[0].label,'5h 75% · week 0%');assert.equal(cards[0].status,'current');assert.match(cards[0].detail,/resets in 1h 0m/);assert.equal(JSON.stringify(cards).includes('private'),false);
});
test('absent short windows are omitted; weekly-only accounts never show synthetic 5h limits',()=>{
 const [card]=quotaCards({quota:{codex:{...q,fiveHourRemainingPct:null,fiveHourResetsAt:null}}},now);
 assert.equal(card.label,'week 0%');assert.doesNotMatch(JSON.stringify(card),/5h|\?/);
});
test('status-only Claude telemetry survives without invented numbers or login inference',()=>{
 const [,card]=quotaCards({quota:{claude:{weeklyStatus:'allowed',observedAt:q.observedAt}}},now);
 assert.equal(card.label,'week available');assert.equal(card.status,'current');assert.doesNotMatch(card.label,/%|\?|5h/);
 const [,missing]=quotaCards({quota:{claude:{connected:true}}},now);
 assert.equal(missing.label,'Quota unavailable');assert.match(missing.detail,/connection is separate/);
 for(const [status,label] of [['allowed_warning','near limit'],['rejected','limited']]){
  const entry=quotaCards({quota:{claude:{weeklyStatus:status,observedAt:q.observedAt}}},now)[1];assert.equal(entry.label,`week ${label}`);
 }
});
test('stale/limited are separate and producer freshness policy is respected',()=>{
 const cards=quotaCards({quota:{codex:{...q,observedAt:'2026-01-01T01:00:00Z',limited:true}}},now);
 assert.equal(cards[0].status,'stale · limited');assert.equal(cards[1].status,'unavailable');
 assert.equal(quotaCards({quota:{codex:q},staleAfterMs:30000},now)[0].status,'stale');
 assert.equal(quotaCards({quota:{codex:q},staleAfterMs:604800001},now)[0].status,'current');
});
test('expired, invalid and unverified observations never appear as current quota',()=>{
 for(const patch of [{observedAt:null},{observedAt:'2026-01-02T00:00:00Z'},{fiveHourRemainingPct:'75',weeklyRemainingPct:101}]){
  const card=quotaCards({quota:{codex:{...q,...patch}}},now)[0];assert.equal(card.status,'unavailable');assert.equal(card.label,'Quota unavailable');assert.doesNotMatch(card.label,/\?/);
 }
 const [expired]=quotaCards({quota:{codex:{...q,fiveHourResetsAt:'2026-01-01T11:00:00Z',weeklyResetsAt:'2026-01-01T12:00:00Z'}}},now);
 assert.equal(expired.status,'expired');assert.equal(expired.label,'Telemetry expired');
});
test('fixed passive cookie-only path, bounded response, malformed replies clear old values',async()=>{
 const cards=await providerQuotaRequest(undefined,async(path,options)=>{assert.equal(path,'/api/v2/provider-quotas');assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');return new Response(JSON.stringify({quota:{codex:q}}));},()=>now);
 assert.equal(cards.cards[0].status,'current');
 for(const body of ['x'.repeat(17000),'not json']){const result=await providerQuotaRequest(undefined,async()=>new Response(body),()=>now);assert.equal(result.status,0);assert.equal(result.cards[0].status,'unavailable');}
 const denied=await providerQuotaRequest(undefined,async()=>new Response('',{status:401}),()=>now);assert.equal(denied.status,401);
});
test('one expired window does not hide a valid one or make it fresh',()=>{
 const [card]=quotaCards({quota:{codex:{...q,fiveHourResetsAt:'2026-01-01T12:00:00Z',observedAt:'2026-01-01T01:00:00Z'}}},now);
 assert.equal(card.label,'week 0%');assert.equal(card.status,'stale');assert.equal(card.reset,'week resets in 2d 0h');assert.match(card.detail,/expired observation/);
});
test('reset countdown updates from passive time only',()=>{
 const snapshot={quota:{codex:q}};
 assert.equal(quotaCards(snapshot,now)[0].reset,'5h resets in 1h 0m · week resets in 2d 0h');
 const later=quotaCards(snapshot,now+30*60*1000)[0];assert.equal(later.reset,'5h resets in 30m · week resets in 1d 23h');assert.equal(later.label,'5h 75% · week 0%');
});
