// New acceptance cases; product assets and ordinary responses are never substituted.
import assert from 'node:assert/strict';
import { TASKS, instructions, wait, enabled, click, fill, value, read, responseFault } from './worker-support.mjs';
const STEER = 'section[aria-label="Steer running work"]';
const TITLE = `${TASKS} label input`;
const TEXT = `${TASKS} label textarea`;
const LIMIT = `${TASKS} select`;
const REVIEW = 'Review parent and prepare next task';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function workerScenarios({page,fixture,mode,report,signal}) {
  const base=`/api/v2/conversations/${fixture.info.conversation}`;
  const step=async(name,action)=>{
    report.stage=name;signal.throwIfAborted();const start=performance.now();
    const evidence=await action();report.checks.push({name,status:'passed',duration_ms:Math.round(performance.now()-start),...evidence});
  };
  const observations=[];
  page.on('response', response=>{
    const url=new URL(response.url());
    if(response.request().method()==='POST' && [base+'/steer',base+'/worker-tasks'].includes(url.pathname)) {
      observations.push({path:url.pathname,status:response.status(),request:JSON.parse(response.request().postData())});
    }
  });
  await fill(page,'#composer','synthetic ordinary HTTP input');await click(page,'Send');
  if(mode==='budget') {
    await wait(()=>enabled(page,'Create worker task',TASKS),'task_panel_unavailable',signal);
    await fill(page,'#composer','Synthetic unsent conversation draft');
    for(const [name,choice,budget] of [['alpha','default',null],['beta','60000',60000],['gamma','300000',300000],['delta','900000',900000]]) {
      await step(`owner_budget_${choice}`,async()=>{
        if(await enabled(page,REVIEW,TASKS))await click(page,REVIEW,TASKS);
        await fill(page,TITLE,`Synthetic ${name}`);await fill(page,TEXT,instructions(name));
        await page.select(LIMIT,choice);
        let captured;
        await responseFault(page,fixture.info.origin,base+'/worker-tasks','POST',async fault=>{
          await click(page,'Create worker task',TASKS);captured=await fault.captured;assert.equal(captured.status,200,'valid_budget_request_refused');await fault.release(false);
        });
        const request=captured.request;
        assert.equal(request.lifetime_ms,30000);
        if(budget===null)assert(!Object.hasOwn(request,'execution_budget_ms'));else assert.equal(request.execution_budget_ms,budget);
        await wait(()=>enabled(page,REVIEW,TASKS),'receipt_not_applied',signal);
        return {request,receipt:captured.body};
      });
    }
    await step('budget_uncertain_retry_remount_next_draft',async()=>{
      await click(page,REVIEW,TASKS);await fill(page,TITLE,'Synthetic held');await fill(page,TEXT,instructions('held'));await page.select(LIMIT,'300000');
      let original;
      await responseFault(page,fixture.info.origin,base+'/worker-tasks','POST',async fault=>{
        await click(page,'Create worker task',TASKS);original=await fault.captured;assert.equal(original.status,200);await fault.release(true);
      });
      await wait(()=>enabled(page,'Retry original task',TASKS),'retry_unavailable',signal);
      await page.select(LIMIT,'900000');await fill(page,TITLE,'Synthetic next draft');await fill(page,TEXT,'Synthetic next independent instruction');
      await click(page,'Workers','nav');await page.waitForSelector('section[aria-label="Workers"]');await click(page,'Assistant','nav');
      await wait(()=>enabled(page,'Retry original task',TASKS),'retry_lost_after_remount',signal);
      assert.equal(await value(page,LIMIT),'900000');assert.equal(await value(page,TITLE),'Synthetic next draft');
      await responseFault(page,fixture.info.origin,base+'/worker-tasks','POST',async fault=>{
        await click(page,'Retry original task',TASKS);const retry=await fault.captured;
        assert.equal(retry.status,200);assert.deepEqual(retry.request,original.request);assert.deepEqual(retry.body,original.body);await fault.release(false);
      });
      await wait(()=>enabled(page,REVIEW,TASKS),'retry_receipt_not_applied',signal);
      assert.equal(await value(page,LIMIT),'900000');assert.equal(await value(page,TITLE),'Synthetic next draft');
      assert.equal(await value(page,'#composer'),'Synthetic unsent conversation draft');
      return {original_request:original.request,identical_receipt:true,next_draft_retained:true};
    });
  } else {
    await wait(()=>enabled(page,'Steer',STEER),'steer_capability_unavailable',signal);
    const status=await read(page,base+'/execution');assert.equal(status.body.phase,'running');assert.equal(status.body.capabilities.steer,true);
    await fill(page,`${STEER} textarea`,'Synthetic explicit steering instruction');
    if(mode==='steering') {
      await step('steering_uncertain_retry_exact_tuple',async()=>{
        let original;
        await responseFault(page,fixture.info.origin,base+'/steer','POST',async fault=>{
          await click(page,'Steer',STEER);original=await fault.captured;assert.equal(original.status,200);assert.equal(original.body.disposition,'reserved');await fault.release(true);
        });
        await wait(()=>enabled(page,'Retry original Steer',STEER),'steer_retry_unavailable',signal);
        await fill(page,`${STEER} textarea`,'Synthetic edited next steering draft');
        await responseFault(page,fixture.info.origin,base+'/steer','POST',async fault=>{
          await click(page,'Retry original Steer',STEER);const retry=await fault.captured;
          assert.equal(retry.status,200);assert.deepEqual(retry.request,original.request);assert.deepEqual(retry.body,original.body);await fault.release(false);
        });
        await wait(()=>enabled(page,'Check delivery',STEER),'delivery_action_unavailable',signal);
        assert.equal(await value(page,`${STEER} textarea`),'Synthetic edited next steering draft');
        return {request:original.request,receipt:original.body,exact_retry:true};
      });
      await step('acknowledged_is_not_completion',async()=>{
        const key=observations.find(o=>o.path===base+'/steer').request.control.request_key;
        await wait(async()=>{const r=await read(page,base+'/steering/'+key);report.delivery_probe=r;return r.body?.state==='acknowledged';},'actual_native_ack_not_observed',signal);
        const reply=page.waitForResponse(r=>new URL(r.url()).pathname.startsWith(base+'/steering/'));
        await click(page,'Check delivery',STEER);const response=await reply;assert.equal(response.status(),200);
        const delivery=await response.json();assert.equal(delivery.state,'acknowledged');
        await page.waitForFunction(scope=>document.querySelector(scope).textContent.includes('Instructions acknowledged'),{},STEER);
        const latest=await read(page,base+'/execution');assert.equal(latest.body.phase,'running');
        const copy=await page.$eval(STEER,n=>n.textContent);assert(copy.includes('not completion') || copy.includes('does not confirm completion'));return {delivery,phase:latest.body.phase};
      });
    } else {
      await step('real_control_transition_stale_steer_conflict',async()=>{
        const cdp=await page.createCDPSession();let held,resolve;const captured=new Promise(done=>resolve=done);
        await cdp.send('Fetch.enable',{patterns:[{urlPattern:fixture.info.origin+base+'/steer',requestStage:'Request'}]});
        cdp.on('Fetch.requestPaused',e=>{held=e;resolve(e);});
        try {
          await click(page,'Steer',STEER);const request=await Promise.race([captured,pause(10000).then(()=>{throw Error('stale_request_not_captured');})]);
          const frozen=JSON.parse(request.request.postData);
          await fixture.request('barrier','complete-1');
          await wait(async()=>{const r=await read(page,base+'/execution');return r.body?.phase==='awaiting_acceptance'&&r.body.control_revision!==frozen.control.expected_control_revision;},'canonical_completion_transition_missing',signal);
          const reply=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===base+'/steer');
          await cdp.send('Fetch.continueRequest',{requestId:request.requestId});held=null;const response=await reply;report.conflict_probe={status:response.status(),request:frozen};assert.equal(response.status(),409,'stale_control_not_409');
          await wait(()=>enabled(page,'Review for a new request',STEER),'conflict_review_missing',signal);
          assert.equal(await enabled(page,'Retry original Steer',STEER),false);
          await page.waitForFunction(()=>[...document.querySelectorAll('section[aria-label="Execution and resources"]')].some(n=>n.textContent.includes('Awaiting review')));
          await click(page,'Review for a new request',STEER);assert.equal(await enabled(page,'Steer',STEER),false);
          return {original_request:frozen,actual_http_status:409,transition:'running_to_awaiting_acceptance',no_automatic_retry:true};
        } finally {if(held)await cdp.send('Fetch.continueRequest',{requestId:held.requestId}).catch(()=>{});await cdp.send('Fetch.disable').catch(()=>{});await cdp.detach();}
      });
    }
  }
  await step('logout_clears_scoped_controls_and_drafts',async()=>{
    await click(page,'Sign out');await page.waitForSelector('#username');
    assert.equal(await page.$('#composer'),null);assert.equal(await page.$(TASKS),null);assert.equal(await page.$(STEER),null);
    await fill(page,'#username','synthetic-owner');await fill(page,'#password','synthetic-password-ordinary-http');await click(page,'Continue');await page.waitForSelector('#composer');
    assert.equal(await value(page,'#composer'),mode==='budget'?'Synthetic unsent conversation draft':'');
    if(mode==='budget') {await page.waitForSelector(LIMIT);assert.equal(await value(page,LIMIT),'default');assert.equal(await value(page,TITLE),'');}
    else {await page.waitForSelector(`${STEER} textarea`);assert.equal(await value(page,`${STEER} textarea`),'');}
    return {reauthenticated_same_owner:true,task_and_steering_drafts_cleared:true,correctly_scoped_conversation_draft_retained:mode==='budget'};
  });
  report.mutation_observations=observations;
}
