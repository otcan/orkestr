// Additive scenarios for the managed, isolated browser runner from 18e920fb.
// No launch, lease acquisition, credentials, provider inference or server mutation
// outside the supplied synthetic fixture driver belongs in this module.
import assert from 'node:assert/strict';

const DRAFT = 'Synthetic review draft remains editable.';
const wait = async (check, label, timeout = 15000) => {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(label);
};
const button = async (page, label) => {
  const handle = await page.evaluateHandle(label => [...document.querySelectorAll('button')]
    .find(node => node.textContent.trim() === label), label);
  const element = handle.asElement();
  assert(element, `missing_button_${label.replaceAll(' ', '_')}`);
  return element;
};
const click = async (page, label) => { const node = await button(page, label); await node.click(); await node.dispose(); };
const enabled = async (page, label) => {
  const node = await button(page, label);
  const value = await node.evaluate(node => !node.disabled);
  await node.dispose(); return value;
};
const draft = page => page.$eval('#composer', node => node.value);
const setDraft = async page => {
  await page.focus('#composer');
  await page.keyboard.type(DRAFT);
  assert.equal(await draft(page), DRAFT);
};
const read = (page, path) => page.evaluate(async path => {
  const response = await fetch(path, {credentials:'same-origin', cache:'no-store'});
  return {status:response.status, body:response.status === 200 ? await response.json() : null};
}, path);
const write = (page, path, method, body) => page.evaluate(async ({path, method, body}) => {
  const session = await fetch('/api/v2/browser/session', {credentials:'same-origin', cache:'no-store'});
  if (session.status !== 200) return {status:session.status};
  const {csrf_token} = await session.json();
  const response = await fetch(path, {method, credentials:'same-origin', cache:'no-store',
    headers:{'content-type':'application/json','x-orkestr-csrf':csrf_token},
    ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  return {status:response.status, body:response.status === 200 ? await response.json() : null};
}, {path, method, body});

// Response-stage fault only: the actual server has processed the real request.
async function responseFault(page, suffix, action) {
  const cdp = await page.createCDPSession();
  let resolve, reject, held;
  const captured = new Promise((done, fail) => {resolve=done; reject=fail;});
  const timeout=setTimeout(()=>reject(new Error("response_fault_deadline")),15000);
  await cdp.send('Fetch.enable', {patterns:[{urlPattern:`*${suffix}`,requestStage:'Response'}]});
  cdp.on('Fetch.requestPaused', event => { void (async()=>{
    if (held) { await cdp.send('Fetch.continueRequest',{requestId:event.requestId}); return; }
    held=event;
    const raw = await cdp.send('Fetch.getResponseBody',{requestId:event.requestId});
    const text = raw.base64Encoded ? Buffer.from(raw.body,'base64').toString('utf8') : raw.body;
    resolve({status:event.responseStatusCode, body:text ? JSON.parse(text) : null,
      request: event.request.postData ? JSON.parse(event.request.postData) : null});
  })().catch(reject); });
  try { return await action({captured, release:async fail => {
    assert(held,'response_not_held');
    await cdp.send(fail?'Fetch.failRequest':'Fetch.continueRequest',
      {requestId:held.requestId,...(fail?{errorReason:'Failed'}:{})});
    held=null;
  }}); }
  finally {
    clearTimeout(timeout);
    if(held) await cdp.send('Fetch.continueRequest',{requestId:held.requestId}).catch(()=>{});
    await cdp.send('Fetch.disable').catch(()=>{}); await cdp.detach();
  }
}

export async function executionScenarios({page, fixture, report, signal}) {
  // fixture methods must use committed Store operations on this run's isolated
  // namespace. No HTTP stubs, SQL fabrication or externally supplied authority.
  const step=async(name, action)=>{
    signal.throwIfAborted(); const start=performance.now(); report.stage=name;
    const evidence=await action(); signal.throwIfAborted();
    report.checks.push({name,status:'passed',duration_ms:Math.round(performance.now()-start),...evidence});
  };
  let target;
  await step('completion_candidate_survives_real_reload',async()=>{
    target=await fixture.completed();
    const path=`/api/v2/conversations/${target.conversation_id}/execution`;
    const before=await read(page,path);
    assert.equal(before.status,200); assert.equal(before.body.phase,'awaiting_acceptance');
    assert.deepEqual(before.body.acceptance_candidate,{run_id:target.run_id,completion_event_id:target.completion_event_id});
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForSelector('#composer',{visible:true});
    const after=await read(page,path);
    assert.deepEqual(after.body.acceptance_candidate,before.body.acceptance_candidate);
    assert.equal(after.body.revision,before.body.revision);
    await wait(()=>enabled(page,'Accept completion'),'reload_accept_not_enabled');
    await setDraft(page); return {candidate_exact:true,revision:after.body.revision};
  });
  await step('uncertain_accept_recovers_exact_original_receipt',async()=>{
    const path=`/api/v2/conversations/${target.conversation_id}/accept`;
    let original;
    await responseFault(page,path,async fault=>{
      await click(page,'Accept completion'); original=await fault.captured;
      assert.equal(original.status,200);
      assert.equal(original.request.run_id,target.run_id);
      assert.equal(original.request.completion_event_id,target.completion_event_id);
      assert.equal(original.request.expected_revision,original.body.requested_revision);
      await fault.release(true);
    });
    await wait(()=>enabled(page,'Accept completion'),'uncertain_retry_not_available');
    let retry;
    await responseFault(page,path,async fault=>{
      await click(page,'Accept completion'); retry=await fault.captured;
      assert.equal(retry.status,200);
      assert.deepEqual(retry.request,original.request);
      assert.deepEqual(retry.body,original.body);
      await fault.release(false);
    });
    const duplicate=await write(page,path,'POST',original.request);
    assert.equal(duplicate.status,200); assert.deepEqual(duplicate.body,original.body);
    assert.equal(await draft(page),DRAFT);
    return {exact_request_retry:true,duplicate_receipt_identical:true};
  });
  await step('mounted_stale_revision_conflict_requires_explicit_review',async()=>{
    target=await fixture.completed();
    await click(page,'Reconnect');
    await wait(()=>enabled(page,'Accept completion'),'new_completion_not_available');
    const path=`/api/v2/conversations/${target.conversation_id}/accept`;
    const cdp=await page.createCDPSession();
    let original, advanced=false;
    await cdp.send('Fetch.enable',{patterns:[{urlPattern:`*${path}`,requestStage:'Request'}]});
    cdp.on('Fetch.requestPaused',event=>{void(async()=>{
      if(!advanced){
        advanced=true;original=JSON.parse(event.request.postData);
        // Real IntakeStore admission, not a revision setter or fake 409.
        const newer=await fixture.advanceRevision();
        assert(newer.revision>original.expected_revision);
        assert.deepEqual(newer.acceptance_candidate,{run_id:target.run_id,completion_event_id:target.completion_event_id});
      }
      await cdp.send('Fetch.continueRequest',{requestId:event.requestId});
    })().catch(()=>{void cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'Failed'});});});
    try{
      const refused=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST');
      await click(page,'Accept completion');assert.equal((await refused).status(),409);
    }finally{await cdp.send('Fetch.disable');await cdp.detach();}
    await wait(()=>enabled(page,'Review updated completion'),'mounted_conflict_review_not_available');
    assert.equal(await draft(page),DRAFT);
    const unchanged=await read(page,`/api/v2/conversations/${target.conversation_id}/execution`);
    assert.equal(unchanged.body.phase,'awaiting_acceptance');
    await click(page,'Review updated completion');
    await wait(()=>enabled(page,'Accept completion'),'explicit_review_not_ready');
    await responseFault(page,path,async fault=>{
      await click(page,'Accept completion');const accepted=await fault.captured;
      assert.equal(accepted.status,200);
      assert.equal(accepted.request.run_id,original.run_id);
      assert.equal(accepted.request.completion_event_id,original.completion_event_id);
      assert(accepted.request.expected_revision>original.expected_revision);
      assert.notEqual(accepted.request.request_key,original.request_key);
      await fault.release(false);
    });
    assert.equal(await draft(page),DRAFT);
    return {native_conflict_status:409,explicit_review_required:true,same_completion_new_revision:true};
  });
  await step('external_payload_tombstone_revalidates_without_revision_change',async()=>{
    const payload=await fixture.progress();
    await click(page,'Reconnect');
    await page.waitForFunction(text=>document.querySelector('section[aria-label="Provider output"] pre')?.textContent===text,{},payload.text);
    const statusPath=`/api/v2/conversations/${payload.conversation_id}/execution`;
    const before=await read(page,statusPath);
    const removed=await write(page,`/api/v2/conversations/${payload.conversation_id}/payloads/${payload.payload_id}`,'DELETE');
    assert.equal(removed.status,204);
    const after=await read(page,statusPath);
    assert.equal(after.body.revision,before.body.revision);
    assert.deepEqual(after.body.progress,before.body.progress);
    await wait(async()=>!(await page.$('section[aria-label="Provider output"] pre')),'external_tombstone_not_revalidated');
    assert.equal(await draft(page),DRAFT);
    return {same_revision:true,same_payload_reference:true,external_tombstone_visible:true};
  });
  await step('payload_delete_wins_delayed_predelete_read',async()=>{
    const payload=await fixture.progress();
    await click(page,'Reconnect');
    await page.waitForFunction(text=>document.querySelector('section[aria-label="Provider output"] pre')?.textContent===text,{},payload.text);
    const path=`/api/v2/conversations/${payload.conversation_id}/payloads/${payload.payload_id}`;
    await responseFault(page,path,async fault=>{
      const held=await fault.captured; // next bounded real poll, before deletion
      assert.equal(held.status,200); assert.equal(held.body.text,payload.text);
      await click(page,'Remove provider output');
      await wait(async()=>!(await page.$('section[aria-label="Provider output"] pre')),'delete_did_not_clear_text');
      await fault.release(false); // old GET body must not resurrect removed output
    });
    const tombstone=await read(page,path);
    assert.equal(tombstone.status,200); assert.equal(tombstone.body.text,null);
    await new Promise(resolve=>setTimeout(resolve,5500));
    assert.equal(await page.$('section[aria-label="Provider output"] pre'),null);
    assert.equal(await draft(page),DRAFT);
    return {real_tombstone:true,late_read_not_restored:true};
  });
  await step('stop_visibility_matches_registered_server_capability',async()=>{
    const status=await read(page,`/api/v2/conversations/${target.conversation_id}/execution`);
    assert.equal(status.status,200);
    // This candidate deliberately has no verified provider interruption authority.
    assert.equal(status.body.capabilities.stop,false);
    const stop=await page.evaluate(()=>[...document.querySelectorAll('button')].find(node=>/^Stop/.test(node.textContent.trim()))?.disabled);
    assert.equal(stop,true); return {advertised_stop:false,stop_disabled:true};
  });
  await step('revocation_fences_acceptance_and_authorized_output',async()=>{
    const current=await fixture.completed();
    const before=await read(page,`/api/v2/conversations/${current.conversation_id}/execution`);
    await fixture.revokeBrowserSession();
    const response=await write(page,`/api/v2/conversations/${current.conversation_id}/accept`,'POST',{
      run_id:current.run_id,completion_event_id:current.completion_event_id,
      expected_revision:before.body.revision,request_key:'synthetic-revoked-review'});
    assert.equal(response.status,401);
    await wait(async()=>Boolean(await page.$('#username')),'revocation_not_visible');
    assert.equal(await page.$('section[aria-label="Provider output"] pre'),null);
    return {revoked_status:401,authorized_view_cleared:true};
  });
}
