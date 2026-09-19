import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

// Execute the actual service with deterministic platform adapters, no browser launch.
async function harness(read = async () => ({ filename:"decoded.txt",bytes:new Uint8Array([65]) })) {
  const source=await fs.readFile(new URL("../apps/web/src/app/attachment-preview.service.ts",import.meta.url),"utf8");
  const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}});
  const workers=[],timers=new Map(); let tick=0;
  class ApiService {} class AttachmentDecryptionService {} class AttachmentEncryptionBootstrapService {}
  const services=new Map([[ApiService,{attachmentFeatures:()=>Promise.resolve({textPreview:true,archivePreview:true,pdfPreview:true,imagePreview:true})}],
    [AttachmentDecryptionService,{read}], [AttachmentEncryptionBootstrapService,{ensureReady:async()=>{}}]]);
  const signal=value=>{const fn=()=>value;fn.set=next=>{value=next;};fn.update=update=>{value=update(value);};return fn;};
  class Worker { constructor(){workers.push(this);} postMessage(value){this.post=value;} terminate(){this.terminated=true;} }
  const exports={}, document={baseURI:"https://example.invalid/",activeElement:{focus(){}}};
  vm.runInNewContext(outputText,{exports,require:name=>{
    if(name==="@angular/core")return {Injectable:()=>value=>value,inject:key=>services.get(key),signal};
    if(name==="rxjs")return {firstValueFrom:value=>value};
    return {ApiService,AttachmentDecryptionService,AttachmentEncryptionBootstrapService};
  },Uint8Array,ArrayBuffer,AbortController,URL,Worker,document,
  setTimeout:callback=>{timers.set(++tick,callback);return tick;},clearTimeout:id=>timers.delete(id)});
  return {service:new exports.AttachmentPreviewService(),workers,timers,document};
}

for (const pending of [false, true]) test(`reload retains the conversation opener through cancellation (pending=${pending})`,async()=>{
  const {service,workers,document}=await harness();
  const focused=[];
  const opener={isConnected:true,closest:()=>null,focus:()=>focused.push("conversation")};
  const reload={isConnected:true,closest:()=>({}),focus:()=>focused.push("reload")};
  document.activeElement=opener;
  if(pending)await service.openPending({name:"fixture.txt",file:{size:1,arrayBuffer:async()=>new Uint8Array([65]).buffer}});
  else await service.openAttachment({filename:"fixture.txt",downloadUrl:"/api/files/a/download"});
  const originalWorker=workers[0];
  document.activeElement=reload;
  service.retry();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(workers.length,2);
  assert.equal(originalWorker.terminated,true);
  originalWorker.onmessage({data:{text:"STALE"}});
  assert.notEqual(service.state().text,"STALE");
  focused.length=0;
  // Even a still-connected Reload button must not become the close target.
  service.close();
  assert.deepEqual(focused,["conversation"]);
  assert.equal(workers[1].terminated,true);
  workers[1].onmessage({data:{text:"LATE"}});
  service.retry();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(workers.length,2);
  assert.equal(service.state().open,false);
});

test("preview identifies selected entry and fences replaced and closed worker replies",async()=>{
  const {service,workers}=await harness();
  await service.openAttachment({filename:"archive.zip",downloadUrl:"/api/files/a/download"});
  const first=workers[0],entry={id:0,name:"folder/report.pdf",size:14,directory:false};
  first.onmessage({data:{archive:true,kind:"archive",entries:[entry]}});
  service.entry(entry); assert.equal(service.state().title,entry.name); assert.equal(service.state().rootTitle,"archive.zip");
  first.onmessage({data:{kind:"pdf",bytes:new Uint8Array([37,80,68,70]),typeLabel:"PDF document"}});
  assert.equal(service.state().title,entry.name);
  await service.openAttachment({filename:"second.txt",downloadUrl:"/api/files/b/download"});
  assert.equal(first.terminated,true);
  first.onmessage({data:{text:"STALE",title:"wrong"}}); assert.equal(service.state().title,"second.txt");
  const second=workers[1]; service.close(); second.onmessage({data:{text:"LATE"}});
  assert.equal(service.state().open,false); assert.equal(service.state().bytes,null); assert.equal(second.terminated,true);
});
test("overall read deadline aborts and fences late decrypted results",async()=>{
  let resolve,receivedSignal,started;
  const readStarted=new Promise(done=>{started=done;});
  const {service,workers,timers}=await harness((_attachment,signal)=>{receivedSignal=signal;started();return new Promise(done=>{resolve=done;});});
  const opening=service.openAttachment({filename:"slow.txt",downloadUrl:"/api/files/slow/download"});
  await readStarted;
  [...timers.values()][0](); assert.equal(receivedSignal.aborted,true); assert.equal(service.state().busy,false);
  resolve({filename:"late.txt",bytes:new Uint8Array([65])}); await opening;
  assert.equal(workers.length,0); assert.equal(service.state().kind,"unsupported");
});
