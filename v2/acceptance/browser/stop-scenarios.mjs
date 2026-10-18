// Targeted successor-only Stop acceptance. Requires a registered matching pair,
// managed context and the reviewed fixed synthetic peer; never live providers.
import assert from 'node:assert/strict';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(check,label,signal,ms=10000){const start=performance.now();while(performance.now()-start<ms){signal.throwIfAborted();if(await check())return;await sleep(25);}throw Error(label);}
const click=(page,label)=>page.evaluate(label=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label);if(!button||button.disabled)throw Error('button_unavailable');button.click();},label);
const enabled=(page,label)=>page.evaluate(label=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===label&&!b.disabled),label);
const draft=page=>page.$eval('#composer',node=>node.value);
const setDraft=(page,text)=>page.$eval('#composer',(node,text)=>{const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(node,text);node.dispatchEvent(new Event('input',{bubbles:true}));},text);
const read=(page,path)=>page.evaluate(async path=>{const r=await fetch(path,{credentials:'same-origin',cache:'no-store'});return {status:r.status,body:r.status===200?await r.json():null};},path);
const write=(page,path,body)=>page.evaluate(async({path,body})=>{const session=await fetch('/api/v2/browser/session',{credentials:'same-origin',cache:'no-store'});if(session.status!==200)return {status:session.status};const {csrf_token}=await session.json();const r=await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json','x-orkestr-csrf':csrf_token},body:JSON.stringify(body)});return {status:r.status,body:r.status===200?await r.json():null};},{path,body});

export async function stopScenarios({page,conversation,fixture,report,signal,mode}) {
  assert(['terminal','ack-only'].includes(mode));
  const base=`/api/v2/conversations/${conversation}`,path=base+'/stop';
  const start=performance.now();report.stage=`owned_stop_${mode}`;
  const retained='Synthetic draft retained while Stop is pending.';
  // Fresh configured peer accepts this exact synthetic first turn.
  await setDraft(page,'synthetic ordinary HTTP input');await click(page,'Send');
  await wait(()=>enabled(page,'Stop'),'owned_stop_not_advertised',signal);
  const initial=await read(page,base+'/execution');
  assert.equal(initial.body.phase,'running');assert.equal(initial.body.capabilities.stop,true);
  await setDraft(page,retained);
  let original,followup;
  // One ordinary accepted followup races the mounted request, not a fake 409.
  let cdp=await page.createCDPSession();
  await cdp.send('Fetch.enable',{patterns:[{urlPattern:`*${path}`,requestStage:'Request'}]});
  let interceptionError;
  cdp.on('Fetch.requestPaused',event=>{void(async()=>{
    original=JSON.parse(event.request.postData);
    followup=await write(page,base+'/messages',{client_message_id:'synthetic-stop-followup',text:'synthetic ordinary HTTP input 2'});
    assert.equal(followup.status,202);
    const current=await read(page,base+'/execution');
    assert.equal(current.body.run_id,original.run_id);assert(current.body.revision>original.expected_revision);
    await cdp.send('Fetch.continueRequest',{requestId:event.requestId});
  })().catch(error=>{interceptionError=error;void cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'Failed'}).catch(()=>{});});});
  try{
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST',{timeout:10000});
    await click(page,'Stop');assert.equal((await response).status(),409);if(interceptionError)throw interceptionError;
  }finally{await cdp.send('Fetch.disable').catch(()=>{});await cdp.detach();}
  assert(!(await fixture.trace()).some(row=>row.kind==='interrupt'));
  await wait(()=>enabled(page,'Review updated Stop'),'stale_stop_requires_review',signal);
  assert.equal(await draft(page),retained);
  await click(page,'Review updated Stop');await wait(()=>enabled(page,'Stop'),'reviewed_stop_not_ready',signal);

  // Drop an actual committed public response. Retry after terminal/ACK transition
  // must keep request key/revision even when the server no longer offers Stop.
  cdp=await page.createCDPSession();let resolve,reject,held;
  const captured=new Promise((done,fail)=>{resolve=done;reject=fail;});
  const timer=setTimeout(()=>reject(Error('stop_response_deadline')),10000);
  await cdp.send('Fetch.enable',{patterns:[{urlPattern:`*${path}`,requestStage:'Response'}]});
  cdp.on('Fetch.requestPaused',event=>{void(async()=>{
    held=event;const raw=await cdp.send('Fetch.getResponseBody',{requestId:event.requestId});
    const body=JSON.parse(raw.base64Encoded?Buffer.from(raw.body,'base64').toString():raw.body);
    resolve({status:event.responseStatusCode,body,request:JSON.parse(event.request.postData)});
  })().catch(reject);});
  let committed;
  try{
    await click(page,'Stop');committed=await captured;
    assert.equal(committed.status,200);assert.equal(committed.body.outcome,'requested_unknown');
    assert.equal(committed.request.run_id,original.run_id);
    assert(committed.request.expected_revision>original.expected_revision);
    assert.notEqual(committed.request.request_key,original.request_key);
    await cdp.send('Fetch.failRequest',{requestId:held.requestId,errorReason:'Failed'});held=null;
  }finally{
    clearTimeout(timer);if(held)await cdp.send('Fetch.continueRequest',{requestId:held.requestId}).catch(()=>{});
    await cdp.send('Fetch.disable').catch(()=>{});await cdp.detach();
  }
  await wait(async()=>(await fixture.trace()).some(row=>row.kind==='interrupt-ack'),'native_ack_not_seen',signal);
  const pending=await read(page,base+'/execution');
  assert.equal(pending.body.phase,'cancel_requested');assert.equal(pending.body.capabilities.stop,false);
  const panel=await page.$eval('section[aria-label="Execution and resources"]',node=>node.innerText);
  assert(!panel.includes('Cancelled'),'ack_fabricated_cancelled');
  if(mode==='terminal')await fixture.releaseTerminal();
  await wait(async()=>{
    const status=await read(page,base+'/execution');
    return status.body.phase===(mode==='terminal'?'cancelled':'cancel_requested');
  },'terminal_status_mismatch',signal);
  await wait(()=>enabled(page,'Stop'),'uncertain_stop_exact_retry_unavailable',signal);
  const response=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST',{timeout:10000});
  await click(page,'Stop');const retry=await response;
  assert.equal(retry.status(),200);
  assert.deepEqual(JSON.parse(retry.request().postData()),committed.request);
  assert.deepEqual(await retry.json(),committed.body);
  const duplicate=await write(page,path,committed.request);assert.equal(duplicate.status,200);assert.deepEqual(duplicate.body,committed.body);
  // ACK-only reconciliation is bounded by the reviewed server. Wait until the
  // owned peer is gone before concluding it did not later supply terminal evidence.
  await fixture.waitPeerGone(signal);
  const final=await read(page,base+'/execution');
  assert.equal(final.body.phase,mode==='terminal'?'cancelled':'cancel_requested');
  assert.equal(final.body.capabilities.stop,false);
  const trace=await fixture.trace();
  assert.equal(trace.filter(row=>row.kind==='turn').length,1);
  assert.equal(trace.filter(row=>row.kind==='interrupt').length,1);
  assert.equal(new Set(trace.map(row=>row.pid)).size,1);
  const history=await read(page,base+'?after=0&limit=100');assert.equal(history.status,200);
  assert(history.body.messages.some(message=>message.text==='synthetic ordinary HTTP input 2'));
  assert.equal(await draft(page),retained);
  report.checks.push({name:`owned_stop_${mode}`,status:'passed',duration_ms:Math.round(performance.now()-start),
    stale_revision:409,explicit_review:true,exact_lost_response_retry:true,identical_receipt:true,
    terminal_confirmed:mode==='terminal',ack_only_unresolved:mode==='ack-only',queued_followup_retained:true,
    turns:1,interrupts:1,draft_preserved:true});
}
