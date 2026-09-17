import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import * as age from "age-encryption";
import { createThread, appendThreadMessage, listThreadMessages } from "../packages/core/src/threads.js";
import { dataPaths } from "../packages/storage/src/paths.js";
import { readJson, writeJson } from "../packages/storage/src/store.js";
import { createInboundAttachmentPayloadStream } from "../packages/core/src/browser-inbound-attachment-payload.js";
import { createInboundAttachmentUploadSessions, ingestInboundAttachmentCiphertext, processInboundAttachmentUpload,
  cancelInboundAttachmentUpload, inboundAttachmentUploadSession, sweepInboundAttachmentQuarantine } from "../packages/core/src/inbound-attachment-quarantine.js";
import { inboundAttachmentPreviewStream } from "../packages/core/src/inbound-attachment-preview.js";
import { registerAttachmentEncryptionRecipient, verifyAttachmentEncryptionRecipient } from "../packages/core/src/attachment-encryption-registry.js";
import { decodeOrkestrAttachmentPayload } from "../packages/core/src/browser-attachment-payload.js";
import { withDraftAttachmentClaims } from "../packages/core/src/draft-attachment-claims.js";
import { startServer } from "../apps/server/src/server.js";

const actor = {kind: "user", userId: "draft-owner", role: "user"};
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-draft-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: actor.userId, ORKESTR_INBOUND_UPLOAD_ENCRYPTION_REQUIRED: "1", ORKESTR_INBOUND_UPLOAD_PROCESSING_MODE: "transport" };
  const thread = await createThread({id:"draft-thread", name:"Draft test", ownerUserId:actor.userId}, env);
  return {env, thread};
}
async function upload(env, key = "draft-file-00001") {
  const text = "Synthetic private pasted content";
  const file = {name:"named-note.txt", type:"text/plain", size:Buffer.byteLength(text), stream:()=>new Blob([text]).stream()};
  const session = (await createInboundAttachmentUploadSessions({threadId:"draft-thread", files:[{idempotencyKey:key, plaintextSize:file.size}], principal:actor, env})).sessions[0];
  const encrypter = new age.Encrypter(); encrypter.addRecipient(session.recipient);
  const encrypted = await encrypter.encrypt(createInboundAttachmentPayloadStream(file, {descriptor:session.descriptor}));
  await ingestInboundAttachmentCiphertext({sessionId:session.id, principal:actor, input:Readable.fromWeb(encrypted), env});
  return processInboundAttachmentUpload({sessionId:session.id, principal:actor, env});
}
async function stored(env, change) {
  const file = dataPaths(env).inboundAttachmentUploads;
  const store = await readJson(file); await change(store); await writeJson(file, store);
}
const input = session => ({ role:"user", text:"", clientMessageId:"send-draft-0001", attachments:[{uploadSessionId:session.id}] });

test("eager upload is not a message; Send claims once and cleanup preserves message bytes", async () => {
  const {env} = await fixture(); const ready = await upload(env);
  assert.equal((await listThreadMessages("draft-thread", env)).length, 0);
  const message = await appendThreadMessage("draft-thread", input(ready), env);
  assert.equal(message.attachments.length, 1);
  assert.match(message.text, /Attached files/);
  const duplicate = await appendThreadMessage("draft-thread", input(ready), env);
  assert.equal(duplicate.id, message.id); assert.equal(duplicate.duplicate, true);
  assert.equal((await inboundAttachmentUploadSession({sessionId:ready.id, principal:actor, env})).state, "claimed");
  await stored(env, store => { store.sessions[0].release.expiresAt = "2000-01-01T00:00:00Z"; });
  await sweepInboundAttachmentQuarantine(env);
  await cancelInboundAttachmentUpload({sessionId:ready.id, principal:actor, env});
  assert.equal(await fs.readFile(ready.attachment.path, "utf8"), "Synthetic private pasted content");
  await assert.rejects(appendThreadMessage("draft-thread", {...input(ready), text:"changed"}, env), /idempotency_conflict/);
});
test("unready or foreign attachment prevents the whole message and all claims", async () => {
  const {env} = await fixture(); const ready = await upload(env);
  await assert.rejects(appendThreadMessage("draft-thread", {...input(ready), attachments:[{uploadSessionId:ready.id},{uploadSessionId:"inbound-does-not-exist"}]}, env), /unavailable/);
  assert.equal((await listThreadMessages("draft-thread", env)).length, 0);
  assert.equal((await inboundAttachmentUploadSession({sessionId:ready.id, principal:actor, env})).state, "ready");
  await createThread({id:"other-thread", name:"Other", ownerUserId:actor.userId}, env);
  await assert.rejects(appendThreadMessage("other-thread", input(ready), env), /unavailable/);
  await assert.rejects(inboundAttachmentUploadSession({sessionId:ready.id, principal:{...actor,userId:"other-owner"}, env}), /forbidden|not_found/);
});
test("remove ready draft deletes bytes and late Send cannot revive it", async () => {
  const {env} = await fixture(); const ready = await upload(env);
  const cancelled = await cancelInboundAttachmentUpload({sessionId:ready.id, principal:actor, env});
  assert.equal(cancelled.state, "cancelled");
  await assert.rejects(fs.stat(ready.attachment.path), /ENOENT/);
  await assert.rejects(appendThreadMessage("draft-thread", input(ready), env), /not_ready/);
});
test("remove versus Send has one winner, never a dangling accepted message", async () => {
  const {env} = await fixture(); const ready = await upload(env);
  const [send] = await Promise.allSettled([
    appendThreadMessage("draft-thread", input(ready), env),
    cancelInboundAttachmentUpload({sessionId:ready.id, principal:actor, env}),
  ]);
  const session = await inboundAttachmentUploadSession({sessionId:ready.id, principal:actor, env});
  if (send.status === "fulfilled") { assert.equal(session.state,"claimed"); await fs.stat(ready.attachment.path); }
  else { assert.equal(session.state,"cancelled"); assert.equal((await listThreadMessages("draft-thread",env)).length,0); }
});
test("claim journal reconciles crashes before and after message persistence", async () => {
  const {env, thread} = await fixture(); const ready = await upload(env);
  await assert.rejects(withDraftAttachmentClaims({thread, input:input(ready), messageId:"not-written", env}, async()=>{throw Error("disk full");}), /disk full/);
  assert.equal((await inboundAttachmentUploadSession({sessionId:ready.id, principal:actor, env})).state,"ready");
  const message = await appendThreadMessage("draft-thread", input(ready),env);
  await stored(env, store => {store.sessions[0].state="claiming";store.sessions[0].claim={messageId:message.id};});
  await sweepInboundAttachmentQuarantine(env);
  assert.equal((await inboundAttachmentUploadSession({sessionId:ready.id, principal:actor, env})).state,"claimed");
  await fs.stat(ready.attachment.path);
});
test("unclaimed expiry is reclaimed but never accepted by Send", async()=>{
  const {env}=await fixture(); const ready=await upload(env);
  await stored(env,store=>{store.sessions[0].release.expiresAt="2000-01-01T00:00:00Z";});
  await assert.rejects(appendThreadMessage("draft-thread",input(ready),env),/not_ready/);
  await sweepInboundAttachmentQuarantine(env);
  await assert.rejects(fs.stat(ready.attachment.path),/ENOENT/);
});

test("preview is encrypted for a verified browser and refuses other owners",async()=>{
  const {env}=await fixture();const ready=await upload(env);
  await assert.rejects(inboundAttachmentPreviewStream({sessionId:ready.id,principal:actor,env}),/browser_key_required/);
  const identity=await age.generateIdentity();const recipient=await age.identityToRecipient(identity);
  const registered=await registerAttachmentEncryptionRecipient({recipient,label:"Preview browser"},actor,env);
  const decrypter=new age.Decrypter();decrypter.addIdentity(identity);
  const proof=await decrypter.decrypt(Buffer.from(registered.key.challenge.ciphertext,"base64"),"text");
  await verifyAttachmentEncryptionRecipient(registered.key.id,proof,actor,env);
  const stream=await inboundAttachmentPreviewStream({sessionId:ready.id,principal:actor,env});const chunks=[];
  for await(const chunk of stream)chunks.push(chunk);
  const cipher=Buffer.concat(chunks);assert.equal(cipher.includes(Buffer.from("Synthetic private")),false);
  const payload=await decodeOrkestrAttachmentPayload(await decrypter.decrypt(cipher));
  assert.equal(payload.filename,"named-note.txt");assert.equal(Buffer.from(payload.bytes).toString(),"Synthetic private pasted content");
  await assert.rejects(inboundAttachmentPreviewStream({sessionId:ready.id,principal:{...actor,userId:"other-owner"},env}),/forbidden|not_found/);
  await cancelInboundAttachmentUpload({sessionId:ready.id,principal:actor,env});
  await assert.rejects(inboundAttachmentPreviewStream({sessionId:ready.id,principal:actor,env}),/not_ready/);
});

test("HTTP draft preview and attachment-only Send preserve encrypted transport and idempotency",async()=>{
  const {env}=await fixture(); const ready=await upload(env);
  const identity=await age.generateIdentity();const recipient=await age.identityToRecipient(identity);
  const registered=await registerAttachmentEncryptionRecipient({recipient,label:"HTTP browser"},actor,env);
  const decrypt=new age.Decrypter();decrypt.addIdentity(identity);
  await verifyAttachmentEncryptionRecipient(registered.key.id,await decrypt.decrypt(Buffer.from(registered.key.challenge.ciphertext,"base64"),"text"),actor,env);
  const overrides={...env,ORKESTR_HOST_BOUNDARIES:"0",ORKESTR_RECOVER_RUNNING_ON_START:"0",ORKESTR_WHATSAPP_AUTOSTART:"0",WHATSAPP_LOCAL_AUTOSTART:"0"};
  const prior=Object.fromEntries(Object.keys(overrides).map(key=>[key,process.env[key]]));Object.assign(process.env,overrides);
  const server=await startServer({port:0,host:"127.0.0.1"});const base=`http://127.0.0.1:${server.address().port}/api`;
  try {
    const features=await fetch(base+"/attachment-encryption/features");assert.equal(features.status,200);assert.equal((await features.json()).eagerUploads,true);
    const preview=await fetch(base+`/attachment-encryption/inbound/sessions/${ready.id}/preview`);
    assert.equal(preview.status,200);assert.equal(preview.headers.get("content-type"),"application/age");assert.equal(preview.headers.get("cache-control"),"no-store");
    const wire=new Uint8Array(await preview.arrayBuffer());const payload=await decodeOrkestrAttachmentPayload(await decrypt.decrypt(wire));assert.equal(payload.filename,"named-note.txt");
    const send=()=>fetch(base+"/threads/draft-thread/input",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...input(ready),autoRun:false})});
    const first=await send();assert.equal(first.status,202);const message=(await first.json()).message;
    const retry=await send();assert.equal(retry.status,202);assert.equal((await retry.json()).message.id,message.id);
    const sentPreview=await fetch(base+`/threads/draft-thread/attachments/${message.attachments[0].id}/preview`);
    assert.equal(sentPreview.status,200);assert.equal(sentPreview.headers.get("content-type"),"application/age");await sentPreview.arrayBuffer();
  } finally {
    await new Promise(resolve=>server.close(resolve));
    for(const [key,value] of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});
