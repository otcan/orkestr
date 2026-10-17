import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeliveryRouteFence} from '../packages/connectors/src/whatsapp-delivery-route-fence.js';
const at='2026-01-01T00:00:00Z';
const evidence=(routeId,checkedAt=at)=>({routeId,checkedAt,restrictionCleared:true,authenticated:true,ready:true,identityVerified:true,oldRouteStopped:true,legacyRouterDisabled:true,transportJournalsClear:true});
function fixture(t){let time=Date.parse(at);const f=createDeliveryRouteFence({dbPath:':memory:',now:()=>time});t.after(()=>f.close());f.activate({to:'temporary',evidence:evidence('temporary')});return {f,advance:()=>time+=1000,stamp:()=>new Date(time).toISOString()};}
test('switch and rollback preserve receipts, use one route and reject catch-up',t=>{
 const {f,advance,stamp}=fixture(t);
 f.reserve({id:'n1',hash:'h',route:'temporary',createdAt:at});f.sent('n1','provider1');advance();
 f.activate({from:'temporary',to:'primary',evidence:evidence('primary',stamp())});
 assert.throws(()=>f.assertActive('temporary'),/inactive/);
 assert.throws(()=>f.reserve({id:'old',hash:'h',route:'primary',createdAt:at}),/before_cutover/);
 assert.equal(f.reserve({id:'n1',hash:'h',route:'primary',createdAt:at}).providerId,'provider1');
 advance();f.activate({from:'primary',to:'temporary',evidence:evidence('temporary',stamp())});
 assert.equal(f.current().epoch,3);assert.throws(()=>f.assertActive('primary'),/inactive/);
 assert.equal(f.reserve({id:'n1',hash:'h',route:'temporary',createdAt:at}).duplicate,true);
});
test('inflight and uncertain deliveries block cutover and retry',t=>{
 const {f}=fixture(t);f.reserve({id:'n',hash:'h',route:'temporary',createdAt:at});
 assert.throws(()=>f.activate({from:'temporary',to:'primary',evidence:evidence('primary')}),/unresolved/);
 f.recover('temporary');assert.throws(()=>f.reserve({id:'n',hash:'h',route:'temporary',createdAt:at}),/unresolved/);
 assert.throws(()=>f.activate({from:'temporary',to:'primary',evidence:evidence('primary')}),/unresolved/);
});
test('restriction clearance, identity, isolation, fresh evidence and expected route are required',t=>{
 const {f}=fixture(t);
 for(const k of ['restrictionCleared','authenticated','ready','identityVerified','oldRouteStopped','legacyRouterDisabled','transportJournalsClear'])
  assert.throws(()=>f.activate({from:'temporary',to:'primary',evidence:{...evidence('primary'),[k]:false}}),/evidence_required/);
 assert.throws(()=>f.activate({from:'temporary',to:'primary',evidence:evidence('other')}),/evidence_required/);
 assert.throws(()=>f.activate({from:'temporary',to:'primary',evidence:evidence('primary','2025-01-01')}),/stale_evidence/);
 assert.throws(()=>f.activate({from:'other',to:'primary',evidence:evidence('primary')}),/compare_failed/);
 assert.equal(f.current().route,'temporary');
});
