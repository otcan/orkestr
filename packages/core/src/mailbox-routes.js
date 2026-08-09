import { createHash, randomUUID } from "node:crypto";
import { appendEvent } from "../../storage/src/store.js";
import { assertSanitizedAction } from "./llm-sanitizer.js";
import { recordMailboxRouteMetrics } from "./observability.js";
import { isAdminPrincipal, policyError } from "./policy.js";
import { consumeApprovedPairingChallengeForAction, createPairingChallenge } from "./security.js";
import {
  assertThreadResourceAccess,
  authorizeThreadResourceAccess,
  fenceThreadResourcePolicyDelivery,
  mutateThreadResourcePolicy,
  readThreadResourcePolicy,
  threadResourceAccessMode,
  threadResourceId,
} from "./thread-resource-grants.js";

const modes = new Set(["append_only", "process_immediately", "context_next_turn"]);
// Every non-terminal route work item consumes bounded route capacity and must
// be cancellable by a route revoke. `context_pending` is deliberately here:
// it is work waiting for a human turn, not a completed delivery.
const activeWork = new Set(["pending", "claimed", "context_pending", "accepted", "running"]);
const cancellableWork = new Set(["pending", "claimed", "context_pending"]);
const clean = (value = "") => String(value || "").trim();
const lower = (value = "") => clean(value).toLowerCase();
const nowIso = () => new Date().toISOString();
const digest = (value = "") => createHash("sha256").update(String(value)).digest("hex");
const routeIdFor = (resourceId) => `mbr-${digest(`${resourceId}:${randomUUID()}`).slice(0, 40)}`;
const sourceIdFor = (resourceId, messageKey) => `mbs-${digest(`${resourceId}:${messageKey}`).slice(0, 40)}`;
const workIdFor = (route, source) => `mbw-${digest(`${route.id}:${route.generation}:${source.id}`).slice(0, 40)}`;
const contextIdFor = (work) => `mbc-${digest(work.id).slice(0, 40)}`;

function mailboxResourceId(mailbox = {}, env = process.env) {
  return threadResourceId("mailbox", mailbox.id, mailbox.ownerUserId, env);
}

function requiredPolicyMode(env = process.env) {
  if (threadResourceAccessMode("mailbox", env) === "off") throw policyError("mailbox_route_policy_mode_required", 409);
}

function routeMode(value = "") {
  const mode = lower(value || "append_only");
  if (!modes.has(mode)) throw policyError("mailbox_route_mode_invalid", 400);
  return mode;
}

function publicRoute(route = {}) {
  return {
    id: route.id, mailboxResourceId: route.resourceId, mailboxId: route.mailboxId, threadId: route.threadId,
    mode: route.mode, generation: route.generation, status: route.status, grantRevision: route.grantRevision,
    processGrantRevision: route.processGrantRevision || 0, policyRevision: route.policyRevision,
    resourceGeneration: route.resourceGeneration, createdAt: route.createdAt, updatedAt: route.updatedAt,
    revokedAt: route.revokedAt || null, reason: route.reason || null,
  };
}

function publicSource(source = {}) {
  return {
    id: source.id, mailboxResourceId: source.resourceId, mailboxId: source.mailboxId, messageKeyHash: digest(source.messageKey || "").slice(0, 24),
    state: source.state, suppressionReason: source.suppressionReason || "", attachmentCount: source.payload?.attachmentCount || 0,
    createdAt: source.createdAt, updatedAt: source.updatedAt,
  };
}

function mailboxPayload(mailbox = {}, message = {}) {
  const from = clean(message.headers?.from || message.from).slice(0, 500);
  const subject = clean(message.headers?.subject || message.subject).slice(0, 500);
  const snippet = clean(message.snippet || message.body?.text || message.text).slice(0, 8_000);
  const attachments = (Array.isArray(message.attachments) ? message.attachments : []).slice(0, 20).map((attachment) => ({
    filename: clean(attachment?.filename || attachment?.name).slice(0, 200),
    contentType: clean(attachment?.contentType || attachment?.mimetype || attachment?.type).slice(0, 120),
    sizeBytes: Math.max(0, Number(attachment?.sizeBytes || attachment?.size || 0) || 0),
  }));
  return {
    text: [
      `[Mailbox message for ${clean(mailbox.address).slice(0, 300)}]`,
      from ? `From: ${from}` : "",
      subject ? `Subject: ${subject}` : "",
      "",
      snippet || "(No text body was supplied.)",
      attachments.length ? `Attachments: ${attachments.length} metadata-only item(s); content is unavailable in this turn.` : "",
    ].filter((line, index) => line || index === 3).join("\n"),
    from, subject, messageId: clean(message.headers?.messageId || message.messageId).slice(0, 500),
    attachmentCount: attachments.length, attachments,
  };
}

function suppressionReason(message = {}, env = process.env) {
  const headers = message.headers || {};
  const auto = lower(headers.autoSubmitted || headers["auto-submitted"]);
  if (auto && auto !== "no") return "auto_submitted";
  const from = lower(headers.from || message.from);
  const subject = lower(headers.subject || message.subject);
  if (/mailer-daemon|postmaster/.test(from) || /(?:delivery status|undeliverable|failure notice)/.test(subject)) return "bounce";
  if (lower(headers["x-orkestr-origin"] || headers.xOrkestrOrigin) || message.orkestrOrigin === true || message.knownOutbound === true) return "orkestr_origin";
  const ancestry = String(headers.references || headers.inReplyTo || headers["in-reply-to"] || message.ancestry || "").trim().split(/\s+/).filter(Boolean);
  const maxAncestry = Math.max(1, Math.min(50, Number(env.ORKESTR_MAILBOX_ROUTE_MAX_ANCESTRY || 12) || 12));
  if (ancestry.length > maxAncestry) return "ancestry_limit";
  return "";
}

function routeBacklogLimit(env = process.env) {
  return Math.max(1, Math.min(10_000, Number(env.ORKESTR_MAILBOX_ROUTE_BACKLOG_LIMIT || 250) || 250));
}

function routeContextLimit(env = process.env) {
  return Math.max(1, Math.min(100, Number(env.ORKESTR_MAILBOX_ROUTE_CONTEXT_LIMIT || 10) || 10));
}

function routeSourceRetentionLimit(env = process.env) {
  return Math.max(1, Math.min(100_000, Number(env.ORKESTR_MAILBOX_ROUTE_SOURCE_RETENTION_LIMIT || 1_000) || 1_000));
}

function contextReservationMs(env = process.env) {
  return Math.max(5_000, Math.min(15 * 60_000, Number(env.ORKESTR_MAILBOX_ROUTE_CONTEXT_RESERVATION_MS || 60_000) || 60_000));
}

function externalMailboxActor(mailbox = {}) {
  return { kind: "external_mailbox", role: "external", userId: `mailbox:${clean(mailbox.id)}`, mailboxId: clean(mailbox.id) };
}

function canonicalNewThreadIdentity(mailbox = {}, newThread = null) {
  if (!newThread || typeof newThread !== "object" || Array.isArray(newThread)) return null;
  const id = clean(newThread.id).slice(0, 160);
  const name = clean(newThread.name || newThread.title || `Mailbox ${mailbox.address || ""}`).slice(0, 160);
  return { id, name, canonical: JSON.stringify({ id, name }) };
}

function routeApprovalIntent({ action, mailbox, route = null, threadId = "", mode = "", newThread = null } = {}, env = process.env) {
  const identity = canonicalNewThreadIdentity(mailbox, newThread);
  return {
    mailboxRouteAction: clean(action),
    mailboxId: clean(mailbox?.id),
    mailboxResourceId: mailboxResourceId(mailbox, env),
    routeId: clean(route?.id),
    sourceThreadId: clean(route?.threadId),
    sourceMode: clean(route?.mode),
    destinationThreadId: clean(threadId),
    destinationMode: clean(mode),
    ...(identity ? { newThreadId: identity.id, newThreadName: identity.name, newThreadIdentity: identity.canonical } : {}),
  };
}

async function requireRouteAttendedApproval({ action, mailbox, route = null, threadId = "", mode = "", newThread = null, principal = {}, approval = "", request = null } = {}, env = process.env) {
  const requiredAction = `mailbox_route:${clean(action)}`;
  const authIntent = routeApprovalIntent({ action, mailbox, route, threadId, mode, newThread }, env);
  if (clean(approval)) {
    await consumeApprovedPairingChallengeForAction(approval, {
      env,
      action: requiredAction,
      authIntent,
      consumedBy: `mailbox-route:${clean(principal.userId || principal.id || "unknown")}`,
    });
    return null;
  }
  const created = await createPairingChallenge({
    request: request || { headers: {}, socket: {} },
    env,
    userId: clean(principal.userId || principal.id),
    role: isAdminPrincipal(principal) ? "admin" : "user",
    requestedPath: `/api/mailboxes/${encodeURIComponent(clean(mailbox?.id))}/routes`,
    allowedActions: [requiredAction],
    authIntent,
  });
  return {
    ok: false,
    status: "approval_required",
    action: requiredAction,
    challenge: {
      id: created.challengeId,
      approveCode: created.challenge?.approveCode || "",
      expiresAt: created.expiresAt,
      approveCommand: `orkestr security approve ${created.challenge?.approveCode || created.challengeId}`,
      authIntent,
    },
  };
}

async function routeDecision(mailbox, threadId, permission, env) {
  return authorizeThreadResourceAccess({
    resourceType: "mailbox", resourceId: mailboxResourceId(mailbox, env), resourceKey: mailbox.id,
    ownerUserId: mailbox.ownerUserId, threadId, principal: { kind: "system", userId: mailbox.ownerUserId }, permission,
  }, env);
}

async function assertRouteSetupAccess(mailbox, threadId, principal, mode, env) {
  const resourceId = mailboxResourceId(mailbox, env);
  let subscribe;
  try {
    subscribe = await assertThreadResourceAccess({ resourceType: "mailbox", resourceId, resourceKey: mailbox.id, ownerUserId: mailbox.ownerUserId, threadId, principal, permission: "subscribe" }, env);
  } catch (error) {
    if (clean(error?.message) === "mailbox_grant_required") throw policyError("mailbox_route_subscribe_grant_required", 403);
    throw error;
  }
  if (!subscribe.granted || subscribe.shadowDenied || !subscribe.grant) throw policyError("mailbox_route_subscribe_grant_required", 403);
  let process = null;
  if (mode === "process_immediately") {
    try {
      process = await assertThreadResourceAccess({ resourceType: "mailbox", resourceId, resourceKey: mailbox.id, ownerUserId: mailbox.ownerUserId, threadId, principal, permission: "process" }, env);
    } catch (error) {
      if (clean(error?.message) === "mailbox_grant_required") throw policyError("mailbox_route_process_grant_required", 403);
      throw error;
    }
    if (!process.granted || process.shadowDenied || !process.grant) throw policyError("mailbox_route_process_grant_required", 403);
  }
  return { subscribe, process };
}

function legacyListenerActive(state, resourceId) {
  return (state.mailboxListeners || []).some((listener) => listener.resourceId === resourceId && listener.status === "active" && !listener.revokedAt);
}

async function compensateProvisionedMailboxRouteThread({ threadId, mailbox, principal, reason = "mailbox_route_provisioning_failed" } = {}, env = process.env) {
  const id = clean(threadId);
  if (!id) return { deleted: false, markedFailed: false };
  const [{ setThreadResourceGrants }, { deleteThread, updateThread }] = await Promise.all([import("./thread-resource-grants.js"), import("./threads.js")]);
  try {
    // The provisioning flow creates a brand-new thread and its only mailbox
    // grant. Replacing it with an explicit empty policy before deletion avoids
    // leaving a dangling eligible grant if physical thread deletion fails.
    await setThreadResourceGrants(id, "mailbox", [], {
      principal,
      source: "mailbox_route_provisioning_compensation",
      idempotencyKey: `mailbox-route-compensate:${mailboxResourceId(mailbox, env)}:${id}`,
    }, env);
    await deleteThread(id, {}, env);
    await appendEvent({ type: "mailbox_route_provisioning_compensated", mailboxId: mailbox?.id || "", threadId: id, reason }, env).catch(() => {});
    return { deleted: true, markedFailed: false };
  } catch (error) {
    const errorText = clean(error?.message || error || reason).slice(0, 300);
    await updateThread(id, {
      state: "failed",
      mailboxRouteProvisioning: { status: "failed", mailboxId: clean(mailbox?.id), reason: errorText, failedAt: nowIso() },
      lastError: errorText,
    }, env).catch(() => {});
    await appendEvent({ type: "mailbox_route_provisioning_compensation_failed", mailboxId: mailbox?.id || "", threadId: id, reason: errorText }, env).catch(() => {});
    return { deleted: false, markedFailed: true, error: errorText };
  }
}

async function provisionRouteThread(mailbox, principal, newThread, mode, env, operations = {}) {
  if (!newThread || typeof newThread !== "object") return null;
  // Grant writes are deliberately admin-only. Keep new destination creation on
  // that same explicit control plane rather than creating a thread that is
  // eligible through an implicit owner or wildcard rule.
  if (!isAdminPrincipal(principal)) throw policyError("mailbox_route_new_thread_admin_required", 403);
  const resourceId = mailboxResourceId(mailbox, env);
  const state = await readThreadResourcePolicy(env);
  if ((state.mailboxRoutes || []).some((route) => route.resourceId === resourceId && route.status === "active")) throw policyError("mailbox_route_active_exists", 409);
  if (legacyListenerActive(state, resourceId)) throw policyError("mailbox_route_legacy_listener_active", 409);
  if (!state.resources.some((resource) => resource.resourceType === "mailbox" && resource.id === resourceId && resource.status === "active" && !resource.retiredAt)) {
    throw policyError("mailbox_route_resource_inactive", 409);
  }
  const [{ createThreadForPrincipal, listThreads, updateThread }, { setThreadResourceGrants }] = await Promise.all([import("./threads.js"), import("./thread-resource-grants.js")]);
  const installGrants = typeof operations.setThreadResourceGrants === "function" ? operations.setThreadResourceGrants : setThreadResourceGrants;
  const identity = canonicalNewThreadIdentity(mailbox, newThread);
  const name = identity.name;
  const requestedId = identity.id;
  const matchingThread = (await listThreads(env)).find((thread) => thread.ownerUserId === mailbox.ownerUserId && (
    (requestedId && (thread.id === requestedId || thread.name === requestedId || thread.bindingName === requestedId)) ||
    (name && (thread.name === name || thread.bindingName === name))
  ));
  if (matchingThread) throw policyError("mailbox_route_new_thread_exists", 409);
  let created = null;
  try {
    created = await createThreadForPrincipal({
      name,
      ownerUserId: mailbox.ownerUserId,
      ...(requestedId ? { id: requestedId } : {}),
    }, principal, env);
    await updateThread(created.id, {
      mailboxRouteProvisioning: { status: "provisioning", mailboxId: mailbox.id, mode, startedAt: nowIso() },
    }, env);
    const permissions = ["read", "subscribe", "manage", ...(mode === "process_immediately" ? ["process"] : [])];
    await installGrants(created.id, "mailbox", [{ resourceId: mailbox.id, permissions, reason: "mailbox_route_new_thread" }], {
      principal,
      source: "mailbox_route_provisioning",
      idempotencyKey: `mailbox-route-thread:${resourceId}:${created.id}:${mode}`,
    }, env);
    return { threadId: created.id, permissions };
  } catch (error) {
    if (created?.id) await compensateProvisionedMailboxRouteThread({ threadId: created.id, mailbox, principal, reason: clean(error?.message) || "mailbox_route_grant_provisioning_failed" }, env);
    throw error;
  }
}

// `operations` is an internal dependency seam for deterministic storage-fault
// tests. HTTP callers use the two-argument form and cannot supply it.
async function createMailboxRouteInternal({ mailbox, threadId = "", newThread = null, mode = "append_only", principal = {}, expectedPolicyRevision, approval = "", request = null } = {}, env = process.env, operations = {}, { approvalSatisfied = false } = {}) {
  if (!mailbox?.id || mailbox.target?.type !== "main") throw policyError("mailbox_route_main_mailbox_required", 409);
  requiredPolicyMode(env);
  const normalizedMode = routeMode(mode);
  if (!clean(threadId) && (!newThread || typeof newThread !== "object")) throw policyError("mailbox_route_thread_required", 400);
  if (!clean(threadId) && !isAdminPrincipal(principal)) throw policyError("mailbox_route_new_thread_admin_required", 403);
  const resourceId = mailboxResourceId(mailbox, env);
  const before = await readThreadResourcePolicy(env);
  if (expectedPolicyRevision !== undefined && Number(expectedPolicyRevision) !== Number(before.revision)) throw policyError("mailbox_route_policy_revision_conflict", 409);
  if (legacyListenerActive(before, resourceId)) throw policyError("mailbox_route_legacy_listener_active", 409);
  if (normalizedMode === "process_immediately" && !approvalSatisfied) {
    // Validate an existing destination before asking an operator to approve a
    // potentially unusable execution route. New destinations are checked by
    // provisioning only after the attended approval has been consumed.
    if (clean(threadId)) await assertRouteSetupAccess(mailbox, clean(threadId), principal, normalizedMode, env);
    const pending = await requireRouteAttendedApproval({
      action: "create_process_immediately", mailbox, threadId: clean(threadId), mode: normalizedMode, newThread, principal, approval, request,
    }, env);
    if (pending) return pending;
  }
  let provision = null;
  try {
    provision = clean(threadId) ? null : await provisionRouteThread(mailbox, principal, newThread, normalizedMode, env, operations);
    const destinationThreadId = clean(threadId) || provision?.threadId || "";
    if (!destinationThreadId) throw policyError("mailbox_route_thread_required", 400);
    const access = await assertRouteSetupAccess(mailbox, destinationThreadId, principal, normalizedMode, env);
    const outcome = await mutateThreadResourcePolicy((state) => {
      if (!provision && expectedPolicyRevision !== undefined && Number(expectedPolicyRevision) !== Number(state.revision)) throw policyError("mailbox_route_policy_revision_conflict", 409);
      if (Number(access.subscribe.policyRevision) !== Number(state.revision)) throw policyError("mailbox_route_policy_revision_conflict", 409);
      const resource = state.resources.find((item) => item.resourceType === "mailbox" && item.id === resourceId && item.status === "active" && !item.retiredAt);
      if (!resource) throw policyError("mailbox_route_resource_inactive", 409);
      if (legacyListenerActive(state, resourceId)) throw policyError("mailbox_route_legacy_listener_active", 409);
      const existing = (state.mailboxRoutes || []).find((item) => item.resourceId === resourceId && item.status === "active");
      if (existing) {
        if (existing.threadId === destinationThreadId && existing.mode === normalizedMode) return { noChange: true, result: { route: existing, idempotent: true } };
        throw policyError("mailbox_route_active_exists", 409);
      }
      const timestamp = nowIso();
      const route = {
        id: routeIdFor(resourceId), resourceId, mailboxId: mailbox.id, threadId: destinationThreadId, mode: normalizedMode,
        generation: 1, status: "active", grantRevision: access.subscribe.grantRevision, processGrantRevision: access.process?.grantRevision || 0,
        policyRevision: access.subscribe.policyRevision, resourceGeneration: access.subscribe.resourceGeneration,
        createdAt: timestamp, updatedAt: timestamp, revokedAt: null, revokedBy: null, reason: "",
      };
      state.mailboxRoutes = [...(state.mailboxRoutes || []), route];
      return { route, idempotent: false, transactionalAudit: { action: "mailbox_route_created", resourceType: "mailbox", actorUserId: clean(principal.userId), outcome: "allowed", reason: normalizedMode } };
    }, env);
    if (provision) await (await import("./threads.js")).updateThread(provision.threadId, {
      mailboxRouteProvisioning: { status: "ready", mailboxId: mailbox.id, routeId: outcome.result.route.id, mode: normalizedMode, completedAt: nowIso() },
    }, env).catch(() => {});
    if (!outcome.result.idempotent) await appendEvent({ type: "mailbox_route_created", mailboxId: mailbox.id, routeId: outcome.result.route.id, threadId: destinationThreadId, mode: normalizedMode }, env).catch(() => {});
    return { ok: true, route: publicRoute(outcome.result.route), policyRevision: outcome.state.revision, idempotent: outcome.result.idempotent };
  } catch (error) {
    if (provision?.threadId) await compensateProvisionedMailboxRouteThread({ threadId: provision.threadId, mailbox, principal, reason: clean(error?.message) || "mailbox_route_provisioning_failed" }, env);
    throw error;
  }
}

export async function createMailboxRoute(input = {}, env = process.env, operations = {}) {
  return createMailboxRouteInternal(input, env, operations);
}

export async function listMailboxRoutes({ mailbox, principal = {}, includeRevoked = false } = {}, env = process.env) {
  if (!mailbox?.id) throw policyError("mailbox_route_mailbox_required", 400);
  requiredPolicyMode(env);
  const resourceId = mailboxResourceId(mailbox, env);
  const state = await readThreadResourcePolicy(env);
  const routes = (state.mailboxRoutes || []).filter((route) => route.resourceId === resourceId && (includeRevoked || route.status === "active"));
  for (const route of routes) {
    const decision = await assertThreadResourceAccess({ resourceType: "mailbox", resourceId, resourceKey: mailbox.id, ownerUserId: mailbox.ownerUserId, threadId: route.threadId, principal, permission: "read" }, env);
    if (!decision.granted || decision.shadowDenied || !decision.grant) throw policyError("mailbox_route_read_grant_required", 403);
  }
  return routes.map(publicRoute);
}

function cancelRouteWork(state, route, timestamp, reason) {
  state.mailboxRouteWork = (state.mailboxRouteWork || []).map((work) => work.routeId === route.id && cancellableWork.has(work.state)
    ? { ...work, state: "cancelled", generation: Number(work.generation || 1) + 1, claimToken: null, claimExpiresAt: null, reason, updatedAt: timestamp }
    : work);
  state.mailboxContexts = (state.mailboxContexts || []).map((context) => context.routeId === route.id && ["pending", "reserved"].includes(context.status)
    ? { ...context, status: "cancelled", reservedFor: null, cancelledAt: timestamp, reason, updatedAt: timestamp }
    : context);
}

export async function revokeMailboxRoute({ mailbox, routeId = "", principal = {}, reason = "", expectedPolicyRevision } = {}, env = process.env) {
  if (!mailbox?.id) throw policyError("mailbox_route_mailbox_required", 400);
  requiredPolicyMode(env);
  const resourceId = mailboxResourceId(mailbox, env);
  const before = await readThreadResourcePolicy(env);
  const existing = (before.mailboxRoutes || []).find((item) => item.id === clean(routeId) && item.resourceId === resourceId);
  if (!existing) throw policyError("mailbox_route_not_found", 404);
  const decision = await assertThreadResourceAccess({ resourceType: "mailbox", resourceId, resourceKey: mailbox.id, ownerUserId: mailbox.ownerUserId, threadId: existing.threadId, principal, permission: "manage" }, env);
  if (!decision.granted || decision.shadowDenied || !decision.grant) throw policyError("mailbox_route_manage_grant_required", 403);
  const outcome = await mutateThreadResourcePolicy((state) => {
    if (expectedPolicyRevision !== undefined && Number(expectedPolicyRevision) !== Number(state.revision)) throw policyError("mailbox_route_policy_revision_conflict", 409);
    const route = (state.mailboxRoutes || []).find((item) => item.id === existing.id && item.resourceId === resourceId);
    if (!route || route.status !== "active") return { noChange: true, result: { route: route || existing, idempotent: true } };
    const timestamp = nowIso();
    route.status = "revoked"; route.generation += 1; route.revokedAt = timestamp; route.revokedBy = clean(principal.userId); route.reason = clean(reason).slice(0, 300) || "mailbox_route_revoked"; route.updatedAt = timestamp;
    cancelRouteWork(state, route, timestamp, "mailbox_route_revoked");
    return { route, idempotent: false, transactionalAudit: { action: "mailbox_route_revoked", resourceType: "mailbox", actorUserId: clean(principal.userId), outcome: "allowed", reason: route.reason } };
  }, env);
  if (!outcome.result.idempotent) await appendEvent({ type: "mailbox_route_revoked", mailboxId: mailbox.id, routeId: existing.id, threadId: existing.threadId }, env).catch(() => {});
  return { ok: true, route: publicRoute(outcome.result.route), policyRevision: outcome.state.revision, idempotent: outcome.result.idempotent };
}

// `operations` is an internal race seam for deterministic move tests. HTTP
// callers use the two-argument form and cannot supply it.
export async function moveMailboxRoute({ mailbox, routeId, threadId, mode, principal = {}, expectedPolicyRevision, approval = "", request = null } = {}, env = process.env, operations = {}) {
  const resourceId = mailboxResourceId(mailbox, env);
  const before = await readThreadResourcePolicy(env);
  if (expectedPolicyRevision !== undefined && Number(expectedPolicyRevision) !== Number(before.revision)) throw policyError("mailbox_route_policy_revision_conflict", 409);
  const current = before.mailboxRoutes.find((route) => route.id === clean(routeId) && route.resourceId === resourceId && route.status === "active");
  if (!current) throw policyError("mailbox_route_not_found", 404);
  const manage = await assertThreadResourceAccess({ resourceType: "mailbox", resourceId, resourceKey: mailbox.id, ownerUserId: mailbox.ownerUserId, threadId: current.threadId, principal, permission: "manage" }, env);
  if (!manage.granted || manage.shadowDenied || !manage.grant) throw policyError("mailbox_route_manage_grant_required", 403);
  const destinationThreadId = clean(threadId);
  const destinationMode = routeMode(mode || current.mode);
  if (!destinationThreadId) throw policyError("mailbox_route_thread_required", 400);
  const access = await assertRouteSetupAccess(mailbox, destinationThreadId, principal, destinationMode, env);
  const pending = await requireRouteAttendedApproval({
    action: "move", mailbox, route: current, threadId: destinationThreadId, mode: destinationMode, principal, approval, request,
  }, env);
  if (pending) return pending;
  if (typeof operations.beforeMutation === "function") await operations.beforeMutation();
  const outcome = await mutateThreadResourcePolicy((state) => {
    if (expectedPolicyRevision !== undefined && Number(expectedPolicyRevision) !== Number(state.revision)) throw policyError("mailbox_route_policy_revision_conflict", 409);
    if (Number(access.subscribe.policyRevision) !== Number(state.revision) || (destinationMode === "process_immediately" && Number(access.process?.policyRevision) !== Number(state.revision))) {
      throw policyError("mailbox_route_policy_revision_conflict", 409);
    }
    const resource = state.resources.find((item) => item.resourceType === "mailbox" && item.id === resourceId && item.status === "active" && !item.retiredAt);
    if (!resource) throw policyError("mailbox_route_resource_inactive", 409);
    const route = (state.mailboxRoutes || []).find((item) => item.id === current.id && item.resourceId === resourceId && item.status === "active" && Number(item.generation) === Number(current.generation));
    if (!route) throw policyError("mailbox_route_policy_revision_conflict", 409);
    const timestamp = nowIso();
    cancelRouteWork(state, route, timestamp, "mailbox_route_moved");
    route.threadId = destinationThreadId;
    route.mode = destinationMode;
    route.generation = Number(route.generation || 1) + 1;
    route.grantRevision = access.subscribe.grantRevision;
    route.processGrantRevision = access.process?.grantRevision || 0;
    // This mutation advances the policy epoch after the callback returns, so
    // record the resulting epoch rather than the pre-move access snapshot.
    route.policyRevision = Number(state.revision) + 1;
    route.resourceGeneration = access.subscribe.resourceGeneration;
    route.updatedAt = timestamp;
    route.reason = "";
    return {
      route: { ...route },
      idempotent: false,
      transactionalAudit: {
        action: "mailbox_route_moved", resourceType: "mailbox", actorUserId: clean(principal.userId), outcome: "allowed",
        reason: `${current.threadId}:${current.mode}->${destinationThreadId}:${destinationMode}`,
      },
    };
  }, env);
  await appendEvent({
    type: "mailbox_route_moved", mailboxId: mailbox.id, routeId: current.id,
    previousThreadId: current.threadId, previousMode: current.mode, threadId: destinationThreadId, mode: destinationMode,
  }, env).catch(() => {});
  return { ok: true, route: publicRoute(outcome.result.route), policyRevision: outcome.state.revision, idempotent: false };
}

export {
  cancelMailboxRouteWork,
  consumeMailboxContextsForHumanTurn,
  discardMailboxContext,
  dispatchMailboxRouteWork,
  enqueueMailboxRouteSource,
  mailboxRouteStatus,
  reconcileMailboxRouteWorkRuntime,
  recordMailboxRouteWorkRuntime,
  releaseMailboxContextsForHumanTurn,
  reserveMailboxContextsForHumanTurn,
  retryMailboxRouteWork,
} from "./mailbox-route-runtime.js";
