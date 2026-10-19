// Synthetic files only; all persisted mutations use ordinary authenticated HTTP.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {click,fill,text,waitFor,digest} from './history-support.mjs';
const panel='section[aria-label="Thread files"]';
const waitReady=page=>page.waitForFunction(selector=>{const b=[...document.querySelector(selector).querySelectorAll('button')].find(b=>b.textContent==='Refresh files');return b&&!b.disabled;},{},panel);
async function fileInput(page,selector,file){
 // The registered browser runs in its own filesystem namespace. Supply the
 // synthetic bytes through the ordinary File input instead of a host path.
 const bytes=[...await fs.readFile(file)];
 await page.$eval(selector,(input,{bytes,name})=>{
  const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(bytes)],name));
  input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
 },{bytes,name:path.basename(file)});
}
const manifestOnPage=page=>page.evaluate(()=>window.__attachmentProbe.calls.filter(c=>c.method==='POST'&&c.status===200).at(-1)?.response.manifest);
async function saveArchive(page,file){await page.$eval(panel+' details',e=>e.open=true);await fileInput(page,panel+' input[accept]',file);await click(page,'Import file copies');await text(page,'File copy saved.');await waitReady(page);}
async function downloaded(folder,name){await waitFor(async()=>{try{return (await fs.stat(path.join(folder,name))).isFile();}catch{return false;}},'download_file_missing');return fs.readFile(path.join(folder,name));}
export function installProbe(){
 const original=window.fetch.bind(window);
 const state=window.__attachmentProbe={calls:[],loseImport:false,holdRaw:false,rawWaiting:false,releaseRaw:null};
 window.fetch=async (...args)=>{
  const response=await original(...args);const url=new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href);
  if(url.origin!==location.origin||!url.pathname.includes('/attachment'))return response;
  const method=args[1]?.method??'GET';
  if(method==='POST'||method==='DELETE'){
   const record={path:url.pathname,method,body:args[1]?.body,status:response.status,response:await response.clone().json().catch(()=>null)};
   if(state.calls.length<100)state.calls.push(record);
   if(method==='POST'&&response.status===200&&state.loseImport){state.loseImport=false;throw new TypeError('Synthetic committed response loss');}
  }
  if(method==='GET'&&url.pathname.includes('/attachments/')&&state.holdRaw){state.holdRaw=false;state.rawWaiting=true;await new Promise(resolve=>state.releaseRaw=resolve);state.rawWaiting=false;}
  return response;
 };
}
export async function attachmentScenarios({page,context,candidate,report,output,downloads,network}){
 const step=async(name,action)=>{report.stage=name;console.log(JSON.stringify({stage:name}));const evidence=await action();report.checks.push({name,status:'passed',...evidence});};
 let session,first,copy;
 const bytes=Buffer.from([0,255,128,1,13,10,65,66,0,99]);const filename='synthetic-copy.bin';
 const file=path.join(output,filename);await fs.writeFile(file,bytes,{mode:0o600});
 await step('setup_cookie_and_canonical_owner',async()=>{
  await page.goto(candidate.origin,{waitUntil:'domcontentloaded'});await page.waitForSelector('#username');
  await click(page,'First-time setup');await fill(page,'#username','synthetic-attachment-owner');
  await fill(page,'#password','synthetic-attachment-password-ordinary-http');await fill(page,'#bootstrap',candidate.bootstrap);await click(page,'Continue');
  await page.waitForSelector('#composer');await text(page,'Files refreshed.');await waitReady(page);
  session=await page.evaluate(async()=>await(await fetch('/api/v2/browser/session')).json());
  assert(session.owner_id&&session.global_conversation_id);const cookie=(await context.cookies()).find(c=>c.name==='orkestr_v2_session');
  assert(cookie?.httpOnly&&cookie.sameSite==='Strict');return{owner_from_authenticated_projection:true};
 });
 await step('upload_committed_response_lost_exact_mounted_retry',async()=>{
  await fileInput(page,panel+' input[type=file]:not([accept])',file);
  await page.evaluate(()=>window.__attachmentProbe.loseImport=true);await click(page,'Save file copy');await text(page,'Synthetic committed response loss');await waitReady(page);
  await click(page,'Retry original file request');await text(page,'Original file request confirmed.');await waitReady(page);
  const calls=await page.evaluate(()=>window.__attachmentProbe.calls.filter(c=>c.method==='POST'));
  assert.equal(calls.length,2);assert.equal(calls[0].body,calls[1].body);assert.deepEqual(calls[0].response,calls[1].response);
  first=calls[1].response.manifest;assert.equal(first.owner_id,session.owner_id);assert.equal(first.references[0].message_id,null);
  return{actual_committed_responses:2,identical_request_and_receipt:true,manifest_id:first.manifest_id};
 });
 await step('discovery_survives_reload_and_verified_download_exact_bytes',async()=>{
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('#composer');await text(page,'Files refreshed.');await waitReady(page);
  await click(page,'Open saved copy: '+filename);await waitReady(page);await click(page,'Verify and download');await text(page,'File verified and download offered.');await waitReady(page);
  const saved=await downloaded(downloads,filename);assert.deepEqual(saved,bytes);
  return{bytes:saved.length,sha256:digest(saved),reload_discovery:true};
 });
 await step('export_archive_and_import_fresh_copy',async()=>{
  await click(page,'Export file-copy archive');await text(page,'Copy archive offered.');await waitReady(page);
  const archive=JSON.parse(await downloaded(downloads,'thread-files.json'));assert.deepEqual(archive.manifest,first);assert.deepEqual(archive.contents[0].bytes,[...bytes]);
  await saveArchive(page,path.join(downloads,'thread-files.json'));copy=await manifestOnPage(page);
  assert.notEqual(copy.manifest_id,first.manifest_id);assert.notEqual(copy.references[0].reference_id,first.references[0].reference_id);
  assert.equal(copy.owner_id,session.owner_id);assert.equal(copy.references[0].message_id,null);
  return{fresh_manifest_and_reference:true,raw_bytes_preserved:true};
 });
 await step('concurrent_remove_after_raw_read_refuses_late_download',async()=>{
  await fs.rm(path.join(downloads,filename));await page.evaluate(()=>window.__attachmentProbe.holdRaw=true);
  await click(page,'Verify and download');await page.waitForFunction(()=>window.__attachmentProbe.rawWaiting);
  const status=await page.evaluate(async({session,m})=>(await fetch('/api/v2/conversations/'+session.global_conversation_id+'/attachments/'+m.manifest_id+'/'+m.references[0].reference_id,{
   method:'DELETE',credentials:'same-origin',headers:{'Content-Type':'application/json','x-orkestr-csrf':session.csrf_token},body:JSON.stringify({request_key:crypto.randomUUID()})})).status,{session,m:copy});
  assert.equal(status,200);await page.evaluate(()=>window.__attachmentProbe.releaseRaw());await text(page,'File removed or selection changed');await waitReady(page);
  assert.equal(await fs.stat(path.join(downloads,filename)).then(()=>true,()=>false),false);
  await click(page,'Refresh files');await waitReady(page);await click(page,'Open saved copy: '+filename);await waitReady(page);
  // UUID ordering means the repeated filename is ambiguous; open original explicitly through its authorized list button below.
  return{removal_http:status,late_save_refused:true};
 });
 await step('ordinary_removal_retains_tombstone_no_raw_bytes',async()=>{
  // Use a fresh reload and the exact original collection button by matching the
  // actual discovered ID captured in its UI request; no forged DOM authority.
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('#composer');await text(page,'Files refreshed.');await waitReady(page);
  // Both copies have the same display name; exercise the original via the first
  // available collection whose ordinary open returns its exact immutable ID.
  const buttons=await page.$$(panel+' ul button');let opened=false;
  for(const button of buttons){await button.click();await waitReady(page);const available=await page.$$eval(panel+' button',bs=>bs.some(b=>b.textContent==='Remove file bytes'));if(available){opened=true;break;}}
  for(const button of buttons)await button.dispose();assert(opened,'available_original_not_discovered');
  await click(page,'Remove file bytes');await text(page,'File removed. Its saved reference remains.');await waitReady(page);
  assert.equal(await page.$$eval(panel+' button',bs=>bs.some(b=>b.textContent==='Verify and download')),false);
  const raw=await page.evaluate(async({session,m})=>(await fetch('/api/v2/conversations/'+session.global_conversation_id+'/attachments/'+m.manifest_id+'/'+m.references[0].reference_id)).status,{session,m:first});
  assert.equal(raw,410);return{removed_http:raw,download_action_absent:true};
 });
 await step('inert_discovery_above_1MiB_remains_readable_no_download',async()=>{
  for(let count=0;count<2;count++){
   const manifest={schema_version:1,manifest_id:randomUUID(),owner_id:randomUUID(),conversation_id:randomUUID(),
    references:Array.from({length:128},()=>({reference_id:randomUUID(),message_id:null,filename:'legacy-'+String(count)+'-'+ 'x'.repeat(4087),media_type:'m'.repeat(1024),sha256:'s'.repeat(128),byte_length:20000000,state:'inert'}))};
   const archive=path.join(output,'inert-'+count+'.json');await fs.writeFile(archive,JSON.stringify({manifest,contents:[]}),{mode:0o600});await saveArchive(page,archive);
  }
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('#composer');await text(page,'Files refreshed.');await waitReady(page);
  const result=await page.evaluate(async id=>{const r=await fetch('/api/v2/conversations/'+id+'/attachment-manifests?limit=16');const t=await r.text();const p=JSON.parse(t);return{status:r.status,bytes:new TextEncoder().encode(t).length,manifests:p.manifests.length,inert:p.manifests.flatMap(m=>m.references).filter(r=>r.state==='inert').length};},session.global_conversation_id);
  assert.equal(result.status,200);assert(result.bytes>1048576);assert.equal(result.inert,256);
  // The mounted list must have rendered both large collection names as buttons.
  const legacy=await page.$$eval(panel+' ul button',bs=>bs.filter(b=>b.textContent.includes('legacy-')).length);assert.equal(legacy,2);
  const button=await page.evaluateHandle(s=>[...document.querySelector(s).querySelectorAll('ul button')].find(b=>b.textContent.includes('legacy-')),panel);await button.asElement().click();await button.dispose();await waitReady(page);
  assert.equal(await page.$$eval(panel+' button',bs=>bs.some(b=>b.textContent==='Verify and download'||b.textContent==='Remove file bytes')),false);
  await text(page,'Saved reference only — file unavailable.');return{...result,legacy_rows:128,no_byte_actions:true};
 });
 await step('csrf_scope_refusal_and_draft_preservation',async()=>{
  await fill(page,'#composer','Synthetic attachment unsent draft');
  const statuses=await page.evaluate(async({session,first})=>{
   const base='/api/v2/conversations/'+session.global_conversation_id;
   const csrf=(await fetch(base+'/attachments/'+first.manifest_id+'/'+first.references[0].reference_id,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_key:crypto.randomUUID()})})).status;
   const p=await(await fetch('/api/v2/projects',{method:'POST',headers:{'Content-Type':'application/json','x-orkestr-csrf':session.csrf_token},body:JSON.stringify({client_request_id:crypto.randomUUID(),name:'Synthetic foreign file scope'})})).json();
   const scope=(await fetch('/api/v2/conversations/'+p.conversation_id+'/attachment-manifests/'+first.manifest_id)).status;
   return{csrf,scope};
  },{session,first});
  assert.equal(statuses.csrf,403);assert.equal(statuses.scope,404);
  await click(page,'Projects');await page.waitForSelector('#project-name');await click(page,'Assistant');await page.waitForSelector('#composer');await text(page,'Files refreshed.');await waitReady(page);
  assert.equal(await page.$eval('#composer',e=>e.value),'Synthetic attachment unsent draft');return{...statuses,draft_preserved:true};
 });
 await step('logout_aborts_held_list_and_revokes_auth',async()=>{
  network.holdList=true;await click(page,'Refresh files');await waitFor(()=>network.held.length===1,'held_list_missing');
  await click(page,'Sign out');await page.waitForSelector('#username');await waitFor(()=>network.cancelled>0,'logout_read_not_cancelled');
  const status=await page.evaluate(async id=>(await fetch('/api/v2/conversations/'+id+'/attachment-manifests?limit=16')).status,session.global_conversation_id);
  assert.equal(status,401);assert.equal(await page.$(panel),null);return{status,delayed_read_cancelled:true,scope_state_unmounted:true};
 });
}
