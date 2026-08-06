import { listThreads, listThreadsForPrincipal } from "../../core/src/threads.js";
import { isAdminPrincipal, resourceOwnerUserId } from "../../core/src/policy.js";
import { normalizeUserId } from "../../core/src/users.js";
import { assertDesktopAccess, authorizeDesktopAccess, desktopAccessMode } from "../../core/src/desktop-access.js";
import { desktopLeaseStore, normalizeDesktopSlug } from "./desktop-lease-store.js";

export { normalizeDesktopSlug } from "./desktop-lease-store.js";

function nowIso() {
  return new Date().toISOString();
}

function parseLeaseDurationMs(value, fallbackMs) {
  if (value === null || value === undefined || value === "") return fallbackMs;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const text = String(value || "").trim().toLowerCase();
  if (!text || text === "none" || text === "never") return 0;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = match[2] || "ms";
  const factor = { ms: 1, s: 1000, m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 }[unit] || 1;
  return Math.max(0, Math.round(amount * factor));
}

function threadAllowsLeaseSteal(thread) {
  if (!thread) return true;
  if (thread.executor?.killedAt) return true;
  return ["failed", "failed_auth", "broken", "sleeping"].includes(String(thread.state || "").trim());
}

function ownerUserIdForPrincipal(principal = null, env = process.env, fallback = "") {
  if (principal?.userId && !isAdminPrincipal(principal)) return normalizeUserId(principal.userId);
  return normalizeUserId(fallback || principal?.userId || env.ORKESTR_ADMIN_USER_ID || "admin");
}

function filterLeasesForPrincipal(leases = [], principal = null, env = process.env) {
  if (!principal || isAdminPrincipal(principal)) return leases;
  const ownerUserId = ownerUserIdForPrincipal(principal, env);
  return leases.filter((lease) => lease.ownerUserId === ownerUserId);
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === "object" && !Array.isArray(value)) || {};
}

function desktopSlugCandidates(thread = {}) {
  const runtime = firstObject(thread.runtime);
  const binding = firstObject(thread.binding);
  const executor = firstObject(thread.executor);
  const metadata = firstObject(executor.metadata);
  const values = [
    thread.desktopSlug,
    thread.browserSlug,
    thread.managedDesktopSlug,
    thread.manualInterventionDesktopSlug,
    thread.defaultDesktopSlug,
    runtime.desktopSlug,
    runtime.browserSlug,
    binding.desktopSlug,
    binding.browserSlug,
    metadata.desktopSlug,
    metadata.browserSlug,
    metadata.managedDesktopSlug,
    metadata.manualInterventionDesktopSlug,
    metadata.defaultDesktopSlug,
  ];
  return new Set(values.map(normalizeDesktopSlug).filter(Boolean));
}

function desktopThreadSearchText(thread = {}) {
  const binding = firstObject(thread.binding);
  const executor = firstObject(thread.executor);
  const metadata = firstObject(executor.metadata);
  return [
    thread.id,
    thread.name,
    thread.title,
    thread.bindingName,
    thread.workerLabel,
    binding.displayName,
    binding.chatName,
    binding.name,
    metadata.purpose,
    metadata.label,
    metadata.title,
  ].filter(Boolean).join(" ").toLowerCase();
}

function threadMatchesDesktopSlug(thread, slug) {
  const normalized = normalizeDesktopSlug(slug);
  if (!normalized) return false;
  if (desktopSlugCandidates(thread).has(normalized)) return true;
  if (normalized === "desktop") return false;
  return desktopThreadSearchText(thread).includes(normalized);
}

function activityMs(thread = {}) {
  const candidates = [thread.lastActivityAt, thread.threadUpdatedAt, thread.updatedAt, thread.createdAt];
  for (const value of candidates) {
    const parsed = Date.parse(String(value || ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function publicDesktopThread(thread = {}) {
  return {
    id: String(thread.id || "").trim(),
    name: String(thread.name || "").trim(),
    title: String(thread.title || thread.name || thread.id || "").trim(),
    bindingName: String(thread.bindingName || "").trim(),
    ownerUserId: normalizeUserId(thread.ownerUserId || "admin"),
    state: String(thread.state || "").trim(),
    status: String(thread.status || thread.state || "").trim(),
    lastActivityAt: thread.lastActivityAt || thread.threadUpdatedAt || thread.updatedAt || thread.createdAt || null,
    updatedAt: thread.updatedAt || null,
    codexModeLive: thread.codexModeLive || thread.desiredCodexMode || thread.codexMode || null,
  };
}

async function visibleThreadsForDesktopContext(principal = null, env = process.env) {
  if (!principal || isAdminPrincipal(principal)) return listThreads(env).catch(() => []);
  return listThreadsForPrincipal(principal, env).catch(() => []);
}

export async function attachDesktopStateToSessions(sessions = [], env = process.env, options = {}) {
  const scopedSessions = Array.isArray(sessions) ? sessions : [];
  const [leases, threads] = await Promise.all([
    publicDesktopLeases({
      principal: options?.principal,
      threadId: options?.threadId,
      breakGlass: options?.breakGlass === true,
      breakGlassReason: options?.breakGlassReason,
    }, env).catch(() => []),
    visibleThreadsForDesktopContext(options?.principal, env),
  ]);
  const leaseByKey = new Map(leases.map((lease) => [`${lease.desktopSlug}:${lease.ownerUserId || ""}`, lease]));
  return scopedSessions.map((session) => {
    const slug = normalizeDesktopSlug(session?.slug || session?.id);
    const ownerUserId = normalizeUserId(session?.ownerUserId || options?.ownerUserId || env.ORKESTR_ADMIN_USER_ID || "admin");
    const lease = leaseByKey.get(`${slug}:${ownerUserId}`) || null;
    const relatedThreads = threads
      .filter((thread) => resourceOwnerUserId(thread, env) === ownerUserId)
      .filter((thread) => threadMatchesDesktopSlug(thread, slug) || (lease && thread.id === lease.threadId))
      .sort((left, right) => activityMs(right) - activityMs(left))
      .slice(0, 8)
      .map(publicDesktopThread);
    return {
      ...session,
      lease,
      leased: !!lease,
      leaseOwnerThreadId: lease?.threadId || null,
      leaseOwnerLabel: lease?.ownerThreadLabel || null,
      relatedThreads,
      relatedThreadCount: relatedThreads.length,
    };
  });
}

export function publicDesktopLease(lease, threadsById = new Map(), nowMs = Date.now(), env = process.env) {
  if (!lease) return null;
  const thread = threadsById.get(lease.threadId) || null;
  const heartbeatMs = Date.parse(lease.heartbeatAt || "");
  const expiresMs = Date.parse(lease.expiresAt || "");
  const staleAfterMs = Number(env.ORKESTR_DESKTOP_LEASE_STALE_MS || 15 * 60_000);
  const heartbeatAgeMs = Number.isFinite(heartbeatMs) ? Math.max(0, nowMs - heartbeatMs) : null;
  const expired = Number.isFinite(expiresMs) && expiresMs <= nowMs;
  const stale = heartbeatAgeMs != null && heartbeatAgeMs > staleAfterMs;
  const stealable = threadAllowsLeaseSteal(thread) || stale || expired;
  return {
    ...lease,
    active: !lease.releasedAt,
    ownerUserId: lease.ownerUserId || "admin",
    stale,
    expired,
    heartbeatAgeMs,
    stealable,
    ownerThreadExists: !!thread,
    ownerThreadState: thread?.state || null,
    ownerThreadLabel: thread ? String(thread.title || thread.name || thread.id) : lease.threadName || lease.threadId,
    ownerCodexThreadId: thread?.executor?.codexThreadId || lease.codexThreadId || null,
  };
}

export async function publicDesktopLeases({ includeReleased = false, principal = null, threadId = "", breakGlass = false, breakGlassReason = "" } = {}, env = process.env) {
  const store = desktopLeaseStore(env);
  const [leases, threads] = await Promise.all([
    store.readAll({ includeReleased }),
    listThreads(env).catch(() => []),
  ]);
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const nowMs = Date.now();
  const scoped = [];
  for (const lease of filterLeasesForPrincipal(leases, principal, env)) {
    const decision = await authorizeDesktopAccess({
      principal,
      threadId,
      desktopSlug: lease.desktopSlug,
      ownerUserId: lease.ownerUserId,
      permission: "discover",
      breakGlass,
      breakGlassReason,
    }, env);
    if (decision.allowed) scoped.push(publicDesktopLease(lease, threadsById, nowMs, env));
  }
  return scoped;
}

export async function activeDesktopLeaseStatus(desktopSlug, env = process.env, options = {}) {
  const store = desktopLeaseStore(env);
  const ownerUserId = ownerUserIdForPrincipal(options?.principal, env, options?.ownerUserId);
  const [lease, threads] = await Promise.all([
    store.activeLease(desktopSlug, ownerUserId),
    listThreads(env).catch(() => []),
  ]);
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  return publicDesktopLease(lease, threadsById, Date.now(), env);
}

export async function assertDesktopLeaseForOperation(slug, env = process.env, options = {}) {
  if (desktopAccessMode(env) !== "enforce") return null;
  if (options?.breakGlass === true && isAdminPrincipal(options?.principal || {}) && String(options?.breakGlassReason || "").trim()) return null;
  const desktopSlug = normalizeDesktopSlug(slug);
  const threadId = String(options?.threadId || "").trim();
  const fencingToken = String(options?.fencingToken || "").trim();
  if (!threadId) {
    const error = new Error("desktop_thread_scope_required");
    error.statusCode = 403;
    throw error;
  }
  const ownerUserId = ownerUserIdForPrincipal(options?.principal, env, options?.ownerUserId);
  const lease = await desktopLeaseStore(env).activeLease(desktopSlug, ownerUserId);
  if (!lease || lease.threadId !== threadId) {
    const error = new Error(lease ? "desktop_lease_owned_by_other_thread" : "desktop_lease_required");
    error.statusCode = lease ? 409 : 403;
    throw error;
  }
  if (!fencingToken || lease.fencingToken !== fencingToken) {
    const error = new Error(fencingToken ? "lease_fencing_token_invalid" : "lease_fencing_token_required");
    error.statusCode = 409;
    throw error;
  }
  return lease;
}

export async function acquireDesktopLease(slug, payload = {}, env = process.env, options = {}) {
  const desktopSlug = normalizeDesktopSlug(slug);
  if (!desktopSlug) {
    const error = new Error("invalid_desktop_slug");
    error.statusCode = 400;
    throw error;
  }
  const threadId = String(payload.threadId || payload.ownerThreadId || "").trim();
  if (!threadId) {
    const error = new Error("threadId_required");
    error.statusCode = 400;
    throw error;
  }
  const ownerUserId = ownerUserIdForPrincipal(options?.principal, env, payload.ownerUserId || payload.userId);
  if (payload.force === true && options?.principal && !isAdminPrincipal(options.principal)) {
    const error = new Error("desktop_force_acquire_admin_required");
    error.statusCode = 403;
    throw error;
  }
  if (
    payload.force === true &&
    desktopAccessMode(env) === "enforce" &&
    options?.principal &&
    !String(payload.reason || payload.breakGlassReason || "").trim()
  ) {
    const error = new Error("desktop_force_acquire_reason_required");
    error.statusCode = 400;
    throw error;
  }
  await assertDesktopAccess({
    principal: options?.principal,
    threadId,
    desktopSlug,
    ownerUserId,
    permission: "acquire",
    breakGlass: options?.breakGlass === true || payload.breakGlass === true,
    breakGlassReason: options?.breakGlassReason || payload.breakGlassReason,
  }, env);
  const ttlMs = parseLeaseDurationMs(payload.ttlMs ?? payload.ttl ?? payload.expiresIn, Number(env.ORKESTR_DESKTOP_LEASE_TTL_MS || 4 * 60 * 60_000));
  const now = nowIso();
  const expiresAt = ttlMs > 0 ? new Date(Date.parse(now) + ttlMs).toISOString() : null;
  const store = desktopLeaseStore(env);
  const result = await store.acquire(
    {
      desktopSlug,
      ownerUserId,
      threadId,
      codexThreadId: payload.codexThreadId,
      threadName: payload.threadName,
      mode: payload.mode,
      purpose: payload.purpose,
      runId: payload.runId,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
      metadata: payload.metadata,
    },
    { force: payload.force === true, releaseReason: payload.force ? "force_acquired" : "superseded" },
  );
  if (!result.ok) {
    return {
      ok: false,
      error: "desktop_leased",
      lease: publicDesktopLease(result.conflict, new Map(), Date.now(), env),
      message: `Desktop ${desktopSlug} is already leased for ${ownerUserId}.`,
    };
  }
  return {
    ok: true,
    lease: await activeDesktopLeaseStatus(desktopSlug, env, { ownerUserId }),
    renewed: result.renewed === true,
    previousLease: publicDesktopLease(result.previousLease, new Map(), Date.now(), env),
  };
}

export async function heartbeatDesktopLease(slug, threadId, env = process.env, options = {}) {
  const ownerUserId = ownerUserIdForPrincipal(options?.principal, env, options?.ownerUserId);
  await assertDesktopAccess({ principal: options?.principal, threadId, desktopSlug: slug, ownerUserId, permission: "acquire" }, env);
  const fencingToken = String(options?.fencingToken || "").trim();
  if (desktopAccessMode(env) === "enforce" && !fencingToken) {
    return { ok: false, reason: "lease_fencing_token_required", lease: await activeDesktopLeaseStatus(slug, env, { ownerUserId }) };
  }
  const result = await desktopLeaseStore(env).heartbeat(slug, threadId, ownerUserId, fencingToken);
  return { ...result, lease: await activeDesktopLeaseStatus(slug, env, { ownerUserId }) };
}

export async function releaseDesktopLease(slug, options = {}, env = process.env) {
  const ownerUserId = ownerUserIdForPrincipal(options?.principal, env, options?.ownerUserId);
  if (!options?.force) {
    await assertDesktopAccess({ principal: options?.principal, threadId: options?.threadId, desktopSlug: slug, ownerUserId, permission: "acquire" }, env);
  }
  if (desktopAccessMode(env) === "enforce" && !options?.force && !String(options?.fencingToken || "").trim()) {
    return { ok: false, reason: "lease_fencing_token_required", lease: await activeDesktopLeaseStatus(slug, env, { ownerUserId }) };
  }
  const result = await desktopLeaseStore(env).release(slug, { ...options, ownerUserId });
  return { ...result, lease: result.lease ? publicDesktopLease(result.lease, new Map(), Date.now(), env) : await activeDesktopLeaseStatus(slug, env, { ownerUserId }) };
}
