// Mounted real WASM A -> B -> rollback with immutable old assets and a fixed
// synthetic API process. This never changes a live proxy or executes providers.
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';
import {createManifest,prepareSnapshot} from '../apps/ui/scripts/ui_release.mjs';
import {A,startMock} from './headless-workspace-mock.mjs';
import {latch,proxyFixture} from './headless-ui-release-fixture.mjs';

assert.equal(process.env.CI,'true','Synthetic browser acceptance only');
assert.ok(process.env.UI_BUNDLE_DIR,'UI_BUNDLE_DIR required');
const scratch=await realpath(await mkdtemp(join(tmpdir(),'orkestr-ui-release-browser-')));
const profile={format:'orkestr-ui-backend-profile-v1',source_commit:'c'.repeat(40),server_sha256:'d'.repeat(64),code_subject_sha256:'e'.repeat(64),api_contract_version:0,features:[]};
const snapshots=[];let browser,api,proxy;
const errors=[];
const holds=[];
async function bounded(promise,label){
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Timed out: '+label)),20000))]);}finally{clearTimeout(timer);}
}
try{
  for(const [label,source]of [['A','a'.repeat(40)],['B','b'.repeat(40)]]){
    const bundle=join(scratch,'bundle-'+label);await cp(process.env.UI_BUNDLE_DIR,bundle,{recursive:true});
    const main=join(bundle,'orkestr_v2_ui.js');await writeFile(main,(await readFile(main,'utf8'))+`\nglobalThis.__syntheticUiRelease='${label}';\n`);
    const manifest=await createManifest(bundle,source,[profile.source_commit],{api_contract_version:0,required_server_features:[]});
    const directory=join(scratch,'snapshot-'+label);
    const plan=await prepareSnapshot({bundle,manifest,approvedBackend:profile,observedBackend:profile,output:directory});
    snapshots.push({directory,manifest,plan});
  }
  api=await startMock(process.env.UI_BUNDLE_DIR);proxy=await proxyFixture(api.origin,snapshots);
  const backendProcess=process.pid;
  browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});
  async function page(){
    const page=await browser.newPage();await page.setCacheEnabled(false);await page.setRequestInterception(true);
    page.on('request',request=>request.url().startsWith(proxy.origin+'/')||/^(data|blob):/.test(request.url())?request.continue():request.abort());
    page.on('pageerror',error=>errors.push(error.message));
    await page.setCookie({name:'synthetic-owner',value:'public-test-cookie',url:proxy.origin,path:'/api',httpOnly:true});
    return page;
  }
  const first=await page();
  const mainHold={path:snapshots[0].plan.asset_prefix+'orkestr_v2_ui.js',seen:latch(),resume:latch()};proxy.state.mainHold=mainHold;
  holds.push(mainHold);
  const opening=first.goto(`${proxy.origin}/#conversation/${A}`,{waitUntil:'domcontentloaded'});
  await bounded(mainHold.seen.promise,'A module request');proxy.state.active=snapshots[1].plan.release_id;mainHold.resume.release();
  await opening;await first.waitForSelector('#composer');
  assert.equal(await first.evaluate(()=>globalThis.__syntheticUiRelease),'A','old HTML finishes loading A after B promotion');
  const helperHold={path:snapshots[1].plan.asset_prefix+'encrypted_upload.js',seen:latch(),resume:latch()};proxy.state.mainHold=helperHold;holds.push(helperHold);
  const second=await page();await second.goto(`${proxy.origin}/#conversation/${A}`,{waitUntil:'domcontentloaded'});await second.waitForSelector('#composer');
  assert.equal(await second.evaluate(()=>globalThis.__syntheticUiRelease),'B');
  await bounded(helperHold.seen.promise,'B native helper request');

  // Pause the receipt of A's first committed ciphertext chunk, roll the root
  // bootstrap back, and finish the same upload without another business input.
  const chunkHold={seen:latch(),resume:latch()};proxy.state.chunkHold=chunkHold;
  holds.push(chunkHold);
  const file=join(scratch,'synthetic-release-file.bin');await writeFile(file,Buffer.alloc(2*1024*1024+19,0x71));
  const picker=first.waitForFileChooser();await first.click('button[aria-label="Attach a file or image"]');await(await picker).accept([file]);
  await bounded(chunkHold.seen.promise,'A encrypted chunk receipt');proxy.state.active=snapshots[0].plan.release_id;chunkHold.resume.release();helperHold.resume.release();
  await first.waitForFunction(()=>document.querySelector('.attachment-chip'));
  assert.equal(api.state.uploads.length,1);assert.equal(api.state.uploads[0].encrypted,true);
  assert.equal(Buffer.from(api.state.uploads[0].files[0].content_base64,'base64').length,2*1024*1024+19);
  // B's lazy helper remains B even after root rollback to A.
  const bPicker=second.waitForFileChooser();await second.click('button[aria-label="Attach a file or image"]');await(await bPicker).cancel();
  await second.waitForFunction(()=>!document.querySelector('button[aria-label="Attach a file or image"]').disabled);
  const requests=proxy.state.requests;
  for(const snapshot of snapshots){
    assert.ok(requests.some(r=>r.path===snapshot.plan.asset_prefix+'encrypted_upload.js'),'each old page imports its own native upload helper');
    assert.ok(requests.some(r=>r.path===snapshot.plan.asset_prefix+'orkestr_v2_ui_bg.wasm'),'each page loads its own WASM');
    assert.ok(requests.some(r=>r.path.startsWith(snapshot.plan.asset_prefix+'snippets/')),'snippet imports retain the namespace');
  }
  assert.ok(!requests.some(r=>r.path==='/encrypted_upload.js'),'namespaced pages never select the current root helper');
  assert.ok(proxy.state.responses.some(r=>r.path===helperHold.path&&r.active===snapshots[0].plan.release_id),'retained B helper is served after rollback to A');
  const last=await page();await last.goto(`${proxy.origin}/#conversation/${A}`,{waitUntil:'domcontentloaded'});await last.waitForSelector('#composer');
  assert.equal(await last.evaluate(()=>globalThis.__syntheticUiRelease),'A','rollback affects only new bootstrap reads');
  await first.$eval('#composer',node=>{node.value='Synthetic UI release continuity';node.dispatchEvent(new Event('input',{bubbles:true}));});
  await first.focus('#composer');await first.keyboard.press('Enter');
  await first.waitForFunction(()=>document.querySelector('#composer')?.value==='');
  const end=Date.now()+20000;
  while(!api.state.messages[A].some(row=>row.text?.includes('Synthetic UI release continuity'))){assert.ok(Date.now()<end,'API acceptance timed out');await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(api.state.messages[A].filter(row=>row.text?.includes('Synthetic UI release continuity')).length,1);
  assert.ok(requests.some(r=>r.path.endsWith('/messages')&&r.method==='POST'&&r.csrf==='synthetic-csrf'&&r.cookie?.includes('synthetic-owner=public-test-cookie')),'owner cookie and CSRF reach the unchanged API');
  assert.equal(process.pid,backendProcess);
  const root=await fetch(proxy.origin),tag=root.headers.get('etag');assert.equal(root.headers.get('cache-control'),'public, no-cache');
  assert.equal((await fetch(proxy.origin,{headers:{'if-none-match':tag}})).status,304);
  const asset=await fetch(proxy.origin+snapshots[1].plan.asset_prefix+'encrypted_upload.js');assert.match(asset.headers.get('cache-control'),/immutable/);assert.equal(asset.headers.get('x-content-type-options'),'nosniff');
  assert.equal((await fetch(proxy.origin+'/_ui/'+('0'.repeat(64))+'/missing.js')).status,404);
  if(process.env.SCREENSHOT_DIR){await mkdir(process.env.SCREENSHOT_DIR,{recursive:true});await first.screenshot({path:join(process.env.SCREENSHOT_DIR,'ui-release-old-A-after-rollback.png')});await second.screenshot({path:join(process.env.SCREENSHOT_DIR,'ui-release-retained-B.png')});}
  assert.deepEqual(errors,[]);
  console.log('Mounted UI A -> B -> rollback passed; retained imports/upload and one synthetic API input; fixed fixture process');
}finally{
  for(const hold of holds)hold.resume.release();
  await browser?.close();for(const server of [proxy?.server,api?.server])if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await rm(scratch,{recursive:true,force:true});
}
