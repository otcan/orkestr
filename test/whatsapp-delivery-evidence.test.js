import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publicWhatsAppPartialDelivery, whatsappFailureEvidence, whatsappOperatorFailureDiagnostic, reportWhatsAppAttachmentRecovery } from "../packages/connectors/src/whatsapp-delivery-evidence.js";
import { setLocalWhatsAppRuntimeForTest, resetLocalWhatsAppBridgeForTest, sendLocalWhatsAppMessage } from "../packages/connectors/src/whatsapp-local-bridge.js";

test("operator media diagnostic is bounded, redacted and excluded from public evidence", () => {
  const error = Error("ProviderFault media pipeline: Bearer secret-token /private/fixture.txt https://provider.invalid/private?token=hidden 120363424540095970@g.us sensitive-cover filename.txt " + "x".repeat(600));
  const diagnostic = whatsappOperatorFailureDiagnostic(error, "send_media", ["sensitive-cover", "filename.txt"]);
  assert.equal(diagnostic.failureFingerprint, whatsappFailureEvidence(error, "send_media").failureFingerprint);
  assert.match(diagnostic.diagnostic, /ProviderFault media pipeline/);
  for (const value of ["secret-token", "/private", "provider.invalid", "hidden", "120363424540095970", "sensitive-cover", "filename.txt", "x".repeat(32)]) assert.equal(diagnostic.diagnostic.includes(value), false);
  assert.ok(diagnostic.diagnostic.length <= 512);
  assert.equal(publicWhatsAppPartialDelivery(diagnostic).diagnostic, undefined);
});

test("partial-delivery evidence is allowlisted, bounded and idempotently sanitized", () => {
  const secret = "Evaluation failed: /private/fixture token=do-not-export https://example.invalid/?secret=x";
  const result = publicWhatsAppPartialDelivery({ ...whatsappFailureEvidence(Error(secret), "send_media"),
    sent:[{id:"ack-1",kind:"text",path:secret,filename:secret}], accountId:secret, chatId:secret,
    attachments:[{index:0,outcome:"uncertain",path:secret},{index:1,outcome:"not_attempted"}], cause:secret });
  assert.equal(result.failureCode,"provider_evaluation_failed"); assert.equal(result.stage,"send_media");
  assert.equal(result.retrySuppressed,true); assert.equal(JSON.stringify(result).includes("secret"),false);
  assert.deepEqual(publicWhatsAppPartialDelivery(result),result);
  assert.equal(publicWhatsAppPartialDelivery(null),null);
});

async function fixture(run, { failAt = -1, missingAck = false } = {}) {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"orkestr-media-evidence-"));
  const env={ORKESTR_HOME:home,ORKESTR_WHATSAPP_ACCOUNT_IDS:"personal",ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED:"0"};
  const calls=[];
  function Media(mimetype,data) { Object.assign(this,{mimetype,data}); }
  Media.fromFilePath=filePath=>({mimetype:filePath.endsWith("png")?"image/png":"application/pdf",data:"fixture"});
  const attachments=[];
  for (const [index,name] of ["a.pdf","b.png","c.csv"].entries()) {
    const filePath=path.join(home,name); await fs.writeFile(filePath,"fixture"); attachments.push({path:filePath,filename:name,index});
  }
  setLocalWhatsAppRuntimeForTest("personal",{MessageMedia:Media,client:{async sendMessage(to,body){
    calls.push({to,kind:typeof body==="string"?"text":"attachment"});
    if (calls.length===failAt) throw Error("Evaluation failed: fake private provider detail");
    if (missingAck && typeof body!=="string") return {};
    return {id:{_serialized:`ack-${calls.length}`}};
  }}},{},env);
  const send=(extra={})=>sendLocalWhatsAppMessage({accountId:"personal",chatId:"fixture@c.us",text:"cover",attachments,env,...extra});
  try { await run({send,calls,attachments,env}); } finally { await resetLocalWhatsAppBridgeForTest(env); }
}
test("preflight prevents text delivery for missing, directory and oversized files", async () => {
  await fixture(async ({send,calls,attachments,env})=>{
    await fs.unlink(attachments[1].path);
    await assert.rejects(send(), /attachment_missing/); assert.equal(calls.length,0);
    await assert.rejects(send({attachments:[{path:env.ORKESTR_HOME}]}), /attachment_invalid/); assert.equal(calls.length,0);
    await assert.rejects(send({attachments:[attachments[0]],env:{...env,ORKESTR_WHATSAPP_LOCAL_BRIDGE_ATTACHMENT_MAX_BYTES:"1"}}),/attachment_too_large/);
    assert.equal(calls.length,0);
  });
});
for (const failAt of [2,3]) test(`media failure at send ${failAt} preserves per-file obligations`, async()=>{
  await fixture(async({send,calls})=>{
    await assert.rejects(send(),error=>{
      assert.equal(error.message,"whatsapp_partial_delivery"); assert.equal(error.retryable,false);
      assert.deepEqual(error.partialDelivery.attachments.map(x=>x.outcome),failAt===2?["uncertain","not_attempted","not_attempted"]:["sent","uncertain","not_attempted"]);
      assert.equal(error.partialDelivery.sent.length,failAt-1); assert.equal(error.partialDelivery.failureCode,"provider_evaluation_failed");
      assert.equal(JSON.stringify(error.partialDelivery).includes("private"),false); return true;
    }); assert.equal(calls.length,failAt);
  },{failAt});
});
test("media without an acknowledgment is never reported delivered",async()=>{
  await fixture(async({send})=>{
    await assert.rejects(send({text:""}),error=>error.partialDelivery.failureCode==="media_ack_missing" && error.partialDelivery.attachments[0].outcome==="uncertain");
  },{missingAck:true});
});
test("PDF image and CSV successful batch reports all three acknowledgments",async()=>{
  await fixture(async({send})=>{ const result=await send(); assert.equal(result.sent.length,4); assert.deepEqual(result.sent.filter(x=>x.kind==="attachment").map(x=>x.index),[0,1,2]); });
});
test("report-only recovery requires exact scope, incident window and never permits replay",()=>{
  const job={id:"job-1",connector:"whatsapp",state:"dead_letter",ownerUserId:"owner-a",threadId:"thread-a",accountId:"account-a",createdAt:"2026-01-02T00:00:00Z"};
  const scope={ownerUserId:"owner-a",threadId:"thread-a",accountId:"account-a",since:"2026-01-01",until:"2026-01-03"};
  const jobs=[job,{...job,ownerUserId:"other"},{...job,threadId:"other"},{...job,accountId:"other"},{...job,createdAt:"2025-01-01"}];
  const before=JSON.stringify(jobs),report=reportWhatsAppAttachmentRecovery(jobs,scope);
  assert.equal(report.length,1); assert.equal(report[0].automaticReplay,false); assert.equal(report[0].reason,"missing_evidence_do_not_replay");
  assert.equal(JSON.stringify(jobs),before); assert.throws(()=>reportWhatsAppAttachmentRecovery(jobs,{...scope,ownerUserId:""}),/scope_required/);
});
