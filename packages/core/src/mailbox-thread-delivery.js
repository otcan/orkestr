import { createHash, randomUUID } from "node:crypto";
import { appendEvent } from "../../storage/src/store.js";
import { policyError } from "./policy.js";
import { appendThreadMessage } from "./threads.js";
import { evaluateMailboxThreadDeliveryShadow } from "./mailbox-thread-delivery-shadow.js";
import { enqueueMailboxRouteSource } from "./mailbox-routes.js";
import {
  mailboxPumpRunKey,
  mailboxThreadDeliveryPumpLeaseMs,
  mailboxThreadDeliveryPumpLimit,
  mailboxThreadDeliveryPumpIntervalMs,
} from "./mailbox-thread-delivery-pump-config.js";
import { recordMailboxThreadDeliveryMetrics, recordThreadResourceInvalidationMetric } from "./observability.js";
import {
  assertThreadResourceAccess,
  authorizeThreadResourceAccess,
  fenceThreadResourcePolicyDelivery,
  mutateThreadResourcePolicy,
  readThreadResourcePolicy,
  threadResourceAccessMode,
  threadResourceId,
} from "./thread-resource-grants.js";

const clean = (value = "") => String(value || "").trim();
const lower = (value = "") => clean(value).toLowerCase();
const nowIso = () => new Date().toISOString();
const hash = (value = "") => createHash("sha256").update(String(value || "")).digest("hex");
const activeDeliveryStates = new Set(["pending", "claimed"]);
const listenerFilterKeys = new Set(["fromIncludes", "subjectIncludes", "hasAttachments", "verificationOnly"]);
const localPumpRuns = new Map();
const mailboxPumpLeaseName = "mailbox-thread-delivery";

export { mailboxThreadDeliveryPumpIntervalMs, mailboxThreadDeliveryPumpLimit };
export { mailboxThreadDeliveryStatus } from "./mailbox-thread-delivery-status.js";

function mailboxResourceId(mailbox = {}, env = process.env) {
  return threadResourceId("mailbox", mailbox.id, mailbox.ownerUserId, env);
}

function publicListener(listener = {}) {
  return {
    id: listener.id,
    mailboxResourceId: listener.resourceId,
    threadId: listener.threadId,
    filter: { ...(listener.filter || {}) },
    generation: listener.generation,
    status: listener.status,
    grantRevision: listener.grantRevision,
    policyRevision: listener.policyRevision,
    resourceGeneration: listener.resourceGeneration,
    createdAt: listener.createdAt,
    updatedAt: listener.updatedAt,
    revokedAt: listener.revokedAt || null,
    reason: listener.reason || null,
  };
}

function normalizedFilter(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (Object.keys(source).some((key) => !listenerFilterKeys.has(key))) throw policyError("mailbox_listener_filter_invalid", 400);
  const filter = {};
  for (const key of ["fromIncludes", "subjectIncludes"]) {
    if (source[key] === undefined || source[key] === null || source[key] === "") continue;
    const value = lower(source[key]).slice(0, 200);
    if (!value) throw policyError("mailbox_listener_filter_invalid", 400);
    filter[key] = value;
  }
  for (const key of ["hasAttachments", "verificationOnly"]) {
    if (source[key] === undefined || source[key] === null) continue;
    if (typeof source[key] !== "boolean") throw policyError("mailbox_listener_filter_invalid", 400);
    filter[key] = source[key];
  }
  return filter;
}

function filterKey(filter = {}) {
  return hash(JSON.stringify(filter));
}

function matches(listener = {}, message = {}) {
  const filter = listener.filter || {};
  if (filter.fromIncludes && !lower(message.headers?.from).includes(filter.fromIncludes)) return false;
  if (filter.subjectIncludes && !lower(message.headers?.subject).includes(filter.subjectIncludes)) return false;
  if (filter.hasAttachments === true && !(message.attachments || []).length) return false;
  if (filter.hasAttachments === false && (message.attachments || []).length) return false;
  if (filter.verificationOnly === true && !(message.verificationCandidates || []).length) return false;
  if (filter.verificationOnly === false && (message.verificationCandidates || []).length) return false;
  return true;
}

function mailboxPayload(mailbox = {}, message = {}) {
  const from = clean(message.headers?.from).slice(0, 500);
  const subject = clean(message.headers?.subject).slice(0, 500);
  const snippet = clean(message.snippet).slice(0, 500);
  return {
    text: [
      `[Mailbox message for ${mailbox.address}]`,
      from ? `From: ${from}` : "",
      subject ? `Subject: ${subject}` : "",
      "",
      snippet || "(No text body was supplied.)",
    ].filter((line, index) => line || index === 3).join("\n"),
    from,
    subject,
    messageId: clean(message.headers?.messageId).slice(0, 500),
    attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
  };
}

function deliveryId(resourceId, messageKey, listenerId, generation) {
  return `mbd-${hash(`${resourceId}:${messageKey}:${listenerId}:${generation}`).slice(0, 48)}`;
}

function quarantineId(resourceId, messageKey) {
  return deliveryId(resourceId, messageKey, "unrouted", 0);
}

function systemPrincipal(mailbox = {}) {
  return { kind: "system", userId: mailbox.ownerUserId || "system" };
}

function policyModeRequired(env = process.env) {
  if (threadResourceAccessMode("mailbox", env) === "off") throw policyError("mailbox_listener_policy_mode_required", 409);
}

export async function createMailboxThreadListener({ mailbox, threadId, filter = {}, principal = {}, idempotencyKey = "", expectedPolicyRevision } = {}, env = process.env) {
  if (!mailbox?.id || mailbox?.target?.type !== "main") throw policyError("mailbox_listener_main_mailbox_required", 409);
  policyModeRequired(env);
  const resourceId = mailboxResourceId(mailbox, env);
  const decision = await assertThreadResourceAccess({
    resourceType: "mailbox", resourceId, resourceKey: mailbox.id, ownerUserId: mailbox.ownerUserId,
    threadId, principal, permission: "subscribe",
  }, env);
  if (!decision.granted || decision.shadowDenied || !decision.grant) throw policyError("mailbox_listener_subscribe_grant_required", 403);
  const normalized = normalizedFilter(filter);
  const key = filterKey(normalized);
  const result = await mutateThreadResourcePolicy((state) => {
    if (expectedPolicyRevision !== undefined && Number(expectedPolicyRevision) !== Number(state.revision)) throw policyError("mailbox_listener_policy_revision_conflict", 409);
    if (Number(decision.policyRevision) !== Number(state.revision)) throw policyError("mailbox_listener_policy_revision_conflict", 409);
    const resource = state.resources.find((item) => item.resourceType === "mailbox" && item.id === resourceId);
    if (!resource || resource.status !== "active" || resource.retiredAt) throw policyError("mailbox_listener_resource_inactive", 409);
    const existing = (state.mailboxListeners || []).find((item) => item.resourceId === resourceId && item.threadId === threadId && item.filterKey === key && item.status === "active" && !item.revokedAt);
    if (existing) return { noChange: true, result: { listener: existing, idempotent: true } };
    const prior = clean(idempotencyKey) && (state.mailboxListeners || []).find((item) => item.idempotencyKey === clean(idempotencyKey));
    if (prior) {
      // The physical uniqueness guard is intentionally global, so an idempotency
      // key can never silently create (or return) a listener for another
      // mailbox, thread, or filter.
      if (prior.resourceId !== resourceId || prior.threadId !== threadId || prior.filterKey !== key) {
        throw policyError("mailbox_listener_idempotency_target_mismatch", 409);
      }
      return { noChange: true, result: { listener: prior, idempotent: true } };
    }
    const generations = (state.mailboxListeners || []).filter((item) => item.resourceId === resourceId && item.threadId === threadId && item.filterKey === key).map((item) => Number(item.generation || 0));
    const timestamp = nowIso();
    const listener = {
      id: randomUUID(), resourceType: "mailbox", resourceId, threadId, filter: normalized, filterKey: key,
      generation: Math.max(0, ...generations) + 1, status: "active", grantRevision: decision.grantRevision,
      policyRevision: decision.policyRevision, resourceGeneration: decision.resourceGeneration,
      createdAt: timestamp, updatedAt: timestamp, revokedAt: null, revokedBy: null, reason: null,
      idempotencyKey: clean(idempotencyKey),
    };
    state.mailboxListeners = [...(state.mailboxListeners || []), listener];
    return {
      listener,
      idempotent: false,
      transactionalAudit: { action: "mailbox_listener_created", resourceType: "mailbox", actorUserId: clean(principal.userId || "system"), outcome: "allowed", reason: "explicit_listener" },
    };
  }, env);
  if (!result.result.idempotent) await appendEvent({ type: "mailbox_thread_listener_created", mailboxId: mailbox.id, resourceId, threadId, listenerId: result.result.listener.id, listenerGeneration: result.result.listener.generation }, env).catch(() => {});
  return { ok: true, listener: publicListener(result.result.listener), policyRevision: result.state.revision, idempotent: result.result.idempotent };
}

export async function listMailboxThreadListeners({ mailbox, threadId, principal = {}, includeRevoked = false } = {}, env = process.env) {
  if (!mailbox?.id) throw policyError("mailbox_listener_mailbox_required", 400);
  policyModeRequired(env);
  const resourceId = mailboxResourceId(mailbox, env);
  const decision = await assertThreadResourceAccess({ resourceType: "mailbox", resourceId, resourceKey: mailbox.id, ownerUserId: mailbox.ownerUserId, threadId, principal, permission: "read" }, env);
  if (!decision.granted || decision.shadowDenied || !decision.grant) throw policyError("mailbox_listener_read_grant_required", 403);
  const state = await readThreadResourcePolicy(env);
  return (state.mailboxListeners || []).filter((item) => item.resourceId === resourceId && item.threadId === threadId && (includeRevoked || (item.status === "active" && !item.revokedAt))).map(publicListener);
}

export async function revokeMailboxThreadListener({ mailbox, listenerId, principal = {}, reason = "", expectedPolicyRevision } = {}, env = process.env) {
  if (!mailbox?.id || !clean(listenerId)) throw policyError("mailbox_listener_not_found", 404);
  policyModeRequired(env);
  const resourceId = mailboxResourceId(mailbox, env);
  const before = await readThreadResourcePolicy(env);
  const existing = (before.mailboxListeners || []).find((item) => item.id === clean(listenerId) && item.resourceId === resourceId);
  if (!existing) throw policyError("mailbox_listener_not_found", 404);
  const decision = await assertThreadResourceAccess({ resourceType: "mailbox", resourceId, resourceKey: mailbox.id, ownerUserId: mailbox.ownerUserId, threadId: existing.threadId, principal, permission: "manage" }, env);
  if (!decision.granted || decision.shadowDenied || !decision.grant) throw policyError("mailbox_listener_manage_grant_required", 403);
  const result = await mutateThreadResourcePolicy((state) => {
    if (expectedPolicyRevision !== undefined && Number(expectedPolicyRevision) !== Number(state.revision)) throw policyError("mailbox_listener_policy_revision_conflict", 409);
    if (Number(decision.policyRevision) !== Number(state.revision)) throw policyError("mailbox_listener_policy_revision_conflict", 409);
    const listener = (state.mailboxListeners || []).find((item) => item.id === existing.id && item.resourceId === resourceId);
    if (!listener || listener.status !== "active" || listener.revokedAt) return { noChange: true, result: { listener: listener || existing, idempotent: true } };
    const timestamp = nowIso();
    listener.status = "revoked"; listener.generation += 1; listener.revokedAt = timestamp; listener.revokedBy = clean(principal.userId || "system"); listener.reason = clean(reason).slice(0, 300) || "listener_revoked"; listener.updatedAt = timestamp;
    state.mailboxDeliveries = (state.mailboxDeliveries || []).map((delivery) => delivery.listenerId === listener.id && activeDeliveryStates.has(delivery.state)
      ? { ...delivery, state: "revoked", epoch: Number(delivery.epoch || 1) + 1, claimToken: null, claimExpiresAt: null, reason: "mailbox_listener_revoked", updatedAt: timestamp }
      : delivery);
    return {
      listener,
      idempotent: false,
      transactionalAudit: { action: "mailbox_listener_revoked", resourceType: "mailbox", actorUserId: clean(principal.userId || "system"), outcome: "allowed", reason: listener.reason },
    };
  }, env);
  if (!result.result.idempotent) recordThreadResourceInvalidationMetric({ resourceType: "mailbox", subject: "listener", reason: "listener_revoked" });
  if (!result.result.idempotent) await appendEvent({ type: "mailbox_thread_listener_revoked", mailboxId: mailbox.id, resourceId, threadId: existing.threadId, listenerId: existing.id, listenerGeneration: result.result.listener.generation }, env).catch(() => {});
  return { ok: true, listener: publicListener(result.result.listener), policyRevision: result.state.revision, idempotent: result.result.idempotent };
}

export async function enqueueMailboxThreadDeliveries({ mailbox, message, idempotencyKey } = {}, env = process.env) {
  if (!mailbox?.id || mailbox.target?.type !== "main") throw policyError("mailbox_thread_delivery_main_mailbox_required", 409);
  policyModeRequired(env);
  if (threadResourceAccessMode("mailbox", env) === "shadow") {
    const shadowEvaluation = await evaluateMailboxThreadDeliveryShadow({ mailbox, message, idempotencyKey }, env);
    return { ok: true, deliveryIds: [], queued: 0, unrouted: false, idempotent: true, shadow: true, shadowEvaluation };
  }
  const resourceId = mailboxResourceId(mailbox, env);
  const messageKey = clean(idempotencyKey);
  if (!messageKey) throw policyError("mailbox_message_idempotency_required", 400);
  // Route sources are immutable mailbox ingress records. Legacy listeners use
  // the existing append-only deliveries below and never acquire execution or
  // context semantics merely by being present.
  const routeSource = await enqueueMailboxRouteSource({ mailbox, message, idempotencyKey: messageKey }, env);
  const snapshot = await readThreadResourcePolicy(env);
  const resource = snapshot.resources.find((item) => item.resourceType === "mailbox" && item.id === resourceId && item.status === "active" && !item.retiredAt) || null;
  const candidates = resource ? (snapshot.mailboxListeners || []).filter((item) => item.resourceId === resourceId && item.status === "active" && !item.revokedAt && matches(item, message)) : [];
  const decisions = await Promise.all(candidates.map(async (listener) => ({ listener, decision: await authorizeThreadResourceAccess({ resourceType: "mailbox", resourceId, resourceKey: mailbox.id, ownerUserId: mailbox.ownerUserId, threadId: listener.threadId, principal: systemPrincipal(mailbox), permission: "subscribe" }, env) })));
  const result = await mutateThreadResourcePolicy((state) => {
    const timestamp = nowIso();
    const current = state.resources.find((item) => item.resourceType === "mailbox" && item.id === resourceId && item.status === "active" && !item.retiredAt) || null;
    const valid = current ? decisions.filter(({ listener, decision }) => {
      const live = (state.mailboxListeners || []).find((item) => item.id === listener.id && item.status === "active" && !item.revokedAt && item.generation === listener.generation);
      return Boolean(live && decision.granted && !decision.shadowDenied && decision.grant && decision.policyRevision === state.revision && decision.resourceGeneration === current.generation && matches(live, message));
    }) : [];
    const payload = mailboxPayload(mailbox, message);
    const deliveries = [];
    for (const { listener, decision } of valid) {
      const id = deliveryId(resourceId, messageKey, listener.id, listener.generation);
      const existing = (state.mailboxDeliveries || []).find((item) => item.dedupeKey === id);
      if (existing) { deliveries.push(existing); continue; }
      deliveries.push({ id, dedupeKey: id, resourceType: "mailbox", resourceId, mailboxId: mailbox.id, listenerId: listener.id, listenerGeneration: listener.generation, threadId: listener.threadId, state: "pending", epoch: 1, attemptCount: 0, maxAttempts: 5, nextAttemptAt: timestamp, claimToken: null, claimExpiresAt: null, grantRevision: decision.grantRevision, policyRevision: decision.policyRevision, resourceGeneration: decision.resourceGeneration, messageKey, payload, reason: null, createdAt: timestamp, updatedAt: timestamp, deliveredAt: null });
    }
    if (!deliveries.length) {
      const id = quarantineId(resourceId, messageKey);
      const existing = (state.mailboxDeliveries || []).find((item) => item.dedupeKey === id);
      const quarantine = existing || { id, dedupeKey: id, resourceType: "mailbox", resourceId, mailboxId: mailbox.id, listenerId: null, listenerGeneration: 0, threadId: null, state: "quarantined", epoch: 1, attemptCount: 0, maxAttempts: 0, nextAttemptAt: null, claimToken: null, claimExpiresAt: null, grantRevision: 0, policyRevision: state.revision, resourceGeneration: current?.generation || 0, messageKey, payload, reason: current ? "mailbox_no_authorized_listener" : "mailbox_resource_not_registered", createdAt: timestamp, updatedAt: timestamp, deliveredAt: null };
      if (!existing) state.mailboxDeliveries = [...(state.mailboxDeliveries || []), quarantine];
      return { deliveries: [quarantine], queued: 0, unrouted: true, idempotent: Boolean(existing), skipPolicyEpoch: true };
    }
    state.mailboxDeliveries = [...(state.mailboxDeliveries || []), ...deliveries.filter((item) => !(state.mailboxDeliveries || []).some((existing) => existing.dedupeKey === item.dedupeKey))];
    return { deliveries, queued: deliveries.filter((item) => item.state === "pending").length, unrouted: false, idempotent: deliveries.every((item) => item.createdAt !== timestamp), skipPolicyEpoch: true };
  }, env);
  for (const delivery of result.result.deliveries || []) {
    recordMailboxThreadDeliveryMetrics({ state: delivery.state, lagMs: Date.now() - Date.parse(delivery.createdAt || "") });
  }
  await appendEvent({ type: result.result.unrouted ? "mailbox_thread_delivery_unrouted" : "mailbox_thread_delivery_queued", mailboxId: mailbox.id, resourceId, deliveryCount: result.result.queued, idempotencyKey: messageKey }, env).catch(() => {});
  return { ok: true, deliveryIds: result.result.deliveries.map((item) => item.id), queued: result.result.queued, unrouted: result.result.unrouted, policyRevision: result.state.revision, idempotent: result.result.idempotent, routeSource };
}

export async function routeMainMailboxThreadDelivery({ mailbox, message, idempotencyKey, publicMailbox } = {}, env = process.env) {
  const legacySpool = (policyUnavailable = false) => ({
    ok: true,
    action: "connector_inbox_required",
    created: null,
    mailbox: publicMailbox,
    ...(policyUnavailable ? { policyUnavailable: true } : {}),
    connectorInboxInput: { id: idempotencyKey, connector: "mailbox", accountId: mailbox.id, conversationId: mailbox.id, payload: message },
    idempotencyKey,
  });
  const mode = threadResourceAccessMode("mailbox", env);
  if (mode === "off") return legacySpool();
  if (mode === "shadow") {
    const shadowEvaluation = await evaluateMailboxThreadDeliveryShadow({ mailbox, message, idempotencyKey }, env);
    return { ...legacySpool(), shadowEvaluation };
  }
  // The connector inbox owns ingress dedupe and spooling. It calls the
  // listener dispatcher only after the mailbox/message pair is committed once.
  return {
    ok: true,
    action: "mailbox_thread_delivery_required",
    created: null,
    mailbox: publicMailbox,
    connectorInboxInput: { id: idempotencyKey, connector: "mailbox", accountId: mailbox.id, conversationId: mailbox.id, payload: message },
    mailboxDeliveryInput: { mailbox, message, idempotencyKey },
    idempotencyKey,
  };
}

export function isMailboxThreadPolicyUnavailable(error) {
  return error?.statusCode >= 500 || /^thread_resource_policy_(transactional_store_required|postgres_unavailable|postgres_driver_missing|transaction_conflict)/.test(lower(error?.message));
}

async function validateDelivery(delivery = {}, env = process.env) {
  if (!delivery.listenerId || !delivery.threadId) return { ok: false, reason: delivery.reason || "mailbox_unrouted" };
  const state = await readThreadResourcePolicy(env);
  const listener = (state.mailboxListeners || []).find((item) => item.id === delivery.listenerId && item.status === "active" && !item.revokedAt && item.generation === delivery.listenerGeneration);
  if (!listener) return { ok: false, reason: "mailbox_listener_stale", state };
  const resource = state.resources.find((item) => item.resourceType === "mailbox" && item.id === delivery.resourceId && item.status === "active" && !item.retiredAt);
  if (!resource) return { ok: false, reason: "mailbox_resource_inactive", state };
  const decision = await authorizeThreadResourceAccess({ resourceType: "mailbox", resourceId: delivery.resourceId, resourceKey: resource.resourceKey, ownerUserId: resource.ownerUserId, threadId: delivery.threadId, principal: { kind: "system", userId: resource.ownerUserId }, permission: "subscribe" }, env);
  const binding = decision.authorizationBinding || {};
  const matchesEpoch = decision.granted && !decision.shadowDenied && decision.grant && Number(binding.policyRevision) === Number(delivery.policyRevision) && Number(binding.grantRevision) === Number(delivery.grantRevision) && Number(binding.resourceGeneration) === Number(delivery.resourceGeneration);
  return matchesEpoch ? { ok: true, state, listener, resource, decision } : { ok: false, reason: "mailbox_delivery_policy_stale", state };
}

async function revalidateClaimBeforeAppend(delivery = {}, claimToken = "", env = process.env) {
  const validation = await validateDelivery(delivery, env);
  if (!validation.ok) return validation;
  const checked = await mutateThreadResourcePolicy((state) => {
    const live = (state.mailboxDeliveries || []).find((item) => item.id === delivery.id);
    const listener = (state.mailboxListeners || []).find((item) => item.id === delivery.listenerId);
    const resource = state.resources.find((item) => item.resourceType === "mailbox" && item.id === delivery.resourceId);
    const current = Boolean(
      live?.state === "claimed" && live.claimToken === claimToken && Number(live.epoch || 1) === Number(delivery.epoch || 1) &&
      listener?.status === "active" && !listener.revokedAt && Number(listener.generation || 0) === Number(delivery.listenerGeneration || 0) &&
      resource?.status === "active" && !resource.retiredAt && Number(state.revision) === Number(validation.state.revision),
    );
    return { noChange: true, result: { current } };
  }, env);
  return checked.result?.current ? validation : { ok: false, reason: "mailbox_delivery_claim_stale" };
}

// The policy store serializes all mutations on its revision row. Keeping that
// fence open while the thread store performs its deterministic-id append means
// a listener revoke has one unambiguous order: it commits before the final
// authorization (no append), or after the append has durably committed.
async function appendMailboxThreadDeliveryWithFence(delivery = {}, claimToken = "", appendMessage = appendThreadMessage, env = process.env) {
  const validation = await revalidateClaimBeforeAppend(delivery, claimToken, env);
  if (!validation.ok) return { ok: false, invalidated: true, reason: validation.reason };
  const outcome = await fenceThreadResourcePolicyDelivery(async (state) => {
    const live = (state.mailboxDeliveries || []).find((item) => item.id === delivery.id);
    const listener = (state.mailboxListeners || []).find((item) => item.id === delivery.listenerId);
    const resource = state.resources.find((item) => item.resourceType === "mailbox" && item.id === delivery.resourceId);
    const current = Boolean(
      live?.state === "claimed" && live.claimToken === claimToken && Number(live.epoch || 1) === Number(delivery.epoch || 1) &&
      listener?.status === "active" && !listener.revokedAt && Number(listener.generation || 0) === Number(delivery.listenerGeneration || 0) &&
      resource?.status === "active" && !resource.retiredAt && Number(state.revision) === Number(validation.state.revision),
    );
    if (!current) return { result: { ok: false, invalidated: true, reason: "mailbox_delivery_claim_stale" }, persist: false };
    try {
      await appendMessage(delivery.threadId, {
        role: "user", source: "mailbox", connector: "mailbox", clientMessageId: `mailbox-delivery:${delivery.id}`,
        externalId: delivery.messageKey, text: delivery.payload.text,
      }, env);
      const timestamp = nowIso();
      live.epoch = Number(live.epoch || 1) + 1;
      live.claimToken = null; live.claimExpiresAt = null; live.updatedAt = timestamp;
      live.state = "delivered"; live.deliveredAt = timestamp; live.reason = null;
      return { state, result: { ok: true, state: "delivered" } };
    } catch (error) {
      const timestamp = nowIso();
      live.epoch = Number(live.epoch || 1) + 1;
      live.claimToken = null; live.claimExpiresAt = null; live.updatedAt = timestamp;
      live.reason = clean(error?.message || "mailbox_thread_append_failed").slice(0, 300);
      if (live.attemptCount >= live.maxAttempts) {
        live.state = "dead-letter";
      } else {
        live.state = "pending";
        live.nextAttemptAt = new Date(Date.now() + Math.min(60_000, 1_000 * (2 ** Math.max(0, live.attemptCount - 1)))).toISOString();
      }
      return { state, result: { ok: false, invalidated: false, state: live.state, reason: live.reason } };
    }
  }, env);
  return outcome.result || { ok: false, invalidated: true, reason: "mailbox_delivery_claim_stale" };
}

async function claimMailboxThreadDelivery(deliveryIdValue, env = process.env) {
  const state = await readThreadResourcePolicy(env);
  const candidate = (state.mailboxDeliveries || []).find((item) => item.id === deliveryIdValue && item.state === "pending" && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= Date.now()));
  if (!candidate) return null;
  const valid = await validateDelivery(candidate, env);
  return mutateThreadResourcePolicy((current) => {
    const delivery = (current.mailboxDeliveries || []).find((item) => item.id === candidate.id);
    if (!delivery || delivery.state !== "pending" || Number(delivery.epoch || 1) !== Number(candidate.epoch || 1)) return { noChange: true, result: null };
    const timestamp = nowIso();
    if (!valid.ok || current.revision !== valid.state.revision) {
      delivery.state = "revoked"; delivery.epoch = Number(delivery.epoch || 1) + 1; delivery.reason = valid.reason || "mailbox_delivery_policy_stale"; delivery.updatedAt = timestamp;
      return { delivery: null, invalidated: delivery.id, skipPolicyEpoch: true };
    }
    const claimToken = randomUUID();
    delivery.state = "claimed"; delivery.epoch = Number(delivery.epoch || 1) + 1; delivery.attemptCount += 1; delivery.claimToken = claimToken; delivery.claimExpiresAt = new Date(Date.now() + 30_000).toISOString(); delivery.updatedAt = timestamp;
    return { delivery: { ...delivery }, claimToken, skipPolicyEpoch: true };
  }, env).then((outcome) => outcome.result?.delivery ? outcome.result : null);
}

async function completeMailboxThreadDelivery(delivery = {}, claimToken = "", outcome = {}, env = process.env) {
  return mutateThreadResourcePolicy((state) => {
    const live = (state.mailboxDeliveries || []).find((item) => item.id === delivery.id && item.state === "claimed" && item.claimToken === claimToken);
    if (!live) return { noChange: true, result: null };
    const timestamp = nowIso();
    live.epoch = Number(live.epoch || 1) + 1; live.claimToken = null; live.claimExpiresAt = null; live.updatedAt = timestamp;
    if (outcome.invalidated) { live.state = "revoked"; live.reason = clean(outcome.reason || "mailbox_delivery_policy_stale").slice(0, 300); return { delivery: { ...live }, skipPolicyEpoch: true }; }
    if (outcome.delivered) { live.state = "delivered"; live.deliveredAt = timestamp; live.reason = null; return { delivery: { ...live }, skipPolicyEpoch: true }; }
    live.reason = clean(outcome.reason || "mailbox_thread_append_failed").slice(0, 300);
    if (live.attemptCount >= live.maxAttempts) { live.state = "dead-letter"; return { delivery: { ...live }, skipPolicyEpoch: true }; }
    live.state = "pending"; live.nextAttemptAt = new Date(Date.now() + Math.min(60_000, 1_000 * (2 ** Math.max(0, live.attemptCount - 1)))).toISOString();
    return { delivery: { ...live }, skipPolicyEpoch: true };
  }, env);
}

async function recoverExpiredMailboxThreadClaims(env = process.env) {
  const result = await mutateThreadResourcePolicy((state) => {
    const timestamp = nowIso();
    let recovered = 0;
    state.mailboxDeliveries = (state.mailboxDeliveries || []).map((delivery) => {
      if (delivery.state !== "claimed" || !delivery.claimExpiresAt || Date.parse(delivery.claimExpiresAt) > Date.now()) return delivery;
      recovered += 1;
      if (delivery.attemptCount >= delivery.maxAttempts) return { ...delivery, state: "dead-letter", epoch: Number(delivery.epoch || 1) + 1, claimToken: null, claimExpiresAt: null, reason: "mailbox_delivery_claim_expired", updatedAt: timestamp };
      return { ...delivery, state: "pending", epoch: Number(delivery.epoch || 1) + 1, claimToken: null, claimExpiresAt: null, nextAttemptAt: timestamp, reason: "mailbox_delivery_claim_expired", updatedAt: timestamp };
    });
    return recovered ? { recovered, skipPolicyEpoch: true } : { noChange: true, result: { recovered: 0 } };
  }, env);
  return result.result?.recovered || 0;
}

async function acquireMailboxThreadDeliveryPumpLease(env = process.env) {
  const token = randomUUID();
  const result = await mutateThreadResourcePolicy((state) => {
    const timestamp = nowIso();
    const leases = Array.isArray(state.mailboxPumpLeases) ? state.mailboxPumpLeases : [];
    const current = leases.find((item) => item.name === mailboxPumpLeaseName) || null;
    if (current?.expiresAt && Date.parse(current.expiresAt) > Date.now()) {
      return { noChange: true, result: { acquired: false, expiresAt: current.expiresAt } };
    }
    const lease = { name: mailboxPumpLeaseName, token, expiresAt: new Date(Date.now() + mailboxThreadDeliveryPumpLeaseMs(env)).toISOString(), updatedAt: timestamp };
    state.mailboxPumpLeases = [...leases.filter((item) => item.name !== mailboxPumpLeaseName), lease];
    return { acquired: true, lease, skipPolicyEpoch: true };
  }, env);
  return result.result;
}

async function releaseMailboxThreadDeliveryPumpLease(token = "", env = process.env) {
  if (!token) return false;
  const result = await mutateThreadResourcePolicy((state) => {
    const leases = Array.isArray(state.mailboxPumpLeases) ? state.mailboxPumpLeases : [];
    const current = leases.find((item) => item.name === mailboxPumpLeaseName && item.token === token);
    if (!current) return { noChange: true, result: { released: false } };
    state.mailboxPumpLeases = leases.filter((item) => item.name !== mailboxPumpLeaseName);
    return { released: true, skipPolicyEpoch: true };
  }, env);
  return result.result?.released === true;
}

async function runMailboxThreadDeliveryPump({ limit, replay } = {}, env = process.env) {
  const lease = await acquireMailboxThreadDeliveryPumpLease(env);
  if (!lease?.acquired) return { ok: true, skipped: "lease_held", deliveries: null, replay: null };
  try {
    const deliveries = await dispatchMailboxThreadDeliveries({ limit: limit || mailboxThreadDeliveryPumpLimit(env) }, env);
    const replayed = typeof replay === "function" ? await replay() : null;
    return { ok: true, skipped: "", deliveries, replay: replayed };
  } finally {
    await releaseMailboxThreadDeliveryPumpLease(lease.lease.token, env);
  }
}

export function pumpMailboxThreadDeliveries(options = {}, env = process.env) {
  if (threadResourceAccessMode("mailbox", env) === "off") {
    return Promise.resolve({ ok: true, skipped: "mode_off", deliveries: null, replay: null });
  }
  const key = mailboxPumpRunKey(env);
  if (localPumpRuns.has(key)) return Promise.resolve({ ok: true, skipped: "in_process", deliveries: null, replay: null });
  const run = runMailboxThreadDeliveryPump(options, env);
  localPumpRuns.set(key, run);
  return run.finally(() => {
    if (localPumpRuns.get(key) === run) localPumpRuns.delete(key);
  });
}

export async function dispatchMailboxThreadDeliveries({ deliveryIds = [], limit = 25, appendMessage = appendThreadMessage } = {}, env = process.env) {
  await recoverExpiredMailboxThreadClaims(env);
  const requested = new Set((Array.isArray(deliveryIds) ? deliveryIds : [deliveryIds]).map(clean).filter(Boolean));
  const state = await readThreadResourcePolicy(env);
  const candidates = (state.mailboxDeliveries || []).filter((item) => item.state === "pending" && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= Date.now()) && (!requested.size || requested.has(item.id))).slice(0, Math.max(1, Math.min(100, Number(limit || 25) || 25)));
  const results = [];
  for (const candidate of candidates) {
    const claim = await claimMailboxThreadDelivery(candidate.id, env);
    if (!claim) continue;
    const appended = await appendMailboxThreadDeliveryWithFence(claim.delivery, claim.claimToken, appendMessage, env);
    if (appended.ok) {
      results.push({ id: candidate.id, state: "delivered" });
      continue;
    }
    if (appended.invalidated) {
      await completeMailboxThreadDelivery(claim.delivery, claim.claimToken, { invalidated: true, reason: appended.reason }, env);
      results.push({ id: candidate.id, state: "revoked", reason: appended.reason });
      continue;
    }
    results.push({ id: candidate.id, state: appended.state || "pending", reason: appended.reason });
  }
  const deadLetters = results.filter((item) => item.state === "dead-letter").length;
  for (const item of results) {
    const delivery = (state.mailboxDeliveries || []).find((candidate) => candidate.id === item.id);
    recordMailboxThreadDeliveryMetrics({ state: item.state, lagMs: delivery ? Date.now() - Date.parse(delivery.createdAt || "") : 0 });
  }
  if (deadLetters) await appendEvent({ type: "mailbox_thread_delivery_dead_lettered", deadLetterCount: deadLetters }, env).catch(() => {});
  return { ok: true, results, delivered: results.filter((item) => item.state === "delivered").length, deadLetters };
}
