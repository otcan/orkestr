// Opt-in actual WASM UI + disk File + real API/Core + isolated Caddy.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createReadStream,createWriteStream} from 'node:fs';
import {stat,truncate,writeFile,readdir,readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {join,resolve} from 'node:path';
import {composerProxy} from './manual-composer-proxy.mjs';
import {caddyProxy} from './manual-upload-caddy.mjs';
import {rssSampler} from './manual-upload-rss.mjs';
import {scratch,startBackend,provisionBootstrap,chromeLauncher,unitStats,stop,workerEvidence,root,cleanup,SERVICE,WORKER,GROUP} from './manual-upload-system.mjs';
import {submitLogin} from './headless-login.mjs';
import {installIntakeCapture} from './headless-receipt-capture.mjs';
assert.equal(process.env.CI,'true');assert.equal(process.env.ORKESTR_RUN_WASM_1GB,'1');
const binary=resolve(process.env.V2_SERVER||''),bundle=resolve(process.env.UI_BUNDLE_DIR||'');
const commit=process.env.EXPECTED_CANDIDATE_COMMIT;assert.match(commit||'',/^[0-9a-f]{40}$/);
const BYTES=Number(process.env.ORKESTR_ACCEPTANCE_BYTES||1_000_000_000),CHUNK=1024*1024;
assert.ok([CHUNK,1_000_000_000].includes(BYTES));
const suffix=randomUUID().slice(0,8),backendUnit=`orkestr-wasm-test-${suffix}-backend`,browserUnit=`orkestr-wasm-test-${suffix}-browser`,caddyUnit=`orkestr-wasm-test-${suffix}-caddy`;
let dir,proxy,caddy,browser,backend,page,finishRss,stage='initialization';
const report={scope:'real WASM composer, login, browser security, age enrollment/chunks/ingest, durable Core message and cross-UID provider file; synthetic authenticated GET beta discovery only; no provider execution',service_uid:SERVICE,worker_uid:WORKER,shared_gid:GROUP};
const shaFile=async path=>{const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');};
const errors=[],network=[];
try{
  dir=await scratch();stage='candidate';const candidate=join(dir,'bin/server');root('/usr/bin/cp',[binary,candidate]);root('/usr/bin/chmod',['555',candidate]);
  report.binary_sha256=await shaFile(binary);report.candidate_identity=JSON.parse(execFileSync(candidate,['--version','--json'],{encoding:'utf8'}));assert.equal(report.candidate_identity.source_commit,commit);
  report.ui_files={};const paths=[''];while(paths.length){const prefix=paths.pop();for(const entry of await readdir(join(bundle,prefix),{withFileTypes:true})){const name=prefix?prefix+'/'+entry.name:entry.name;if(entry.isDirectory())paths.push(name);else if(entry.isFile())report.ui_files[name]=await shaFile(join(bundle,name));else throw Error('Bundle alias refused');}assert.ok(Object.keys(report.ui_files).length<=4096);} 
  const wasm=await readFile(join(bundle,'orkestr_v2_ui_bg.wasm'));assert.ok(wasm.includes(Buffer.from(`ORKESTR_V2_BUILD_IDENTITY_V1|web|2.0.0-beta.6|${commit}|END`)));report.web_source_commit=commit;
  proxy=await composerProxy(bundle);caddy=await caddyProxy(dir,caddyUnit,proxy.origin);
  report.proxy={kind:'isolated Caddy using live target relevant flush=-1 and no explicit body/response-timeout constraints; production listener not exercised',config_sha256:createHash('sha256').update(JSON.stringify(caddy.config)).digest('hex')};
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));proxy.setBackend(port);
  const bootstrap=randomBytes(32).toString('hex');await provisionBootstrap(dir,bootstrap);
  backend=startBackend({binary:candidate,dir,unit:backendUnit,bind:`127.0.0.1:${port}`,origin:caddy.origin});
  for(let n=0;;n++){try{if((await fetch(`${caddy.origin}/api/v2/health`)).ok)break;}catch{}assert.ok(n<150&&backend.exitCode===null,'Backend startup failed');await new Promise(resolve=>setTimeout(resolve,100));}
  stage='disk-file';const file=join(dir,'source/wasm-attachment.bin'),out=createWriteStream(file,{mode:0o600,highWaterMark:CHUNK}),hash=createHash('sha256');
  let count=0,index=0;while(count<BYTES+1){const bytes=Buffer.alloc(Math.min(CHUNK,BYTES+1-count),index++%251);hash.update(bytes.subarray(0,Math.max(0,Math.min(bytes.length,BYTES-count))));if(!out.write(bytes))await once(out,'drain');count+=bytes.length;}out.end();await once(out,'finish');report.expected_sha256=hash.digest('hex');assert.equal((await stat(file)).size,BYTES+1);
  const launcher=await chromeLauncher(dir,browserUnit,process.env.CHROME_BIN||'/usr/bin/google-chrome');browser=await puppeteer.launch({executablePath:launcher,headless:true,protocolTimeout:1_200_000,timeout:60_000,userDataDir:join(dir,'source/profile'),args:['--no-sandbox','--disable-dev-shm-usage']});report.browser_version=await browser.version();page=await browser.newPage();
  report.browser_sent_bearer=false;await page.setRequestInterception(true);page.on('request',request=>{if(request.headers().authorization)report.browser_sent_bearer=true;const url=request.url();if(url.startsWith(caddy.origin)||url.startsWith('data:')||url.startsWith('blob:'))request.continue();else request.abort();});
  page.on('pageerror',error=>errors.push(error.message));page.on('response',response=>{const url=new URL(response.url());if(url.origin===caddy.origin&&url.pathname.startsWith('/api/v2/')){network.push({path:url.pathname.replace(/[0-9a-f-]{36}/g,':id'),status:response.status()});if(network.length>100)network.shift();if(url.pathname==='/api/v2/browser/security')report.actual_security_status=response.status();}});
  const click=async text=>assert.ok(await page.evaluate(text=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===text);if(!b)return false;b.click();return true;},text),`Missing ${text}`);
  stage='real-wasm-login';await page.goto(caddy.origin,{waitUntil:'networkidle2'});await page.waitForSelector('#username');await click('First-time setup');await page.type('#username','synthetic-wasm-owner');await page.type('#password','synthetic-wasm-password-000000');await page.type('#bootstrap',bootstrap);await submitLogin(page,caddy.origin,click,true);await page.waitForSelector('#composer');
  finishRss=rssSampler({backend:backendUnit,browser:browserUnit,caddy:caddyUnit});
  stage='real-key-enrollment';await page.waitForSelector('[data-attachment-key="enrolled"]');assert.equal(report.actual_security_status,200);report.real_ui_age_enrollment=true;
  const session=await page.evaluate(async()=>{const r=await fetch('/api/v2/browser/session');if(!r.ok)throw Error('session unavailable');return r.json();});const conversation=session.global_conversation_id;
  const choose=async()=>{const [chooser]=await Promise.all([page.waitForFileChooser(),page.click('.message-composer button[aria-label="Attach a file or image"]')]);await chooser.accept([file]);};
  if(BYTES===1_000_000_000){stage='real-wasm-limit-plus-one';const before=proxy.stats.chunk_requests;await choose();await page.waitForFunction(()=>document.querySelector('.composer-tools')?.textContent.includes('1,000,000,000'));assert.equal(proxy.stats.chunk_requests,before);report.actual_disk_plus_one_rejected=true;}
  else report.actual_disk_plus_one_rejected='not exercised by1MiB smoke';
  await truncate(file,BYTES);stage='real-wasm-upload';const started=Date.now();await choose();await page.waitForFunction(()=>document.querySelector('.attachment-chip .chip-name')?.textContent==='wasm-attachment.bin',{timeout:1_200_000});report.upload_prepare_seconds=(Date.now()-started)/1000;
  assert.equal(proxy.stats.chunk_requests,Math.ceil(BYTES/CHUNK));assert.equal(proxy.stats.attachment_posts,1);assert.ok(proxy.stats.largest_chunk<1_114_112);
  stage='actual-send';const messagePath=`/api/v2/conversations/${conversation}/messages`;await page.evaluate(installIntakeCapture,messagePath);await page.type('#composer','Synthetic real WASM attachment acceptance');await click('Send');await page.waitForFunction(()=>globalThis.__orkestrCIReceipt?.state==='complete',{timeout:30_000});const captured=await page.evaluate(()=>globalThis.__orkestrCIReceipt);assert.equal(captured.status,202);assert.equal(captured.body.status,'accepted');
  const history=await page.evaluate(async conversation=>{const r=await fetch(`/api/v2/conversations/${conversation}?after=0&limit=100`);if(!r.ok)throw Error('history unavailable');return r.json();},conversation);assert.equal(history.messages.length,1);const message=history.messages[0];assert.equal(message.message_id,captured.body.message_id);assert.ok(message.text.includes(report.expected_sha256));assert.ok(message.text.includes(`${BYTES} bytes`));
  const provider=/local file ([^\]]+)/.exec(message.text)?.[1];assert.ok(provider);report.worker_evidence=workerEvidence(dir,provider);assert.equal(report.worker_evidence.bytes,BYTES);assert.equal(report.worker_evidence.sha256,report.expected_sha256);assert.deepEqual(report.worker_evidence.core_bootstrap_ingest_denied,[true,true,true]);
  report.durable_message={message_id:message.message_id,sequence:message.sequence,text_sha256:createHash('sha256').update(message.text).digest('hex'),attachment_bytes:BYTES,attachment_sha256:report.expected_sha256,provider_path_scope_verified:provider.startsWith(join(dir,'exports')+'/')};assert.ok(report.durable_message.provider_path_scope_verified);
  report.core_sqlite_readonly=JSON.parse(root('/usr/bin/python3',['-I','-S','-B','-c',`import sqlite3,sys,json,hashlib
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);c.execute('PRAGMA query_only=ON')
rows=c.execute('SELECT text,sequence FROM messages WHERE id=? AND conversation_id=?',(sys.argv[2],sys.argv[3])).fetchall()
assert len(rows)==1
print(json.dumps({'rows':len(rows),'sequence':rows[0][1],'text_sha256':hashlib.sha256(rows[0][0].encode()).hexdigest()}));c.close()`,join(dir,'home/core.sqlite3'),message.message_id,conversation]));
  assert.equal(report.core_sqlite_readonly.text_sha256,report.durable_message.text_sha256);assert.equal(report.core_sqlite_readonly.sequence,message.sequence);
  stage='reload-history';await page.reload({waitUntil:'networkidle2'});await page.waitForFunction(()=>document.querySelector('.chat-messages')?.textContent.includes('Synthetic real WASM attachment acceptance'));assert.equal(await page.$$('.attachment-chip').then(x=>x.length),0);report.reload_durable_message_rendered=true;
  report.backend_resources=unitStats(backendUnit);report.browser_resources=unitStats(browserUnit);report.caddy_resources=unitStats(caddyUnit);report.node_rss_bytes=process.memoryUsage().rss;report.api_stats={...proxy.stats};report.rendering_error_count=errors.length;assert.equal(report.browser_sent_bearer,false);assert.deepEqual(errors,[]);report.pass=true;report.actual_file_bytes=BYTES;report.provider_execution='not exercised';
}catch(error){report.pass=false;report.failed_stage=stage;report.error=error.message;report.network=network;throw error;}
finally{if(finishRss)report.rss_samples=finishRss();await browser?.close().catch(()=>{});stop(browserUnit);stop(backendUnit);await caddy?.close();stop(caddyUnit);await proxy?.close().catch(()=>{});if(dir)cleanup(dir);report.scratch_cleaned=true;if(process.env.ACCEPTANCE_REPORT)await writeFile(process.env.ACCEPTANCE_REPORT,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({pass:report.pass,stage:report.failed_stage||'complete',bytes:report.actual_file_bytes,sha256:report.expected_sha256,seconds:report.upload_prepare_seconds,scratch_cleaned:report.scratch_cleaned}));}
