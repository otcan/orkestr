import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasWhatsAppPartialDelivery, whatsappOutboxQuarantine } from "../packages/connectors/src/whatsapp-replay-safety.js";
import { __connectorOutboxTestInternals, ensureConnectorOutboxJob, markConnectorOutboxJob, claimConnectorOutboxJob, applyConnectorOutboxJobAction, releaseConnectorOutboxClaim, readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { retryRecoverableWhatsAppOutboxJobsForAccounts } from "../packages/connectors/src/whatsapp-outbox-recovery.js";

const wrapped = 'HTTP 409: {"ok":false,"error":"whatsapp_partial_delivery"}';
const base = {connector:"whatsapp",tenantId:"fixture-owner",ownerUserId:"fixture-owner",accountId:"fixture-account",chatId:"fixture-chat",threadId:"fixture-thread",sourceMessageId:"fixture-message",deliveryType:"final",payload:{text:"synthetic",attachments:[{filename:"fixture.txt",path:"/synthetic/never-read"}]}};
test("partial evidence recognizes legacy envelopes without inspecting outgoing content",()=>{
  for(const value of [wrapped, JSON.stringify(wrapped), Error(wrapped), {metadata:{lastError:wrapped}}, {brokerAck:{partialDelivery:{sent:[]}}}, {payload:{error:wrapped}}]) assert.equal(hasWhatsAppPartialDelivery(value),true);
  for(const value of ["not_whatsapp_partial_delivery", "whatsapp_partial_delivery_other", {payload:{text:wrapped,attachments:[{filename:wrapped}]}}, null])assert.equal(hasWhatsAppPartialDelivery(value),false);
  const cyclic={};cyclic.cause=cyclic;assert.equal(hasWhatsAppPartialDelivery(cyclic),false);
  assert.equal(whatsappOutboxQuarantine({...base,connector:"gmail",state:"claimed",claimExpiresAt:""}),null);
});

for(const backend of ["sqlite","json"]) {
  for(const state of ["claimed","sent_to_broker"])test(`${backend}: ${state} crash window is durable and cannot auto-replay`,async()=>{
    const home=await fs.mkdtemp(path.join(os.tmpdir(),"orkestr-replay-crash-"));
    const env={ORKESTR_HOME:home,ORKESTR_CONNECTOR_OUTBOX_STORE:backend};
    const {job}=await ensureConnectorOutboxJob(base,env);
    await markConnectorOutboxJob(job.id,{state,attemptCount:1,claimExpiresAt:"2020-01-01T00:00:00Z"},env);
    // Even a retry request before the recovery scanner runs needs an explicit override.
    await assert.rejects(applyConnectorOutboxJobAction(job.id,"retry",{},env),/uncertain_retry_requires_override/);
    const recovered=await claimConnectorOutboxJob(job.id,{claimant:"replacement"},env);
    assert.equal(recovered.acquired,false);assert.equal(recovered.job.state,"delivery_uncertain");
    assert.equal(recovered.job.attemptCount,1);assert.equal(recovered.job.metadata.recoveryReason,"expired_send_claim");
    __connectorOutboxTestInternals.clearCaches();
    assert.equal((await claimConnectorOutboxJob(job.id,{},env)).acquired,false);
    assert.equal((await releaseConnectorOutboxClaim(job.id,{},env)).state,"delivery_uncertain");
    for (const lateState of ["pending", "claimed", "sent_to_broker", "failed_retryable"]) {
      const late = await markConnectorOutboxJob(job.id,{state:lateState,error:"late_response",metadata:{}},env);
      assert.equal(late.state,"delivery_uncertain");
      assert.equal(late.metadata.recoveryReason,"expired_send_claim");
    }
    const recovery=await retryRecoverableWhatsAppOutboxJobsForAccounts({accountIds:[base.accountId]},env);
    assert.equal(recovery.retried.length,0);
    const duplicate=await ensureConnectorOutboxJob(base,env);
    assert.equal(duplicate.created,false);assert.equal(duplicate.job.state,"delivery_uncertain");
    await applyConnectorOutboxJobAction(job.id,"dead_letter",{reason:"synthetic review hold"},env);
    await assert.rejects(applyConnectorOutboxJobAction(job.id,"retry",{},env),/uncertain_retry_requires_override/);
    const approved = await applyConnectorOutboxJobAction(job.id,"retry",{
      allowDeliveryUncertainReplay:true,
      deliveryUncertainReplayConfirmation:"I_UNDERSTAND_THIS_MAY_DUPLICATE_A_MESSAGE",
      reason:"synthetic operator review",
    },env);
    assert.equal(approved.job.state,"pending");
    assert.equal(approved.job.metadata.deliveryUncertainOverride,true);
    const claim = await claimConnectorOutboxJob(job.id,{},env);
    assert.equal(claim.acquired,true);
  });
  test(`${backend}: late cleanup before recovery quarantines; a confirmed acknowledgment resolves it`,async()=>{
    const home=await fs.mkdtemp(path.join(os.tmpdir(),"orkestr-replay-cleanup-"));
    const env={ORKESTR_HOME:home,ORKESTR_CONNECTOR_OUTBOX_STORE:backend};
    const {job}=await ensureConnectorOutboxJob({...base,state:"sent_to_broker",claimExpiresAt:"2020-01-01T00:00:00Z"},env);
    assert.equal((await releaseConnectorOutboxClaim(job.id,{},env)).state,"delivery_uncertain");
    const delivered=await markConnectorOutboxJob(job.id,{state:"delivered",brokerAck:{messageId:"synthetic-ack"}},env);
    assert.equal(delivered.state,"delivered");
    assert.equal((await claimConnectorOutboxJob(job.id,{},env)).acquired,false);
  });
  test(`${backend}: legacy partial jobs block both operator and automatic replay`,async()=>{
    const home=await fs.mkdtemp(path.join(os.tmpdir(),"orkestr-replay-legacy-"));
    const env={ORKESTR_HOME:home,ORKESTR_CONNECTOR_OUTBOX_STORE:backend};
    for(const [index,state] of ["dead_letter","failed_retryable","pending"].entries()) {
      const {job}=await ensureConnectorOutboxJob({...base,sourceMessageId:`legacy-${index}`,state,error:wrapped,
        metadata:{lastError:"whatsapp_local_bridge_not_ready",retryRequestedBy:"whatsapp-auto-recovery",retryRequestedAt:new Date().toISOString()}},env);
      for(const action of ["retry","replay"])await assert.rejects(applyConnectorOutboxJobAction(job.id,action,{},env),/partial_delivery_retry_requires_new_send/);
    }
    assert.equal((await retryRecoverableWhatsAppOutboxJobsForAccounts({accountIds:[base.accountId]},env)).retried.length,0);
    for(const job of (await readConnectorOutbox(env)).jobs) {
      const result=await claimConnectorOutboxJob(job.id,{},env);
      assert.equal(result.acquired,false);assert.equal(result.job.state,"partial_delivery");
      assert.equal((await markConnectorOutboxJob(job.id,{state:"failed_retryable",error:"late",metadata:{}},env)).state,"partial_delivery");
    }
  });
}
test("pending work and live claims are not quarantined merely because time has passed",()=>{
  assert.equal(whatsappOutboxQuarantine({...base,state:"pending",createdAt:"2020-01-01"}),null);
  assert.equal(whatsappOutboxQuarantine({...base,state:"claimed",claimExpiresAt:new Date(Date.now()+60000).toISOString()}),null);
  assert.equal(whatsappOutboxQuarantine({...base,state:"delivered",error:wrapped}),null);
});
