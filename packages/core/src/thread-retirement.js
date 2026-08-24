import { appendEvent } from "../../storage/src/store.js";
import { stopCodexAppServerThread, threadUsesCodexAppServer } from "./codex-app-server.js";
import { sleepThread } from "./runtime-leases.js";
import { listTimers, updateTimer } from "./timers.js";
import { mutateThreadResourcePolicy } from "./thread-resource-policy-access.js";
import { THREAD_RESOURCE_PERMISSIONS } from "./thread-resource-policy-model.js";
import {
  getThread,
  isThreadRetired,
  listThreadMessageCandidates,
  updateThread,
  updateThreadMessage,
} from "./threads.js";

const clean = (value = "") => String(value || "").trim();
const nowIso = () => new Date().toISOString();
const cancellableStates = new Set(["queued", "pending_delivery", "awaiting_ack", "running"]);
const retirementReasons = new Set(["retired_by_owner", "completed_work", "superseded", "duplicate", "manual"]);

function retirementError(reason, statusCode = 409) {
  const error = new Error(reason);
  error.statusCode = statusCode;
  error.code = reason;
  return error;
}

function retirementReason(value) {
  const normalized = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return retirementReasons.has(normalized) ? normalized : "retired_by_owner";
}

function activeThreadRuntime(thread = {}) {
  const runtime = thread.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  return Boolean(
    thread.activeRuntimeLeaseId ||
    runtime.activeTurnId ||
    ["working", "waking", "running", "awaiting_approval"].includes(clean(thread.state).toLowerCase()) ||
    ["working", "waking", "running", "awaiting_approval"].includes(clean(runtime.state).toLowerCase()),
  );
}

async function cancelPendingThreadMessages(threadId, env) {
  const messages = await listThreadMessageCandidates(threadId, {
    states: [...cancellableStates],
  }, env);
  let cancelled = 0;
  for (const message of messages) {
    if (!cancellableStates.has(clean(message.state).toLowerCase())) continue;
    await updateThreadMessage(threadId, message.id, {
      state: "cancelled",
      deliveryState: "cancelled",
      error: "thread_retired",
    }, env);
    cancelled += 1;
  }
  return cancelled;
}

async function disableThreadTimers(threadId, env) {
  const timers = (await listTimers(env)).filter((timer) =>
    clean(timer.targetType).toLowerCase() === "thread" && clean(timer.target) === threadId && timer.enabled !== false,
  );
  for (const timer of timers) await updateTimer(timer.id, { enabled: false }, env);
  return timers.length;
}

function retiredBinding(binding, timestamp) {
  if (!binding || typeof binding !== "object") return null;
  return {
    ...binding,
    enabled: false,
    routeEligible: false,
    retired: true,
    retiredAt: timestamp,
    updatedAt: timestamp,
  };
}

function nextPolicyRevision(value) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision + 1 : 1;
}

// Policy state is intentionally independent of a thread document.  Retiring a
// thread therefore writes explicit-empty policies and invalidates its bearer
// sessions in the same policy transaction.  Restore deliberately does not
// undo this; access must be granted again by an authorized operator.
async function revokeThreadResourceAuthority(threadId, timestamp, actorUserId, env) {
  const persisted = await mutateThreadResourcePolicy((state) => {
    const hasPolicyState =
      state.grants.length > 0 || state.policies.length > 0 || state.resourceSessions.length > 0 ||
      state.mailboxListeners.length > 0 || state.mailboxDeliveries.length > 0;
    if (!hasPolicyState) {
      return {
        noChange: true,
        result: {
          resourceGrantCount: 0,
          resourceSessionCount: 0,
          mailboxListenerCount: 0,
          mailboxDeliveryCount: 0,
        },
      };
    }

    let resourceGrantCount = 0;
    let resourceSessionCount = 0;
    let mailboxListenerCount = 0;
    let mailboxDeliveryCount = 0;
    state.grants = state.grants.map((grant) => {
      if (grant.threadId !== threadId || grant.revokedAt) return grant;
      resourceGrantCount += 1;
      return {
        ...grant,
        revokedAt: timestamp,
        revokedBy: actorUserId,
        reason: "thread_retired",
        updatedAt: timestamp,
      };
    });

    for (const resourceType of Object.keys(THREAD_RESOURCE_PERMISSIONS)) {
      const current = state.policies.find((policy) => policy.threadId === threadId && policy.resourceType === resourceType);
      const replacement = {
        ...(current || {}),
        threadId,
        resourceType,
        revision: nextPolicyRevision(current?.revision),
        explicitEmpty: true,
        inheritanceMode: "explicit",
        parentSnapshotRevision: Number(current?.parentSnapshotRevision || 0),
        createdAt: current?.createdAt || timestamp,
        updatedAt: timestamp,
      };
      if (current) {
        state.policies = state.policies.map((policy) => policy === current ? replacement : policy);
      } else {
        state.policies.push(replacement);
      }
    }

    state.resourceSessions = state.resourceSessions.map((session) => {
      if ((session.threadId !== threadId && session.grantThreadId !== threadId) || session.state !== "active") return session;
      resourceSessionCount += 1;
      return {
        ...session,
        state: "invalidated",
        epoch: Number(session.epoch || 1) + 1,
        invalidatedAt: timestamp,
        invalidatedBy: actorUserId,
        invalidationReason: "thread_retired",
        updatedAt: timestamp,
      };
    });
    state.mailboxListeners = state.mailboxListeners.map((listener) => {
      if (listener.threadId !== threadId || listener.status !== "active" || listener.revokedAt) return listener;
      mailboxListenerCount += 1;
      return {
        ...listener,
        status: "revoked",
        revokedAt: timestamp,
        revokedBy: actorUserId,
        reason: "thread_retired",
        updatedAt: timestamp,
      };
    });
    state.mailboxDeliveries = state.mailboxDeliveries.map((delivery) => {
      if (delivery.threadId !== threadId || !["pending", "claimed"].includes(delivery.state)) return delivery;
      mailboxDeliveryCount += 1;
      return {
        ...delivery,
        state: "revoked",
        epoch: Number(delivery.epoch || 1) + 1,
        claimToken: null,
        claimExpiresAt: null,
        revokedAt: timestamp,
        reason: "thread_retired",
        updatedAt: timestamp,
      };
    });
    return {
      resourceGrantCount,
      resourceSessionCount,
      mailboxListenerCount,
      mailboxDeliveryCount,
      transactionalAudit: {
        action: "thread_resource_authority_revoked",
        actorUserId,
        threadId,
        reason: "thread_retired",
      },
    };
  }, env);
  return persisted.result || persisted;
}

export async function retireThread(threadId, options = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw retirementError("thread_not_found", 404);
  if (isThreadRetired(thread) && clean(thread.state).toLowerCase() === "retired") {
    return { ok: true, thread, idempotent: true, cancelledMessages: 0, disabledTimers: 0 };
  }

  const timestamp = nowIso();
  const actorUserId = clean(options.actorUserId || "system");
  const reason = retirementReason(options.reason || "retired_by_owner");
  const priorWakePolicy = clean(thread.wakePolicy || "wake-on-message") || "wake-on-message";
  await updateThread(thread.id, {
    state: "retiring",
    wakePolicy: "manual",
    retiringAt: timestamp,
    retiredBy: actorUserId,
    retirementReason: reason,
  }, env);

  let stopped = false;
  try {
    if (threadUsesCodexAppServer(thread)) {
      const result = await stopCodexAppServerThread(thread, env);
      if (activeThreadRuntime(thread) && result.stopped !== true) throw retirementError("thread_retirement_runtime_stop_failed");
      stopped = result.stopped === true;
    } else if (activeThreadRuntime(thread)) {
      await sleepThread(thread.id, { reason: "thread_retired", kill: true }, env);
      stopped = true;
    }
  } catch (error) {
    await appendEvent({
      type: "thread_retirement_failed",
      threadId: thread.id,
      actorUserId,
      reason: error?.code || error?.message || "runtime_stop_failed",
    }, env).catch(() => {});
    throw error;
  }

  const authority = await revokeThreadResourceAuthority(thread.id, timestamp, actorUserId, env);
  const [cancelledMessages, disabledTimers] = await Promise.all([
    cancelPendingThreadMessages(thread.id, env),
    disableThreadTimers(thread.id, env),
  ]);
  const retired = await updateThread(thread.id, {
    lifecycleState: "retired",
    retired: true,
    state: "retired",
    workerStatus: thread.workerStatus ? "retired" : thread.workerStatus,
    wakePolicy: "manual",
    activeRuntimeLeaseId: null,
    retiredAt: timestamp,
    retiringAt: null,
    retiredBy: actorUserId,
    retiredByUserId: actorUserId,
    retiredReason: reason,
    retirementSource: clean(options.retirementSource || options.source || "manual") || "manual",
    retirementReason: reason,
    retirementPreviousWakePolicy: priorWakePolicy,
    desktopAccess: null,
    desktopGrants: [],
    resourceGrants: [],
    binding: retiredBinding(thread.binding, timestamp),
    runtime: {
      ...(thread.runtime || {}),
      state: "retired",
      activeTurnId: null,
      pendingRequest: null,
      endedAt: timestamp,
      reason: "thread_retired",
    },
  }, env);
  await appendEvent({
    type: "thread_retired",
    threadId: retired.id,
    actorUserId,
    reason,
    stopped,
    cancelledMessages,
    disabledTimers,
    resourceGrantCount: authority.resourceGrantCount || 0,
    resourceSessionCount: authority.resourceSessionCount || 0,
    mailboxListenerCount: authority.mailboxListenerCount || 0,
    mailboxDeliveryCount: authority.mailboxDeliveryCount || 0,
  }, env).catch(() => {});
  return {
    ok: true,
    thread: retired,
    idempotent: false,
    stopped,
    cancelledMessages,
    disabledTimers,
    resourceGrantCount: authority.resourceGrantCount || 0,
    resourceSessionCount: authority.resourceSessionCount || 0,
    mailboxListenerCount: authority.mailboxListenerCount || 0,
    mailboxDeliveryCount: authority.mailboxDeliveryCount || 0,
  };
}

export async function restoreRetiredThread(threadId, options = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw retirementError("thread_not_found", 404);
  if (clean(thread.state).toLowerCase() === "retiring") throw retirementError("thread_retirement_incomplete");
  if (!isThreadRetired(thread)) return { ok: true, thread, idempotent: true };
  const actorUserId = clean(options.actorUserId || "system");
  const restored = await updateThread(thread.id, {
    lifecycleState: "active",
    retired: false,
    state: "sleeping",
    workerStatus: thread.workerStatus === "retired" ? "restored" : thread.workerStatus,
    wakePolicy: "manual",
    retiredAt: null,
    retiringAt: null,
    restoredAt: nowIso(),
    restoredBy: actorUserId,
    restoredByUserId: actorUserId,
    runtime: {
      ...(thread.runtime || {}),
      state: "sleeping",
      activeTurnId: null,
      pendingRequest: null,
      reason: "thread_restored_manual_reconfiguration_required",
    },
  }, env);
  await appendEvent({
    type: "thread_restored",
    threadId: restored.id,
    actorUserId,
    reason: "manual_reconfiguration_required",
  }, env).catch(() => {});
  return { ok: true, thread: restored, idempotent: false };
}
