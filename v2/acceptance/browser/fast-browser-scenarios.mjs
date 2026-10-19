// Exact matching immutable Fast/Deep product; real HTTP responses only.
import assert from 'node:assert/strict';
import {wait,enabled,click,fill,value,read,responseFault} from './worker-support.mjs';
const FAST='section[aria-label="Fast reply"]';
const DEEP='section[aria-label="Execution and resources"]';
export async function workerScenarios({page,fixture,mode,report,signal}) {
 const base=`/api/v2/conversations/${fixture.info.conversation}`;
 const step=async(name,action)=>{report.stage=name;signal.throwIfAborted();const start=performance.now();const evidence=await action();report.checks.push({name,status:'passed',duration_ms:Math.round(performance.now()-start),...evidence});};
 await step('separate_fast_deep_status_and_shared_composer',async()=>{
  await fill(page,'#composer','synthetic ordinary HTTP input');await click(page,'Send');
  await wait(async()=>{const s=await fixture.request('summary');return s.fast?.phase===(mode==='accept'?'awaiting_acceptance':'running')&&s.deep?.phase==='running';},'independent_roles_not_ready',signal);
  await wait(()=>enabled(page,mode==='accept'?'Accept Fast reply':'Stop',FAST),'fast_control_not_mounted',signal);
  const s=await fixture.request('summary');assert.notEqual(s.deep.run_id,s.fast.run_id);
  assert.equal((await read(page,base+'/execution?run_id='+s.fast.run_id)).status,404);
  assert.equal((await read(page,base+'/fast/execution?run_id='+s.deep.run_id)).status,404);
  await fill(page,'#composer','Synthetic unsent draft during Fast work');
  await click(page,'Workers','nav');await page.waitForSelector('section[aria-label="Workers"]');await click(page,'Assistant','nav');
  await page.waitForSelector(FAST);assert.equal(await value(page,'#composer'),'Synthetic unsent draft during Fast work');
  report.initial=s;return {deep_run:s.deep.run_id,fast_run:s.fast.run_id,shared_composer_retained:true,foreign_role_reads:404};
 });
 if(mode==='accept') {
  await step('exact_fast_acceptance_lost_response_retry',async()=>{
   await wait(()=>enabled(page,'Accept Fast reply',FAST),'fast_accept_unavailable',signal);
   let original;
   await responseFault(page,fixture.info.origin,base+'/accept','POST',async fault=>{
    await click(page,'Accept Fast reply',FAST);original=await fault.captured;
    assert.equal(original.status,200);assert.equal(original.request.run_id,report.initial.fast.run_id);
    assert.equal(original.request.completion_event_id,report.initial.fast.acceptance_candidate.completion_event_id);
    assert.equal(original.body.run_id,report.initial.fast.run_id);assert.equal(original.body.outcome,'succeeded');await fault.release(true);
   });
   await wait(()=>enabled(page,'Accept Fast reply',FAST),'fast_accept_retry_unavailable',signal);
   await responseFault(page,fixture.info.origin,base+'/accept','POST',async fault=>{
    await click(page,'Accept Fast reply',FAST);const retry=await fault.captured;assert.equal(retry.status,200);
    assert.deepEqual(retry.request,original.request);assert.deepEqual(retry.body,original.body);await fault.release(false);
   });
   const s=await fixture.request('summary');assert.equal(s.fast.phase,'completed');assert.equal(s.deep.phase,'running');
   assert.equal(s.ledger.accepted,1);assert.equal(s.deep.run_id,report.initial.deep.run_id);
   assert(!s.trace.some(r=>r.kind==='interrupt'));return {request:original.request,receipt:original.body,deep_unaccepted:true};
  });
 } else {
  await step('fast_stop_frozen_retry_exact_role',async()=>{
   await wait(()=>enabled(page,'Stop',FAST),'fast_stop_unavailable',signal);let original;
   await responseFault(page,fixture.info.origin,base+'/fast/stop','POST',async fault=>{
    await click(page,'Stop',FAST);original=await fault.captured;assert.equal(original.status,200);
    assert.equal(original.request.run_id,report.initial.fast.run_id);assert(original.request.expected_control_revision>0);await fault.release(true);
   });
   await wait(()=>enabled(page,'Stop',FAST),'fast_stop_retry_unavailable',signal);
   await responseFault(page,fixture.info.origin,base+'/fast/stop','POST',async fault=>{
    await click(page,'Stop',FAST);const retry=await fault.captured;assert.equal(retry.status,200);
    assert.deepEqual(retry.request,original.request);assert.deepEqual(retry.body,original.body);await fault.release(false);
   });
   await wait(async()=>{const s=await fixture.request('summary');return s.fast.phase===(mode==='ack'?'cancel_requested':'cancelled')&&s.trace.some(r=>r.role==='fast'&&r.kind==='interrupt');},'fast_stop_outcome_missing',signal);
   const s=await fixture.request('summary');assert.equal(s.deep.phase,'running');assert.equal(s.deep.run_id,report.initial.deep.run_id);
   assert.equal(s.trace.filter(r=>r.role==='fast'&&r.kind==='interrupt').length,1);
   assert.equal(s.trace.filter(r=>r.role==='deep'&&r.kind==='interrupt').length,0);
   assert.equal(s.ledger.accepted,0);
   await page.waitForFunction(({scope,label})=>document.querySelector(scope)?.textContent.includes(label),{}, {scope:FAST,label:mode==='ack'?'Stop requested':'Cancelled'});
   if(mode==='ack')assert(!(await page.$eval(FAST,n=>n.textContent)).includes('Cancelled'));
   return {request:original.request,receipt:original.body,phase:s.fast.phase,one_interrupt:true,deep_unchanged:true};
  });
 }
 await step('logout_aborts_fast_poll_and_clears_authorized_panel',async()=>{
  await responseFault(page,fixture.info.origin,base+'/fast/execution','GET',async fault=>{
   const held=await fault.captured;assert.equal(held.status,200);await click(page,'Sign out');await page.waitForSelector('#username');
   const release=await fault.release(false,true);report.logout_read=release;
  });
  assert.equal(await page.$(FAST),null);assert.equal(await page.$('#composer'),null);
  assert.equal((await read(page,base+'/fast/execution')).status,401);
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('#username');assert.equal(await page.$(FAST),null);
  return {cookie_revoked:true,reload_requires_login:true,held_read:report.logout_read};
 });
}
