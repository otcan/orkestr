import { randomUUID } from "node:crypto";
import { normalizeDesktopSlug } from "./desktop-lease-store.js";

const ACTION_OPERATIONS = new Set(["acquire", "connect", "open", "open-url", "prepare", "restart", "share", "start"]);

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function safeLease(lease = null) {
  if (!lease || typeof lease !== "object" || Array.isArray(lease)) return null;
  return {
    id: clean(lease.id),
    desktopSlug: normalizeDesktopSlug(lease.desktopSlug),
    threadId: clean(lease.threadId),
    ownerThreadLabel: clean(lease.ownerThreadLabel || lease.threadName || lease.threadId),
    ownerThreadState: clean(lease.ownerThreadState) || null,
    heartbeatAt: lease.heartbeatAt || null,
    expiresAt: lease.expiresAt || null,
    stale: lease.stale === true,
    expired: lease.expired === true,
    stealable: lease.stealable === true,
    ownerThreadExists: lease.ownerThreadExists !== false,
  };
}

function warning({ attemptId, code, severity = "warning", blocking = false, operation, desktopSlug, threadId, message, recommendedAction, lease, observedAt }) {
  return {
    schemaVersion: 1,
    id: `${attemptId}:${code}:${desktopSlug}`,
    attemptId,
    code,
    severity,
    blocking: blocking === true,
    operation,
    desktopSlug,
    threadId: threadId || null,
    message,
    recommendedAction,
    lease: safeLease(lease),
    observedAt,
  };
}

function leaseIsCurrentForThread(lease, threadId) {
  if (!lease || lease.expired === true || lease.stale === true) return false;
  return !threadId || !clean(lease.threadId) || clean(lease.threadId) === threadId;
}

export function desktopWarningAttemptId(input = {}) {
  return clean(input.attemptId || input.requestId || input.idempotencyKey) || randomUUID();
}

export function desktopAccessWarnings(input = {}) {
  const session = input.session && typeof input.session === "object" ? input.session : {};
  const lease = input.lease && typeof input.lease === "object" ? input.lease : session.lease || null;
  const decision = input.decision && typeof input.decision === "object" ? input.decision : session.desktopAccess || null;
  const operation = lower(input.operation || input.action || "status") || "status";
  const desktopSlug = normalizeDesktopSlug(input.desktopSlug || input.slug || session.slug || session.id || lease?.desktopSlug);
  const threadId = clean(input.threadId || decision?.threadId);
  const attemptId = desktopWarningAttemptId({ attemptId: input.attemptId || `desktop-status:${desktopSlug}:${clean(lease?.id) || "unleased"}` });
  const observedAt = clean(input.observedAt) || new Date().toISOString();
  const errorCode = lower(input.errorCode || input.error);
  const status = lower(session.status || session.state);
  const warnings = [];
  const add = (value) => {
    if (!warnings.some((item) => item.code === value.code)) warnings.push(warning({ ...value, attemptId, operation, desktopSlug, threadId, lease, observedAt }));
  };

  if (lease?.expired === true || errorCode === "desktop_lease_expired") {
    add({
      code: "desktop_lease_expired",
      severity: "error",
      blocking: ACTION_OPERATIONS.has(operation),
      message: `The lease for ${desktopSlug || "this desktop"} has expired. It cannot safely be connected or controlled until it is released or reacquired.`,
      recommendedAction: "Release the expired lease, then reserve the desktop again.",
    });
  }
  if (lease?.stale === true || errorCode === "desktop_lease_heartbeat_stale") {
    add({
      code: "desktop_lease_stale",
      severity: "error",
      blocking: ACTION_OPERATIONS.has(operation),
      message: `The lease heartbeat for ${desktopSlug || "this desktop"} is stale. The previous connection is no longer considered healthy.`,
      recommendedAction: "Release the stale lease, then reserve the desktop again.",
    });
  }
  if ((threadId && clean(lease?.threadId) && clean(lease.threadId) !== threadId) || ["desktop_lease_owned_by_other_thread", "lease_owned_by_other_thread"].includes(errorCode)) {
    add({
      code: "desktop_lease_owned_by_other_thread",
      severity: "error",
      blocking: true,
      message: `${desktopSlug || "This desktop"} is reserved by ${clean(lease?.ownerThreadLabel || lease?.threadId) || "another thread"}.`,
      recommendedAction: lease?.stealable === true ? "Release the stale reservation or explicitly take it over." : "Use the owning thread or wait for its reservation to be released.",
    });
  }
  if (lease && lease.ownerThreadExists === false) {
    add({
      code: "desktop_lease_orphaned",
      severity: "error",
      blocking: ACTION_OPERATIONS.has(operation),
      message: `The lease for ${desktopSlug || "this desktop"} points to a thread that no longer exists.`,
      recommendedAction: "Release the orphaned lease, then reserve the desktop again.",
    });
  }
  if (decision?.mode === "shadow" && decision?.shadowDenied === true && decision?.granted !== true) {
    add({
      code: "desktop_grant_missing",
      message: `${desktopSlug || "This desktop"} is being exposed under shadow authorization without an effective grant for this thread.`,
      recommendedAction: "Add an explicit desktop grant before enabling enforced access.",
    });
  }
  if (clean(session.launchError)) {
    add({
      code: "desktop_launch_failed",
      severity: "error",
      blocking: ACTION_OPERATIONS.has(operation),
      message: `${desktopSlug || "This desktop"} reported a launch failure: ${clean(session.launchError)}`,
      recommendedAction: "Inspect the desktop runtime, then retry after the launch error is resolved.",
    });
  }
  if (["running", "active", "open"].includes(status) && !leaseIsCurrentForThread(lease, threadId)) {
    add({
      code: "desktop_auto_stop_risk",
      message: `${desktopSlug || "This desktop"} is running without a current healthy lease for this thread and may be stopped by automatic lifecycle cleanup.`,
      recommendedAction: "Release any expired or stale lease and reserve the desktop before connecting.",
    });
  }
  if (["desktop_lease_required", "lease_not_found"].includes(errorCode) && !warnings.some((item) => item.code === "desktop_auto_stop_risk")) {
    add({
      code: "desktop_lease_required",
      severity: "error",
      blocking: true,
      message: `${desktopSlug || "This desktop"} does not have a valid lease for this operation.`,
      recommendedAction: "Reserve the desktop for this thread, then try again.",
    });
  }

  return warnings;
}
