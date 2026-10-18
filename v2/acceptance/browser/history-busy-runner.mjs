#!/usr/bin/env node
// Connect-only, source-pinned synthetic Deep work; never launch a browser/provider.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {browserLease, provenance, digest, click, value, waitFor, createNetwork} from './history-support.mjs';
async function fill(page,selector,content){
 await page.waitForSelector(selector,{visible:true});await page.focus(selector);
 await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');
 const selected=await page.$eval(selector,e=>({start:e.selectionStart,end:e.selectionEnd,length:e.value.length}));
 assert.equal(selected.start,0,'native_full_selection_start');assert.equal(selected.end,selected.length,'native_full_selection_end');
 await page.keyboard.press('Backspace');assert.equal(await value(page,selector),'','native_clear_failed');
 await page.type(selector,content);
}
const options={};
for(let i=2;i<process.argv.length;i+=2){assert(['--provenance','--lease-receipt','--puppeteer-module','--fixture-harness','--output'].includes(process.argv[i]));assert(!options[process.argv[i]]);options[process.argv[i]]=process.argv[i+1];}
const artifact=await provenance(options['--provenance']);
const lease=await browserLease(options['--lease-receipt']);
const folder=path.resolve(options['--fixture-harness']);
const harnessSource='8a3f91a876a40de00e1b42c879915e9734e58027';
const fixtureHashes={};
for(const name of ['worker-fixture.mjs','worker-fixture.py','worker-artifacts.mjs','support.mjs']){
 const actual=await fs.readFile(path.join(folder,name));
 const tracked=execFileSync('git',['show',`${harnessSource}:v2/acceptance/browser/${name}`],{maxBuffer:1024*1024});
 assert.equal(digest(actual),digest(tracked),'fixture_harness_pin_mismatch');fixtureHashes[name]=digest(actual);
}
const {WorkerFixture,deadline}=await import(pathToFileURL(path.join(folder,'worker-fixture.mjs')));
const {fixtureSource}=await import(pathToFileURL(path.join(folder,'worker-artifacts.mjs')));
const source=await fixtureSource(artifact);
const output=path.resolve(options['--output']);await fs.mkdir(output,{mode:0o700});
const report={status:'running',source:artifact.server.source_sha,server_sha256:artifact.server.sha256,ui:artifact.ui.files,
 fixture_harness_source:harnessSource,fixture_hashes:fixtureHashes,fixture_source:source.hashes,
 harness_sha256:digest(await fs.readFile(new URL(import.meta.url))),checks:[],cleanup:{},page_errors:[]};
let browser,context,fixture,page;
try{
 fixture=new WorkerFixture({artifact,source:source.path,mode:'tasks',output});fixture.info=await deadline(fixture.ready,15000,'fixture_start_timeout');
 const module=await import(pathToFileURL(path.resolve(options['--puppeteer-module'])));
 browser=await module.default.connect({browserURL:lease.browserURL,protocolTimeout:45000});
 context=await browser.createBrowserContext();assert.equal((await context.cookies()).length,0);
 page=await context.newPage();page.setDefaultTimeout(10000);await page.setViewport({width:1280,height:900});await page.setCacheEnabled(false);await page.setBypassServiceWorker(true);
 page.on('pageerror',e=>report.page_errors.push(digest(e.message)));
 const network=await createNetwork(page,fixture.info.origin);
 const cold=performance.now();await page.goto(fixture.info.origin,{waitUntil:'domcontentloaded'});await page.waitForSelector('#username');
 report.checks.push({name:'cold_signin_ready',ms:Math.round(performance.now()-cold)});
 await fill(page,'#username','synthetic-owner');await fill(page,'#password','synthetic-password-ordinary-http');await click(page,'Continue');await page.waitForSelector('#composer');
 await fill(page,'#composer','synthetic ordinary HTTP input');await click(page,'Send');
 await waitFor(async()=>{const s=await fixture.request('summary');return s.runs.some(r=>r.role==='deep'&&r.state==='running');},'synthetic_deep_not_running');
 const opens=[];let phase='cold';page.on('response',response=>{if(response.url().startsWith(fixture.info.origin)&&!new URL(response.url()).pathname.startsWith('/api/'))opens.push({phase,path:new URL(response.url()).pathname,from_cache:response.fromCache(),status:response.status(),cache_control:response.headers()['cache-control'],revalidation:response.request().headers()['if-none-match']||null});});
 // The fresh context's first load disabled cache. Enable caching before the
 // first authenticated reload so it populates bytes used by the warm reload.
 await page.setCacheEnabled(true);
 const opened=performance.now();await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('#composer');
 report.checks.push({name:'cold_authenticated_open_during_running_deep',ms:Math.round(performance.now()-opened)});
 phase='warm';const warm=performance.now();await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('#composer');
 report.checks.push({name:'warm_authenticated_open_during_running_deep',ms:Math.round(performance.now()-warm)});
 report.authenticated_open_assets=opens;
 assert(opens.some(r=>r.phase==='warm'&&r.path.endsWith('.wasm')),'warm_reload_wasm_not_observed');
 report.open_measurement_scope='First and repeated authenticated reload in the same initialized browser/context; HTTP cache hits are recorded, never assumed. Not fresh-browser launch timing.';
 const start=performance.now();const readings=[];
 await page.evaluate(()=>{window.__frames=[];let last=performance.now();window.__runningFrames=true;function tick(now){if(!window.__runningFrames)return;window.__frames.push(now-last);last=now;if(window.__frames.length>10000)window.__frames.shift();requestAnimationFrame(tick);}requestAnimationFrame(tick);});
 while(performance.now()-start<30000){
  const at=performance.now();const draft=`Unsent synthetic work-in-progress draft ${readings.length}`;
  await fill(page,'#composer',draft);assert.equal(await value(page,'#composer'),draft);
  readings.push({at_ms:Math.round(at-start),input_ms:Math.round(performance.now()-at)});
  await delay(1000);
 }
 const summary=await fixture.request('summary');assert(summary.runs.some(r=>r.role==='deep'&&r.state==='running'),'deep_did_not_remain_running');
 const frames=await page.evaluate(()=>{window.__runningFrames=false;return window.__frames;});
 const maxInput=Math.max(...readings.map(r=>r.input_ms)),maxFrame=Math.round(Math.max(...frames));
 assert(maxInput<2000,'busy_composer_input_exceeded');assert(maxFrame<250,'busy_render_frame_exceeded');
 report.checks.push({name:'thirty_seconds_running_deep_editability',duration_ms:Math.round(performance.now()-start),readings,max_input_ms:maxInput,max_frame_ms:maxFrame,execution_reads:network.executionReads,synthetic_run:summary.runs,real_provider:false});
 assert.equal(network.externalRequests,0);assert.equal(report.page_errors.length,0);report.status='passed';
}catch(error){report.status='failed';report.failure={message:String(error.message),stack:String(error.stack).split('\n').slice(0,5)};}
finally{
 try{if(context)await context.close();report.cleanup.context_closed=true;}catch{report.status='failed';}
 if(browser)browser.disconnect();
 try{if(fixture)report.cleanup.fixture=await fixture.stop();}catch(e){report.status='failed';report.cleanup.failure=String(e.message);}
 await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify({status:report.status,checks:report.checks,cleanup:report.cleanup,failure:report.failure}));
if(report.status!=='passed')process.exitCode=1;
