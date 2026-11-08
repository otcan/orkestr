import test from 'node:test';
import assert from 'node:assert/strict';
import {quotaCards} from '../src/provider_quota.mjs';
const now = Date.parse('2026-01-01T12:00:00Z');
const q = {fiveHourRemainingPct:75,weeklyRemainingPct:0,fiveHourResetsAt:'2026-01-01T13:00:00Z',weeklyResetsAt:'2026-01-03T12:00:00Z',observedAt:'2026-01-01T11:59:00Z',stale:false,limited:false};
test('both providers show remaining windows and reset times without leaking extra metadata',()=>{
 const cards=quotaCards({quota:{codex:{...q,account_ref:'private'},claude:q}},now);
 assert.equal(cards.length,2);assert.equal(cards[0].name,'OpenAI / Codex');assert.equal(cards[0].label,'5h 75% · wk 0%');assert.equal(cards[0].status,'current');assert.match(cards[0].detail,/resets in 1h 0m/);assert.equal(JSON.stringify(cards).includes('private'),false);
});
test('stale remains explicitly stale, limited is separate, and missing provider is unavailable',()=>{
 const cards=quotaCards({quota:{codex:{...q,observedAt:'2026-01-01T01:00:00Z',limited:true}}},now);
 assert.equal(cards[0].status,'stale · limited');assert.equal(cards[1].status,'unavailable');
 assert.equal(quotaCards({quota:{codex:{...q,stale:true}}},now)[0].status,'stale');
});
test('expired, invalid and unverified observations never appear as current quota',()=>{
 for(const patch of [{observedAt:null},{observedAt:'2026-01-02T00:00:00Z'},{fiveHourRemainingPct:'75',weeklyRemainingPct:101},{fiveHourResetsAt:'2026-01-01T11:00:00Z',weeklyResetsAt:'2026-01-01T12:00:00Z'}]){
  const card=quotaCards({quota:{codex:{...q,...patch}}},now)[0];assert.equal(card.status,'unknown');assert.equal(card.label,'5h ? · wk ?');
 }
});
import {providerQuotaRequest} from '../src/provider_quota.mjs';
test('fixed passive cookie-only path and bounded response; malformed responses clear old values',async()=>{
 const cards=await providerQuotaRequest(undefined,async(path,options)=>{assert.equal(path,'/api/v2/provider-quotas');assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');return new Response(JSON.stringify({quota:{codex:q}}));},()=>now);
 assert.equal(cards.cards[0].status,'current');
 for(const body of ['x'.repeat(17000),'not json']){const result=await providerQuotaRequest(undefined,async()=>new Response(body),()=>now);assert.equal(result.status,0);assert.equal(result.cards[0].status,'unavailable');}
 const denied=await providerQuotaRequest(undefined,async()=>new Response('',{status:401}),()=>now);assert.equal(denied.status,401);
});

test('one expired window does not hide a valid window or invent a fresh observation',()=>{
 const [card]=quotaCards({quota:{codex:{...q,fiveHourResetsAt:'2026-01-01T12:00:00Z',observedAt:'2026-01-01T01:00:00Z'}}},now);
 assert.equal(card.label,'5h ? · wk 0%');
 assert.equal(card.status,'stale');
 assert.equal(card.reset,'5h ↻ ? · wk ↻ 2d 0h');
 assert.match(card.detail,/expired observation; waiting for new telemetry/);
});
test('reset countdown is visible without hover and updates from passive time only',()=>{
 const snapshot={quota:{codex:q}};
 assert.equal(quotaCards(snapshot,now)[0].reset,'5h ↻ 1h 0m · wk ↻ 2d 0h');
 const later=quotaCards(snapshot,now+30*60*1000)[0];
 assert.equal(later.reset,'5h ↻ 30m · wk ↻ 1d 23h');
 assert.equal(later.label,'5h 75% · wk 0%');
});
