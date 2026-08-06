import { appendEvent } from "../../storage/src/store.js";
import { cleanLower, mailboxError, nowIso, safeSegment } from "./mailbox-normalization.js";
import {
  getMailbox,
  idempotencyKey,
  operationResult,
  publicRelayAudit,
  readMailboxStore,
  recordMailboxDeadLetter,
  recordOperation,
  writeMailboxStore,
} from "./mailboxes.js";
import { isAdminPrincipal, policyError } from "./policy.js";
import { resolveTenantVmTarget, targetResolutionMetadata } from "./target-resolver.js";

export async function retryMailboxRelayForPrincipal(relayAuditId, input = {}, principal = {}, env = process.env) {
  if (!isAdminPrincipal(principal)) throw policyError("mailbox_relay_retry_admin_required", 403);
  const id = String(relayAuditId || "").trim();
  const key = idempotencyKey(input);
  const store = await readMailboxStore(env);
  const prior = operationResult(store, "mailbox.relay.retry", key);
  if (prior?.relayAuditId) {
    return publicRelayAudit(store.relayAudits.find((audit) => audit.id === prior.relayAuditId) || {});
  }

  const audit = store.relayAudits.find((item) => item.id === id);
  if (!audit) throw mailboxError("mailbox_relay_audit_not_found", 404);
  const mailbox = await getMailbox(audit.mailboxId, env);
  if (!mailbox || mailbox.target.type !== "vm" || mailbox.target.tenantVmId !== audit.tenantVmId) {
    throw mailboxError("mailbox_relay_original_target_missing", 409);
  }

  let resolution = null;
  try {
    resolution = await resolveTenantVmTarget({
      tenantVmId: audit.tenantVmId,
      ownerUserId: audit.ownerUserId,
      principal,
      action: "mailbox.vm.relay.retry",
      allowSingleInference: false,
      selectionSource: "relay_audit",
      idempotencyKey: key || audit.id,
      requireRunning: true,
    }, env);
  } catch (error) {
    const updated = {
      ...audit,
      state: "dead-lettered",
      lastError: cleanLower(error?.message || "target_stale"),
      updatedAt: nowIso(),
      targetSelection: error?.resolution ? targetResolutionMetadata(error.resolution) : audit.targetSelection,
    };
    await writeMailboxStore({
      ...store,
      relayAudits: store.relayAudits.map((item) => item.id === id ? updated : item),
    }, env);
    await recordMailboxDeadLetter({
      mailbox,
      message: {
        headers: { messageId: audit.messageId },
        bodyHash: audit.bodyHash,
        sizeBytes: audit.sizeBytes,
      },
      idempotencyKey: audit.id,
      reason: updated.lastError,
      resolution: error?.resolution || null,
      relayAuditId: audit.id,
    }, env);
    throw error;
  }

  const now = nowIso();
  const updated = {
    ...audit,
    state: "queued",
    attemptCount: Number(audit.attemptCount || 0) + 1,
    lastAttemptAt: now,
    nextAttemptAt: now,
    lastError: "",
    targetSelection: targetResolutionMetadata(resolution),
    updatedAt: now,
  };
  await writeMailboxStore(recordOperation({
    ...store,
    relayAudits: store.relayAudits.map((item) => item.id === id ? updated : item),
  }, "mailbox.relay.retry", key, { relayAuditId: updated.id }), env);
  await appendEvent({
    type: "mailbox_vm_relay_retry_queued",
    relayAuditId: updated.id,
    mailboxId: updated.mailboxId,
    tenantVmId: updated.tenantVmId,
    attemptCount: updated.attemptCount,
  }, env).catch(() => {});
  return publicRelayAudit(updated);
}

export async function replayMailboxDeadLetterForPrincipal(deadLetterId, input = {}, principal = {}, env = process.env) {
  if (!isAdminPrincipal(principal)) throw policyError("mailbox_dead_letter_replay_admin_required", 403);
  if (input.confirm !== true && input.confirm !== "true") {
    throw mailboxError("mailbox_dead_letter_replay_confirmation_required", 400);
  }

  const id = String(deadLetterId || "").trim();
  const key = idempotencyKey(input);
  const store = await readMailboxStore(env);
  const prior = operationResult(store, "mailbox.dead_letter.replay", key);
  if (prior?.relayAuditId) {
    return publicRelayAudit(store.relayAudits.find((audit) => audit.id === prior.relayAuditId) || {});
  }

  const deadLetter = store.deadLetters.find((entry) => entry.id === id);
  if (!deadLetter) throw mailboxError("mailbox_dead_letter_not_found", 404);
  const mailbox = await getMailbox(deadLetter.mailboxId, env);
  if (!mailbox || mailbox.target.type !== "vm" || mailbox.target.tenantVmId !== deadLetter.tenantVmId) {
    throw mailboxError("mailbox_dead_letter_original_target_missing", 409);
  }

  const resolution = await resolveTenantVmTarget({
    tenantVmId: deadLetter.tenantVmId,
    ownerUserId: deadLetter.ownerUserId,
    principal,
    action: "mailbox.vm.dead_letter.replay",
    allowSingleInference: false,
    selectionSource: "dead_letter",
    idempotencyKey: key || deadLetter.id,
    requireRunning: true,
  }, env);
  const now = nowIso();
  const audit = {
    id: `${deadLetter.id}:replay:${safeSegment(key || now, "retry", 40)}`,
    mailboxId: deadLetter.mailboxId,
    ownerUserId: deadLetter.ownerUserId,
    targetType: "vm",
    tenantVmId: deadLetter.tenantVmId,
    state: "queued",
    attemptCount: 1,
    messageId: deadLetter.messageId,
    bodyHash: deadLetter.bodyHash,
    sizeBytes: deadLetter.sizeBytes,
    attachmentCount: 0,
    provenance: {},
    targetSelection: targetResolutionMetadata(resolution),
    replayOfDeadLetterId: deadLetter.id,
    createdAt: now,
    updatedAt: now,
  };
  await writeMailboxStore(recordOperation({
    ...store,
    relayAudits: [...store.relayAudits, audit],
  }, "mailbox.dead_letter.replay", key, { relayAuditId: audit.id, deadLetterId: deadLetter.id }), env);
  await appendEvent({
    type: "mailbox_dead_letter_replay_queued",
    deadLetterId: deadLetter.id,
    relayAuditId: audit.id,
    mailboxId: audit.mailboxId,
    tenantVmId: audit.tenantVmId,
  }, env).catch(() => {});
  return publicRelayAudit(audit);
}
