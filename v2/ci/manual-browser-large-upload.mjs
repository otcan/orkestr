// Opt-in real disk File + headless Chromium + production JS + real backend.
// No live desktop, profile, credential, connector or business provider is used.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import {build} from 'esbuild';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createReadStream,createWriteStream} from 'node:fs';
import {stat,truncate,writeFile} from 'node:fs/promises';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {join,resolve} from 'node:path';
import {uploadProxy} from './manual-upload-proxy.mjs';
import {scratch,startBackend,chromeLauncher,unitStats,stop,workerEvidence,root,cleanup,SERVICE,WORKER,GROUP} from './manual-upload-system.mjs';

assert.equal(process.env.CI,'true','Headless acceptance only');
assert.equal(process.env.ORKESTR_RUN_BROWSER_1GB,'1','Explicit opt-in required');
const binary=resolve(process.env.V2_SERVER||''),chrome=process.env.CHROME_BIN||'/usr/bin/google-chrome';
const expectedCommit=process.env.EXPECTED_CANDIDATE_COMMIT;assert.match(expectedCommit||'',/^[0-9a-f]{40}$/,'Exact candidate commit required');
const BYTES=1_000_000_000,CHUNK=1024*1024;
const suffix=randomUUID().slice(0,8),backendUnit=`orkestr-upload-test-${suffix}-backend`,browserUnit=`orkestr-upload-test-${suffix}-browser`;
let dir,proxy,browser,backend,stage='initialization';
const report={scope:'real production composer JS helper + Chromium File API + representative loopback reverse proxy + real candidate Rust backend; full WASM composer/production proxy not claimed',service_uid:SERVICE,worker_uid:WORKER,shared_export_gid:GROUP};
const shaFile=async path=>{const hash=createHash('sha256');for await(const b of createReadStream(path))hash.update(b);return hash.digest('hex');};
try{
  dir=await scratch();stage='candidate';
  const candidate=join(dir,'bin/server');root('/usr/bin/cp',[binary,candidate]);root('/usr/bin/chmod',['555',candidate]);
  report.binary_sha256=await shaFile(binary);
  report.candidate_identity=JSON.parse(execFileSync(candidate,['--version','--json'],{encoding:'utf8'}));assert.equal(report.candidate_identity.source_commit,expectedCommit);
  const bundled=await build({stdin:{contents:'export {nativeDescribe} from "./v2/apps/ui/src/attachments/encrypted_composer.mjs"; export {ageEnsureEnrollment} from "./v2/apps/ui/src/attachments/age.mjs";',resolveDir:process.cwd(),sourcefile:'manual-upload-entry.mjs'},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false,minify:true});
  proxy=await uploadProxy(bundled.outputFiles[0].contents);
  report.production_js_bundle_sha256=createHash('sha256').update(bundled.outputFiles[0].contents).digest('hex');
  const portProbe=createServer();await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));const backendPort=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));proxy.setBackend(backendPort);
  const bootstrap='synthetic-browser-upload-bootstrap-000000000000';
  backend=startBackend({binary:candidate,dir,unit:backendUnit,bind:`127.0.0.1:${backendPort}`,origin:proxy.origin,bootstrap});
  for(let n=0;;n++){try{if((await fetch(`${proxy.origin}/api/v2/health`)).ok)break;}catch{}assert.ok(n<150&&backend.exitCode===null,'Candidate startup failed');await new Promise(resolve=>setTimeout(resolve,100));}
  stage='disk-file';const file=join(dir,'source/actual-1gb.bin'),out=createWriteStream(file,{mode:0o600,highWaterMark:CHUNK});
  const expected=createHash('sha256');let count=0,index=0;
  while(count<BYTES+1){const bytes=Buffer.alloc(Math.min(CHUNK,BYTES+1-count),index++%251);expected.update(bytes.subarray(0,Math.max(0,Math.min(bytes.length,BYTES-count))));if(!out.write(bytes))await once(out,'drain');count+=bytes.length;}
  out.end();await once(out,'finish');assert.equal((await stat(file)).size,BYTES+1);report.expected_sha256=expected.digest('hex');
  stage='browser';const launcher=await chromeLauncher(dir,browserUnit,chrome);
  browser=await puppeteer.launch({executablePath:launcher,headless:true,protocolTimeout:1_200_000,timeout:60_000,userDataDir:join(dir,'source/profile'),args:['--no-sandbox','--disable-dev-shm-usage']});
  report.browser_version=await browser.version();const page=await browser.newPage();
  report.browser_sent_bearer=false;
  await page.setRequestInterception(true);page.on('request',request=>{if(request.headers().authorization)report.browser_sent_bearer=true;const url=request.url();if(url.startsWith(proxy.origin)||url.startsWith('data:')||url.startsWith('blob:'))request.continue();else request.abort();});
  await page.goto(proxy.origin,{waitUntil:'networkidle0'});await page.waitForFunction(()=>window.ready);
  stage='synthetic-owner';await page.evaluate(async bootstrap=>{
    const credentials={username:'synthetic-browser-owner',password:'synthetic-browser-password-000000'};
    let response=await fetch('/api/v2/setup',{method:'POST',headers:{'Content-Type':'application/json','x-orkestr-bootstrap':bootstrap},body:JSON.stringify(credentials)});if(response.status!==201)throw Error('setup_failed');
    response=await fetch('/api/v2/browser/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});if(!response.ok)throw Error('login_failed');
    window.session=await response.json();await window.uploadModule.ageEnsureEnrollment({csrf:window.session.csrf_token});
    window.describe=window.uploadModule.nativeDescribe({conversation:window.session.global_conversation_id,csrf:window.session.csrf_token});
  },bootstrap);
  const cookie=(await browser.cookies()).find(cookie=>cookie.name==='orkestr_v2_session');assert.ok(cookie?.httpOnly);assert.equal(cookie.sameSite,'Strict');report.http_only_strict_cookie=true;
  const input=await page.$('#file');stage='actual-limit-plus-one';await input.uploadFile(file);
  const before=proxy.stats.chunk_requests;
  const refused=await page.evaluate(async()=>window.describe(document.querySelector('#file').files));assert.match(refused.error,/1,000,000,000/);assert.equal(proxy.stats.chunk_requests,before);report.actual_disk_limit_plus_one_rejected=true;
  await truncate(file,BYTES);await page.$eval('#file',el=>el.value='');await input.uploadFile(file);
  stage='browser-upload';const started=Date.now();
  const uploaded=await page.evaluate(async()=>window.describe(document.querySelector('#file').files));assert.equal(uploaded.error,undefined);assert.equal(uploaded.receipts.length,1);report.browser_upload_and_prepare_seconds=(Date.now()-started)/1000;
  const receipt=uploaded.receipts[0];assert.equal(receipt.attachments[0].byte_length,BYTES);assert.ok(receipt.note.includes(report.expected_sha256));
  const match=/local file ([^\]]+)/.exec(receipt.note);assert.ok(match);const provider=match[1];
  stage='cross-uid';report.worker_evidence=workerEvidence(dir,provider);assert.equal(report.worker_evidence.bytes,BYTES);assert.equal(report.worker_evidence.sha256,report.expected_sha256);assert.deepEqual(report.worker_evidence.core_and_ingest_key_denied,[true,true]);
  report.proxy={...proxy.stats};assert.equal(proxy.stats.chunk_requests,954);assert.ok(proxy.stats.largest_chunk<=proxy.stats.max_body_bytes);
  stage='proxy-body-limit';const rejected=await fetch(`${proxy.origin}/api/v2/conversations/00000000-0000-4000-8000-000000000001/encrypted-uploads/00000000-0000-4000-8000-000000000002/chunks/0`,{method:'PUT',body:new Uint8Array(proxy.stats.max_body_bytes+1)});assert.equal(rejected.status,413);report.proxy_rejects_oversized_chunk=true;
  report.backend_resources=unitStats(backendUnit);report.browser_resources=unitStats(browserUnit);report.node_rss_bytes=process.memoryUsage().rss;
  assert.equal(report.browser_sent_bearer,false);
  report.pass=true;report.browser_file_bytes=BYTES;report.full_wasm_composer='pending';report.production_reverse_proxy='pending';report.crash_orphan_automatic_cleanup='not tested by this harness';
}catch(error){report.pass=false;report.failed_stage=stage;report.error=error.message;throw error;}
finally{
  await browser?.close().catch(()=>{});stop(browserUnit);stop(backendUnit);await proxy?.close().catch(()=>{});
  if(dir)cleanup(dir);report.scratch_cleaned=true;
  if(process.env.ACCEPTANCE_REPORT)await writeFile(process.env.ACCEPTANCE_REPORT,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({pass:report.pass,stage:report.failed_stage||'complete',bytes:report.browser_file_bytes,sha256:report.expected_sha256,seconds:report.browser_upload_and_prepare_seconds,scratch_cleaned:report.scratch_cleaned}));
}
