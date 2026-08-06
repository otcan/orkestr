import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { assertOwnerAccess, canAccessOwner, isAdminPrincipal, policyError } from "./policy.js";
import { resolveTenantVmTarget, targetResolutionMetadata } from "./target-resolver.js";
import {
  acceptingMailboxStatuses,
  cleanLower,
  extractAddress,
  extractForwardingVerificationCandidates,
  mailboxError,
  mailboxMessageIdempotencyKey,
  mailboxStatuses,
  normalizeInboundMailboxMessage,
  normalizeMailbox,
  normalizeMailboxTarget,
  normalizeRecipientList,
  positiveInteger,
  publicMailbox,
  safeSegment,
  nowIso,
} from "./mailbox-normalization.js";

export {
  extractForwardingVerificationCandidates,
  mailboxMessageIdempotencyKey,
  normalizeInboundMailboxMessage,
  normalizeMailbox,
  publicMailbox,
};

const closedStatuses = new Set(["deleting", "deleted", "rotated"]);
const vmMailboxCapabilities = new Set(["mailbox", "mailboxes"]);

function validateMailbox(mailbox = {}) {
  if (!mailbox.id) throw mailboxError("mailbox_id_required");
  if (!mailbox.localPart || mailbox.localPart.length > 64) throw mailboxError("mailbox_local_part_invalid");
  if (!mailbox.domain || mailbox.domain.length > 190) throw mailboxError("mailbox_domain_invalid");
  if (mailbox.address !== `${mailbox.localPart}@${mailbox.domain}`) throw mailboxError("mailbox_address_invalid");
  if (!mailboxStatuses.has(mailbox.status)) throw mailboxError("mailbox_status_invalid");
  if (mailbox.target.type === "vm" && !mailbox.target.tenantVmId) throw mailboxError("mailbox_vm_target_required");
  if (!["main", "vm"].includes(mailbox.target.type)) throw mailboxError("mailbox_target_invalid");
  return true;
}

function mailboxStorePath(env = process.env) {
  return dataPaths(env).mailboxes;
}

async function readMailboxStore(env = process.env) {
  const payload = await readJson(mailboxStorePath(env), { schemaVersion: 1, mailboxes: [], relayAudits: [], deadLetters: [] });
  return {
    schemaVersion: 1,
    mailboxes: Array.isArray(payload?.mailboxes) ? payload.mailboxes : Array.isArray(payload) ? payload : [],
    relayAudits: Array.isArray(payload?.relayAudits) ? payload.relayAudits : [],
    deadLetters: Array.isArray(payload?.deadLetters) ? payload.deadLetters : [],
  };
}

async function writeMailboxStore(store = {}, env = process.env) {
  await writeJson(mailboxStorePath(env), {
    schemaVersion: 1,
    mailboxes: Array.isArray(store.mailboxes) ? store.mailboxes : [],
    relayAudits: Array.isArray(store.relayAudits) ? store.relayAudits : [],
    deadLetters: Array.isArray(store.deadLetters) ? store.deadLetters : [],
    updatedAt: nowIso(),
  });
}

export async function listMailboxes(env = process.env) {
  const store = await readMailboxStore(env);
  return store.mailboxes.map((item) => normalizeMailbox(item, env));
}

export async function listMailboxesForPrincipal(principal = {}, env = process.env) {
  const mailboxes = await listMailboxes(env);
  if (isAdminPrincipal(principal)) return mailboxes;
  return mailboxes.filter((mailbox) => canAccessOwner(principal, mailbox.ownerUserId, env));
}

export async function getMailbox(mailboxId, env = process.env) {
  const id = safeSegment(mailboxId, "", 96);
  if (!id) return null;
  return (await listMailboxes(env)).find((mailbox) => mailbox.id === id) || null;
}

export async function getMailboxByAddress(address, env = process.env) {
  const wanted = extractAddress(address);
  if (!wanted) return null;
  return (await listMailboxes(env)).find((mailbox) => mailbox.address === wanted) || null;
}

export async function createMailbox(input = {}, env = process.env) {
  const mailbox = normalizeMailbox(input, env);
  validateMailbox(mailbox);
  const store = await readMailboxStore(env);
  const existing = store.mailboxes.map((item) => normalizeMailbox(item, env));
  if (existing.some((item) => item.id === mailbox.id)) throw mailboxError("mailbox_already_exists", 409);
  if (existing.some((item) => item.address === mailbox.address && !closedStatuses.has(item.status))) {
    throw mailboxError("mailbox_address_already_exists", 409);
  }
  store.mailboxes.push(mailbox);
  await writeMailboxStore(store, env);
  await appendEvent({
    type: "mailbox_created",
    mailboxId: mailbox.id,
    ownerUserId: mailbox.ownerUserId,
    address: mailbox.address,
    targetType: mailbox.target.type,
    tenantVmId: mailbox.target.tenantVmId || "",
  }, env).catch(() => {});
  return mailbox;
}

function vmMailboxQuota(env = process.env) {
  return positiveInteger(env.ORKESTR_VM_MAILBOX_QUOTA, 5, { min: 0, max: 1000 });
}

function assertVmSelfServiceAllowed(vm = {}) {
  if (!vm || vm.status === "deleted" || vm.deletedAt) throw mailboxError("mailbox_vm_not_found", 404);
  if (vm.status !== "running") throw policyError("mailbox_vm_running_required", 403);
  if (!vm.capabilities?.some((capability) => vmMailboxCapabilities.has(cleanLower(capability)))) {
    throw policyError("mailbox_vm_self_service_capability_required", 403);
  }
  return true;
}

async function assertVmMailboxQuota(tenantVmId, env = process.env) {
  const quota = vmMailboxQuota(env);
  const used = (await listMailboxes(env)).filter((mailbox) =>
    mailbox.target.type === "vm" &&
    mailbox.target.tenantVmId === tenantVmId &&
    !closedStatuses.has(mailbox.status)
  ).length;
  if (used >= quota) throw policyError("mailbox_vm_quota_reached", 403);
}

export async function createMailboxForPrincipal(input = {}, principal = {}, env = process.env) {
  const target = normalizeMailboxTarget(input, env);
  if (target.type !== "vm") {
    if (!isAdminPrincipal(principal)) throw policyError("mailbox_main_create_admin_required", 403);
    return createMailbox(input, env);
  }

  const ownerHint = target.tenantVmId
    ? input.ownerUserId || input.userId || ""
    : input.ownerUserId || input.userId || (!isAdminPrincipal(principal) ? principal.userId : "");
  const resolution = await resolveTenantVmTarget({
    tenantVmId: target.tenantVmId,
    ownerUserId: ownerHint,
    principal,
    action: "mailbox.vm.create",
    allowSingleInference: true,
    selectionSource: target.tenantVmId ? "explicit_request" : "single_authorized_target",
    adminOverride: isAdminPrincipal(principal) && target.tenantVmId && cleanLower(input.selectionSource) === "admin_override",
    overrideReason: input.overrideReason,
  }, env);
  const vm = resolution.selectedTarget.resource;
  assertOwnerAccess(principal, vm.ownerUserId, "mailbox_vm_create", env);
  await assertVmMailboxQuota(vm.id, env);
  const base = {
    ...input,
    id: input.id || input.mailboxId || "",
    address: isAdminPrincipal(principal) ? input.address : "",
    localPart: isAdminPrincipal(principal) ? input.localPart : "",
    ownerUserId: vm.ownerUserId,
    targetType: "vm",
    tenantVmId: vm.id,
    target: { type: "vm", tenantVmId: vm.id, ownerUserId: vm.ownerUserId },
    targetSelection: targetResolutionMetadata(resolution),
    source: isAdminPrincipal(principal) ? "admin" : "vm-self-service",
  };
  if (!isAdminPrincipal(principal)) assertVmSelfServiceAllowed(vm);
  return createMailbox(base, env);
}

async function resolveMailboxForInbound(input = {}, env = process.env) {
  const byId = await getMailbox(input.mailboxId || input.id, env);
  const recipients = normalizeRecipientList(input);
  if (byId) {
    if (recipients.length && !recipients.includes(byId.address)) throw mailboxError("mailbox_recipient_mismatch", 400);
    return byId;
  }
  for (const recipient of recipients) {
    const mailbox = await getMailboxByAddress(recipient, env);
    if (mailbox) return mailbox;
  }
  throw mailboxError("mailbox_recipient_rejected", 404);
}

async function queueVmRelay(mailbox, message, idempotencyKey, env = process.env) {
  let resolution = null;
  try {
    resolution = await resolveTenantVmTarget({
      tenantVmId: mailbox.target.tenantVmId,
      ownerUserId: mailbox.ownerUserId,
      principal: { kind: "system", role: "admin", userId: "system" },
      action: "mailbox.vm.relay",
      allowSingleInference: false,
      selectionSource: "mailbox_record",
      idempotencyKey,
      requireRunning: true,
    }, env);
  } catch (error) {
    await recordMailboxDeadLetter({
      mailbox,
      message,
      idempotencyKey,
      reason: error?.message || "target_stale",
      resolution: error?.resolution || null,
    }, env);
    throw error;
  }
  const store = await readMailboxStore(env);
  const existing = store.relayAudits.find((audit) => audit.id === idempotencyKey);
  if (existing) return { created: false, audit: existing };
  const now = nowIso();
  const audit = {
    id: idempotencyKey,
    mailboxId: mailbox.id,
    ownerUserId: mailbox.ownerUserId,
    targetType: "vm",
    tenantVmId: mailbox.target.tenantVmId,
    state: "queued",
    attemptCount: 0,
    messageId: message.headers.messageId,
    bodyHash: message.bodyHash,
    sizeBytes: message.sizeBytes,
    attachmentCount: message.attachments.length,
    provenance: message.provenance,
    targetSelection: targetResolutionMetadata(resolution),
    createdAt: now,
    updatedAt: now,
  };
  store.relayAudits.push(audit);
  await writeMailboxStore(store, env);
  return { created: true, audit };
}

async function recordMailboxDeadLetter({ mailbox, message, idempotencyKey, reason = "", resolution = null } = {}, env = process.env) {
  const store = await readMailboxStore(env);
  const deadLetterId = `${idempotencyKey || "mailbox"}:${cleanLower(reason || "failed")}`;
  const existing = store.deadLetters.find((entry) => entry.id === deadLetterId);
  if (existing) return { created: false, deadLetter: existing };
  const now = nowIso();
  const deadLetter = {
    id: deadLetterId,
    mailboxId: mailbox?.id || "",
    ownerUserId: mailbox?.ownerUserId || "",
    targetType: mailbox?.target?.type || "",
    tenantVmId: mailbox?.target?.tenantVmId || "",
    reason: cleanLower(reason || "mailbox_route_failed"),
    messageId: message?.headers?.messageId || "",
    bodyHash: message?.bodyHash || "",
    sizeBytes: message?.sizeBytes || 0,
    targetSelection: resolution ? targetResolutionMetadata(resolution) : (mailbox?.targetSelection || {}),
    state: "dead-lettered",
    createdAt: now,
    updatedAt: now,
  };
  store.deadLetters.push(deadLetter);
  await writeMailboxStore(store, env);
  await appendEvent({
    type: "mailbox_dead_lettered",
    mailboxId: deadLetter.mailboxId,
    ownerUserId: deadLetter.ownerUserId,
    tenantVmId: deadLetter.tenantVmId,
    reason: deadLetter.reason,
  }, env).catch(() => {});
  return { created: true, deadLetter };
}

export async function listMailboxRelayAudits({ mailboxId = "", tenantVmId = "", states = [], limit = 100 } = {}, env = process.env) {
  const store = await readMailboxStore(env);
  const wantedStates = (Array.isArray(states) ? states : [states]).map(cleanLower).filter(Boolean);
  const capped = Math.max(1, Math.min(1000, Number(limit || 100) || 100));
  return store.relayAudits
    .filter((audit) => !mailboxId || audit.mailboxId === mailboxId)
    .filter((audit) => !tenantVmId || audit.tenantVmId === tenantVmId)
    .filter((audit) => !wantedStates.length || wantedStates.includes(cleanLower(audit.state)))
    .slice(-capped);
}

export async function listMailboxDeadLetters({ mailboxId = "", tenantVmId = "", states = [], limit = 100 } = {}, env = process.env) {
  const store = await readMailboxStore(env);
  const wantedStates = (Array.isArray(states) ? states : [states]).map(cleanLower).filter(Boolean);
  const capped = Math.max(1, Math.min(1000, Number(limit || 100) || 100));
  return store.deadLetters
    .filter((entry) => !mailboxId || entry.mailboxId === mailboxId)
    .filter((entry) => !tenantVmId || entry.tenantVmId === tenantVmId)
    .filter((entry) => !wantedStates.length || wantedStates.includes(cleanLower(entry.state)))
    .slice(-capped);
}

export async function routeMailboxMessage(input = {}, env = process.env) {
  const mailbox = await resolveMailboxForInbound(input, env);
  if (!acceptingMailboxStatuses.has(mailbox.status)) throw mailboxError("mailbox_not_accepting", 409);
  const message = normalizeInboundMailboxMessage(input, mailbox);
  const idempotencyKey = mailboxMessageIdempotencyKey(input, mailbox);

  if (mailbox.target.type === "vm") {
    const relay = await queueVmRelay(mailbox, message, idempotencyKey, env);
    await appendEvent({
      type: "mailbox_vm_relay_queued",
      mailboxId: mailbox.id,
      ownerUserId: mailbox.ownerUserId,
      tenantVmId: mailbox.target.tenantVmId,
      relayAuditId: relay.audit.id,
      deduped: !relay.created,
    }, env).catch(() => {});
    return {
      ok: true,
      action: relay.created ? "vm_relay_queued" : "deduped",
      created: relay.created,
      mailbox: publicMailbox(mailbox, env),
      relayAudit: relay.audit,
      idempotencyKey,
    };
  }

  return {
    ok: true,
    action: "connector_inbox_required",
    created: null,
    mailbox: publicMailbox(mailbox, env),
    connectorInboxInput: {
      id: idempotencyKey,
      connector: "mailbox",
      accountId: mailbox.id,
      conversationId: mailbox.id,
      payload: message,
    },
    idempotencyKey,
  };
}
