#!/usr/bin/env node
// Connect only to an already leased registered browser. Never launch Chrome.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Candidate,browserLease,digest} from './history-support.mjs';
import {attachmentScenarios,installProbe} from './attachment-scenarios.mjs';
const options={};
for(let i=2;i<process.argv.length;i++){const key=process.argv[i];assert(['--pair','--pair-sha','--lease','--output','--puppeteer-module','--verify-only'].includes(key));assert(!(key in options));options[key]=key==='--verify-only'?true:process.argv[++i];assert(options[key]);}
const pairBytes=await fs.readFile(options['--pair']);assert.equal(digest(pairBytes),options['--pair-sha'],'pair_receipt_hash');
const pair=JSON.parse(pairBytes);assert(/^[a-f0-9]{40}$/.test(pair.source_commit));assert.equal(pair.compiled_cargo_version,'2.0.0-dev');
assert.equal(digest(await fs.readFile(pair.server.path)),pair.server.sha256);
assert.equal(pair.embedded_identity.server,'ORKESTR_V2_BUILD_IDENTITY_V1|server|2.0.0-dev|'+pair.source_commit+'|END');
assert.equal(pair.embedded_identity.web,'ORKESTR_V2_BUILD_IDENTITY_V1|web|2.0.0-dev|'+pair.source_commit+'|END');
const uiFiles={};
for(const [name,entry]of Object.entries(pair.web.files)){assert(!name.includes('..')&&!path.isAbsolute(name));const bytes=await fs.readFile(path.join(pair.web.path,name));assert.equal(bytes.length,entry.bytes);assert.equal(digest(bytes),entry.sha256);uiFiles[name]=entry.sha256;}
const artifact={server:{path:pair.server.path},ui:{path:pair.web.path}};
const here=path.dirname(fileURLToPath(import.meta.url));
const harness=Object.fromEntries(await Promise.all(['attachment-runner.mjs','attachment-scenarios.mjs','history-support.mjs'].map(async name=>[name,digest(await fs.readFile(path.join(here,name)))])));
if(options['--verify-only']){console.log(JSON.stringify({status:'verified',source:pair.source_commit,files:Object.keys(uiFiles).length,harness}));process.exit(0);}
const lease=await browserLease(options['--lease']);const output=path.resolve(options['--output']);
await fs.mkdir(output,{mode:0o700});const downloads=path.join(output,'downloads');await fs.mkdir(downloads,{mode:0o700});
const root=await fs.mkdtemp(path.join(os.tmpdir(),'orkestr-v2-attachment-browser-'));await fs.chmod(root,0o700);
const report={schema_version:1,status:'running',started_at:new Date().toISOString(),stage:'start',source:pair.source_commit,
 pair_sha256:digest(pairBytes),server_sha256:pair.server.sha256,web_files:uiFiles,harness_sha256:harness,
 scope:{synthetic_files:true,production_access:false,provider_execution:false,browser_launched:false,existing_pages_accessed:false},
 checks:[],network:[],page_errors:[],cleanup:{}};
let candidate,browser,context,page,session;
const network={holdList:false,held:[],cancelled:0,external:0,failures:0};
try{
 const guard=net.createServer();await new Promise((resolve,reject)=>{guard.once('error',reject);guard.listen(47130,'127.0.0.1',resolve);});await new Promise(resolve=>guard.close(resolve));
 candidate=await Candidate.create(artifact,root);await candidate.start();
 const health=await(await fetch(candidate.origin+'/api/v2/health')).json();assert.equal(health.build.source_commit,pair.source_commit,'served_source_identity');
 for(const[name,sha]of Object.entries(uiFiles)){const r=await fetch(candidate.origin+'/'+name,{redirect:'error',signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);assert.equal(digest(Buffer.from(await r.arrayBuffer())),sha,'served_asset_identity');}
 const puppeteer=(await import(pathToFileURL(path.resolve(options['--puppeteer-module'])).href)).default;
 browser=await puppeteer.connect({browserURL:lease.browserURL,protocolTimeout:30000});report.browser_version=await browser.version();
 context=await browser.createBrowserContext();assert.equal((await context.cookies()).length,0);
 session=await browser.target().createCDPSession();
 await session.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,browserContextId:context.id,eventsEnabled:true});
 page=await context.newPage();await page.setViewport({width:1280,height:900});await page.setCacheEnabled(false);await page.setBypassServiceWorker(true);await page.bringToFront();page.setDefaultTimeout(12000);
 await page.evaluateOnNewDocument(installProbe);
 page.on('pageerror',error=>{if(report.page_errors.length<20)report.page_errors.push({name:error.name,sha256:digest(error.message)});});
 const cdp=await page.createCDPSession();await cdp.send('Network.enable');const inflight=new Map();
 cdp.on('Network.requestWillBeSent',e=>{inflight.set(e.requestId,e.request.url);});
 cdp.on('Network.loadingFinished',e=>inflight.delete(e.requestId));
 cdp.on('Network.loadingFailed',e=>{if(e.canceled&&inflight.get(e.requestId)?.includes('/attachment-manifests?'))network.cancelled++;inflight.delete(e.requestId);});
 await page.setRequestInterception(true);
 page.on('request',request=>{void(async()=>{
  const u=new URL(request.url());if(u.origin!==candidate.origin){if(['blob:','data:','about:'].includes(u.protocol))return request.continue();network.external++;return request.abort();}
  if(request.headers().authorization)throw new Error('browser_bearer_forbidden');
  if(request.method()==='GET'&&request.headers()['x-orkestr-csrf'])throw new Error('get_csrf_forbidden');
  if(network.holdList&&u.pathname.endsWith('/attachment-manifests')&&request.method()==='GET'){network.holdList=false;network.held.push(request);return;}
  await request.continue();
 })().catch(()=>network.failures++);});
 page.on('response',response=>{const u=new URL(response.url());if(u.origin===candidate.origin&&report.network.length<500)report.network.push({method:response.request().method(),path:u.pathname.replace(/[a-f0-9-]{36}/g,':id'),status:response.status(),...(u.pathname.includes('/attachments/')?{length:response.headers()['content-length'],type:response.headers()['content-type'],nosniff:response.headers()['x-content-type-options']}:{} )});});
 await attachmentScenarios({page,context,candidate,report,output,downloads,network});
 assert.equal(report.page_errors.length,0,'browser_javascript_errors');assert.equal(network.external,0,'external_request');assert.equal(network.failures,0,'interception_failure');
 await page.screenshot({path:path.join(output,'result.png'),fullPage:true});report.status='passed';
}catch(error){report.status='failed';report.failure={name:error.name,message:String(error.message),sha256:digest(String(error.stack))};
 await fs.writeFile(path.join(output,'failure.txt'),String(error.stack),{mode:0o600});if(page&&!page.isClosed()){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(output,'failure-dom.txt'),await page.evaluate(()=>document.body.innerText).catch(()=>''),{mode:0o600});}
}finally{
 for(const request of network.held)await request.abort().catch(()=>{});
 try{if(context)await context.close();report.cleanup.owned_context_closed=true;}catch{report.cleanup.owned_context_closed=false;report.status='failed';}
 await session?.detach().catch(()=>{});browser?.disconnect();report.cleanup.shared_browser_left_running=true;
 try{await candidate?.stop();report.cleanup.owned_server_reaped=true;await fs.rm(root,{recursive:true,force:true});report.cleanup.synthetic_state_removed=true;}catch{report.cleanup.owned_server_reaped=false;report.status='failed';}
 report.network_summary={external_requests:network.external,interception_failures:network.failures,cancelled_list_reads:network.cancelled};
 report.finished_at=new Date().toISOString();await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:report.status,checks:report.checks.length,stage:report.stage,receipt:path.join(output,'receipt.json')}));
}
process.exitCode=report.status==='passed'?0:1;
