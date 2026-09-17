import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { of, from } from "rxjs";
import * as age from "age-encryption";
const require=createRequire(import.meta.url);
async function moduleUrl(file, replacements={}) {
  const source=await fs.readFile(new URL(file,import.meta.url),"utf8");
  let compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
  compiled=compiled.replace(/from "([^"]+)"/g,(_,specifier)=>`from "${replacements[specifier] || pathToFileURL(require.resolve(specifier)).href}"`);
  return "data:text/javascript;base64,"+Buffer.from(compiled).toString("base64");
}
const uploadsUrl=await moduleUrl("../apps/web/src/app/thread-uploads.ts",{
  "../../../../packages/core/src/browser-inbound-attachment-payload.js":new URL("../packages/core/src/browser-inbound-attachment-payload.js",import.meta.url).href,
});
const {uploadPendingFiles,recoverInboundUploadDraft}=await import(uploadsUrl);
const {DraftUploadQueue}=await import(await moduleUrl("../apps/web/src/app/draft-upload-queue.ts",{"./thread-uploads":uploadsUrl}));
const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check){for(let i=0;i<300;i++){if(check())return;await pause();}assert.fail("browser upload did not settle");}
async function fixture() {
  const identity=await age.generateIdentity(),recipient=await age.identityToRecipient(identity);
  const store=new Map(),calls=[];
  globalThis.sessionStorage={setItem(){},removeItem(){},getItem(){return null;}};
  const api={
    inboundAttachmentUploadStatus:()=>of({enabled:true,ready:true}),
    createInboundAttachmentUploadSessions:(thread,files)=>{
      calls.push(["create",thread]);
      return of({sessions:files.map(file=>{
        const session={id:file.idempotencyKey,state:"receiving",descriptor:{sessionId:file.idempotencyKey,keyId:"test-key",signature:"test-signature",recipient}};
        store.set(session.id,session);return session;
      })});
    },
    inboundAttachmentUploadSession:id=>of({session:store.get(id)}),
    uploadInboundAttachmentCiphertext:async(id,stream)=>{calls.push(["ciphertext",id]);const wire=new Uint8Array(await new Response(stream).arrayBuffer());assert.equal(Buffer.from(wire).includes(Buffer.from("secret paste")),false);const s=store.get(id);s.state="quarantined";return s;},
    processInboundAttachmentUpload:id=>{const s=store.get(id);s.state="ready";s.attachment={uploadSessionId:id,filename:"note.txt"};return of({session:s});},
    cancelInboundAttachmentUpload:id=>{calls.push(["cancel",id]);const s=store.get(id);if(s)s.state="cancelled";return of({session:s});},
    uploadThreadFiles:()=>{assert.fail("plaintext fallback forbidden");},
  };
  return {api,calls,store};
}
test("selection immediately encrypts/uploads without Send and stays scoped to its thread",async()=>{
  const {api,calls}=await fixture();const q=new DraftUploadQueue(api,()=>{});
  q.add("thread-a",[new File(["secret paste"],"note.txt")]);
  q.add("thread-b",[new File(["other"],"other.txt")]);
  await until(()=>q.files("thread-b")[0]?.uploadState==="ready");
  assert.deepEqual(calls.filter(x=>x[0]==="create").map(x=>x[1]),["thread-a","thread-b"]);
  assert.equal(q.files("thread-a")[0].uploadState,"ready");
  const ready=q.files("thread-a");api.inboundAttachmentUploadStatus=()=>of({enabled:false,ready:false});
  assert.equal((await uploadPendingFiles(api,"thread-a",ready)).length,1,"ready drafts can send while intake paused");
});
test("configuration changing during eager upload cannot enable plaintext fallback",async()=>{
  const {api,calls}=await fixture();let reads=0;
  api.inboundAttachmentUploadStatus=()=>of({enabled:++reads===1,ready:true});
  const q=new DraftUploadQueue(api,()=>{});q.add("thread-a",[new File(["secret paste"],"note.txt")]);
  await until(()=>q.files("thread-a")[0]?.uploadState==="retryable");
  assert.match(q.files("thread-a")[0].uploadError,/Encrypted uploads are unavailable/);
  assert.equal(calls.length,0);
});
test("reload retains recovery references when session lookup is unavailable",async()=>{
  const {api}=await fixture();let saved=JSON.stringify({version:1,sessions:[{id:"draft-a",sessionId:"session-a"}]});
  globalThis.sessionStorage={getItem:()=>saved,setItem:(_key,value)=>{saved=value;},removeItem:()=>{saved=null;}};
  api.inboundAttachmentUploadSession=()=>from(Promise.reject(Error("offline")));
  const files=await recoverInboundUploadDraft(api,"thread-a");
  assert.equal(files.length,1);assert.equal(files[0].uploadSessionId,"session-a");assert.equal(files[0].uploadState,"retryable");
  assert.equal(JSON.parse(saved).sessions[0].sessionId,"session-a");
  api.inboundAttachmentUploadSession=()=>of({session:{id:"session-a",state:"quarantined"}});
  const processing=await recoverInboundUploadDraft(api,"thread-a");
  assert.equal(processing[0].uploadState,"retryable","restored processing drafts expose the Retry action");
});
test("logout fences an in-flight draft recovery response",async()=>{
  const {api}=await fixture();let resolve;
  globalThis.sessionStorage={getItem:()=>JSON.stringify({version:1,sessions:[{id:"draft-a",sessionId:"session-a"}]}),setItem(){},removeItem(){}};
  api.inboundAttachmentUploadSession=()=>from(new Promise(done=>{resolve=done;}));
  const q=new DraftUploadQueue(api,()=>{});const recovery=q.restore("thread-a");
  await until(()=>resolve);q.dispose();resolve({session:{id:"session-a",state:"ready",attachment:{filename:"private.txt"}}});
  await recovery;assert.equal(q.files("thread-a").length,0);
});
test("remove while session creation is pending cancels its eventual session",async()=>{
  const {api,calls,store}=await fixture();let resolve;const original=api.createInboundAttachmentUploadSessions;
  api.createInboundAttachmentUploadSessions=(thread,files)=>from(new Promise(done=>{resolve=()=>original(thread,files).subscribe(done);}));
  const q=new DraftUploadQueue(api,()=>{});q.add("thread-a",[new File(["secret paste"],"note.txt")]);
  await until(()=>resolve);const id=q.files("thread-a")[0].id;q.remove("thread-a",id);resolve();
  await until(()=>calls.some(call=>call[0]==="cancel"));assert.equal(q.files("thread-a").length,0);assert.equal(store.get(id).state,"cancelled");
  assert.equal(calls.some(call=>call[0]==="ciphertext"),false);
});
test("encryption unavailability is visible and never sends plaintext",async()=>{
  const {api,calls}=await fixture();api.inboundAttachmentUploadStatus=()=>of({enabled:false,ready:false});
  const q=new DraftUploadQueue(api,()=>{});q.add("a",[new File(["secret paste"],"note.txt")]);
  await until(()=>q.files("a")[0].uploadState==="retryable");assert.equal(calls.length,0);
  assert.match(q.files("a")[0].uploadError,/Encrypted uploads/);
});

test("reload can process already-uploaded ciphertext without original File or duplicate upload",async()=>{
  const {api,calls,store}=await fixture();store.set("recovered-session",{id:"recovered-session",state:"quarantined"});
  const files=[{id:"saved-browser-id",uploadSessionId:"recovered-session",file:null,name:"attachment",size:0,type:"application/octet-stream",uploadState:"quarantined"}];
  const attachments=await uploadPendingFiles(api,"thread-a",files);
  assert.equal(attachments[0].uploadSessionId,"recovered-session");assert.equal(files[0].uploadState,"ready");
  assert.equal(calls.some(call=>["create","ciphertext"].includes(call[0])),false);
});
