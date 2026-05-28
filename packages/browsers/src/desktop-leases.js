import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { listThreads } from "../../core/src/threads.js";
import { isAdminPrincipal } from "../../core/src/policy.js";
import { normalizeUserId } from "../../core/src/users.js";

const VALID_MODES = new Set(["exclusive", "viewOnly", "sharedRead"]);

function nowIso() {
  return new Date().toISOString();
}

async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export function normalizeDesktopSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function normalizeLease(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const desktopSlug = normalizeDesktopSlug(raw.desktopSlug || raw.slug);
  const threadId = String(raw.threadId || raw.ownerThreadId || "").trim();
  if (!desktopSlug || !threadId) return null;
  const mode = VALID_MODES.has(String(raw.mode || "")) ? String(raw.mode) : "exclusive";
  const acquiredAt = raw.acquiredAt || nowIso();
  const ownerUserId = normalizeUserId(raw.ownerUserId || raw.userId || "admin");
  return {
    id: String(raw.id || `${desktopSlug}:${ownerUserId}:${threadId}:${raw.acquiredAt || randomUUID()}`).trim(),
    desktopSlug,
    ownerUserId,
    threadId,
    codexThreadId: String(raw.codexThreadId || "").trim() || null,
    threadName: String(raw.threadName || "").trim() || null,
    mode,
    purpose: String(raw.purpose || "").trim() || null,
    runId: String(raw.runId || "").trim() || null,
    acquiredAt,
    heartbeatAt: raw.heartbeatAt || acquiredAt,
    expiresAt: raw.expiresAt || null,
    releasedAt: raw.releasedAt || null,
    releaseReason: raw.releaseReason || null,
    updatedAt: raw.updatedAt || raw.heartbeatAt || acquiredAt,
    metadata: raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata) ? raw.metadata : {},
  };
}

function normalizeState(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { desktopLeases: [] };
  return {
    desktopLeases: Array.isArray(parsed.desktopLeases)
      ? parsed.desktopLeases.map(normalizeLease).filter(Boolean)
      : [],
  };
}

export class DesktopLeaseStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async init() {
    await ensureParent(this.filePath);
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const state = normalizeState(JSON.parse(raw));
      await this.writeState(state);
    } catch {
      await this.writeState({ desktopLeases: [] });
    }
  }

  async readStateRaw() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return { desktopLeases: [] };
    }
  }

  async readState() {
    await this.queue.catch(() => {});
    return this.readStateRaw();
  }

  async writeState(state) {
    await ensureParent(this.filePath);
    await fs.writeFile(this.filePath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, { mode: 0o600 });
  }

  async mutateState(mutator) {
    const run = this.queue.then(async () => {
      const state = await this.readStateRaw();
      const result = await mutator(state);
      await this.writeState(state);
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async readAll({ includeReleased = false } = {}) {
    const state = await this.readState();
    return includeReleased ? state.desktopLeases : state.desktopLeases.filter((lease) => !lease.releasedAt);
  }

  async activeLease(desktopSlug, ownerUserId = "") {
    const slug = normalizeDesktopSlug(desktopSlug);
    const owner = ownerUserId ? normalizeUserId(ownerUserId) : "";
    const leases = await this.readAll();
    return leases
      .filter((lease) => lease.desktopSlug === slug && (!owner || lease.ownerUserId === owner))
      .sort((left, right) => Date.parse(right.acquiredAt || "") - Date.parse(left.acquiredAt || ""))[0] || null;
  }

  async acquire(lease, { force = false, releaseReason = "superseded" } = {}) {
    const normalized = normalizeLease(lease);
    if (!normalized) {
      const error = new Error("invalid_desktop_lease");
      error.statusCode = 400;
      throw error;
    }
    return this.mutateState((state) => {
      const active = state.desktopLeases.find((item) =>
        item.desktopSlug === normalized.desktopSlug &&
        item.ownerUserId === normalized.ownerUserId &&
        !item.releasedAt
      ) || null;
      const now = nowIso();
      if (active && active.threadId !== normalized.threadId && !force) {
        return { ok: false, conflict: active, lease: null };
      }
      if (active && active.threadId === normalized.threadId) {
        Object.assign(active, {
          ...active,
          ...normalized,
          id: active.id,
          acquiredAt: active.acquiredAt || normalized.acquiredAt,
          heartbeatAt: now,
          updatedAt: now,
          releasedAt: null,
          releaseReason: null,
        });
        return { ok: true, lease: active, renewed: true, previousLease: null };
      }
      if (active) {
        active.releasedAt = now;
        active.releaseReason = releaseReason;
        active.updatedAt = now;
      }
      state.desktopLeases.unshift({ ...normalized, acquiredAt: normalized.acquiredAt || now, heartbeatAt: normalized.heartbeatAt || now, updatedAt: now });
      return { ok: true, lease: state.desktopLeases[0], renewed: false, previousLease: active || null };
    });
  }

  async heartbeat(desktopSlug, threadId, ownerUserId = "") {
    const slug = normalizeDesktopSlug(desktopSlug);
    const owner = String(threadId || "").trim();
    const ownerUser = ownerUserId ? normalizeUserId(ownerUserId) : "";
    return this.mutateState((state) => {
      const active = state.desktopLeases.find((lease) =>
        lease.desktopSlug === slug &&
        (!ownerUser || lease.ownerUserId === ownerUser) &&
        !lease.releasedAt
      ) || null;
      if (!active) return { ok: false, reason: "lease_not_found", lease: null };
      if (owner && active.threadId !== owner) return { ok: false, reason: "lease_owned_by_other_thread", lease: active };
      const now = nowIso();
      active.heartbeatAt = now;
      active.updatedAt = now;
      return { ok: true, lease: active };
    });
  }

  async release(desktopSlug, { threadId = "", ownerUserId = "", force = false, reason = "released" } = {}) {
    const slug = normalizeDesktopSlug(desktopSlug);
    const owner = String(threadId || "").trim();
    const ownerUser = ownerUserId ? normalizeUserId(ownerUserId) : "";
    return this.mutateState((state) => {
      const active = state.desktopLeases.find((lease) =>
        lease.desktopSlug === slug &&
        (!ownerUser || lease.ownerUserId === ownerUser) &&
        !lease.releasedAt
      ) || null;
      if (!active) return { ok: false, reason: "lease_not_found", lease: null };
      if (owner && active.threadId !== owner && !force) return { ok: false, reason: "lease_owned_by_other_thread", lease: active };
      const now = nowIso();
      active.releasedAt = now;
      active.releaseReason = reason;
      active.updatedAt = now;
      return { ok: true, lease: active };
    });
  }
}

function desktopLeaseStore(env = process.env) {
  return new DesktopLeaseStore(dataPaths(env).desktopLeases);
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

export async function publicDesktopLeases({ includeReleased = false, principal = null } = {}, env = process.env) {
  const store = desktopLeaseStore(env);
  const [leases, threads] = await Promise.all([
    store.readAll({ includeReleased }),
    listThreads(env).catch(() => []),
  ]);
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const nowMs = Date.now();
  return filterLeasesForPrincipal(leases, principal, env).map((lease) => publicDesktopLease(lease, threadsById, nowMs, env));
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
  const result = await desktopLeaseStore(env).heartbeat(slug, threadId, ownerUserId);
  return { ...result, lease: await activeDesktopLeaseStatus(slug, env, { ownerUserId }) };
}

export async function releaseDesktopLease(slug, options = {}, env = process.env) {
  const ownerUserId = ownerUserIdForPrincipal(options?.principal, env, options?.ownerUserId);
  const result = await desktopLeaseStore(env).release(slug, { ...options, ownerUserId });
  return { ...result, lease: result.lease ? publicDesktopLease(result.lease, new Map(), Date.now(), env) : await activeDesktopLeaseStatus(slug, env, { ownerUserId }) };
}
