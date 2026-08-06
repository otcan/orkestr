import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { normalizeUserId } from "../../core/src/users.js";

const VALID_MODES = new Set(["exclusive", "viewOnly", "sharedRead"]);

function nowIso() {
  return new Date().toISOString();
}

async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireFileLock(filePath, { timeoutMs = 5_000, staleMs = 30_000 } = {}) {
  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();
  await ensureParent(filePath);
  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, acquiredAt: nowIso() })}\n`, { mode: 0o600 });
      return async () => fs.rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
        const moved = await fs.rename(lockPath, stalePath).then(() => true, () => false);
        if (moved) await fs.rm(stalePath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const lockError = new Error("desktop_lease_store_locked");
        lockError.statusCode = 503;
        throw lockError;
      }
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }
}

export function normalizeDesktopSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
    fencingToken: String(raw.fencingToken || "").trim() || randomUUID(),
    fencingVersion: Math.max(1, Number(raw.fencingVersion || 1) || 1),
  };
}

function normalizeState(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { fencingCounter: 0, desktopLeases: [] };
  return {
    fencingCounter: Math.max(0, Number(parsed.fencingCounter || 0) || 0),
    desktopLeases: Array.isArray(parsed.desktopLeases) ? parsed.desktopLeases.map(normalizeLease).filter(Boolean) : [],
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
      await this.writeState(normalizeState(JSON.parse(raw)));
    } catch {
      await this.writeState({ fencingCounter: 0, desktopLeases: [] });
    }
  }

  async readStateRaw() {
    try {
      return normalizeState(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return { fencingCounter: 0, desktopLeases: [] };
    }
  }

  async readState() {
    await this.queue.catch(() => {});
    return this.readStateRaw();
  }

  async writeState(state) {
    await ensureParent(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporaryPath, this.filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async mutateState(mutator) {
    const run = this.queue.then(async () => {
      const releaseLock = await acquireFileLock(this.filePath);
      try {
        const state = await this.readStateRaw();
        const result = await mutator(state);
        await this.writeState(state);
        return result;
      } finally {
        await releaseLock();
      }
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
      const active = state.desktopLeases.find((item) => item.desktopSlug === normalized.desktopSlug && item.ownerUserId === normalized.ownerUserId && !item.releasedAt) || null;
      const now = nowIso();
      if (active && active.threadId !== normalized.threadId && !force) return { ok: false, conflict: active, lease: null };
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
          fencingToken: active.fencingToken,
          fencingVersion: active.fencingVersion,
        });
        return { ok: true, lease: active, renewed: true, previousLease: null };
      }
      if (active) Object.assign(active, { releasedAt: now, releaseReason, updatedAt: now });
      state.fencingCounter = Math.max(0, Number(state.fencingCounter || 0) || 0) + 1;
      state.desktopLeases.unshift({
        ...normalized,
        acquiredAt: normalized.acquiredAt || now,
        heartbeatAt: normalized.heartbeatAt || now,
        updatedAt: now,
        fencingToken: randomUUID(),
        fencingVersion: state.fencingCounter,
      });
      return { ok: true, lease: state.desktopLeases[0], renewed: false, previousLease: active || null };
    });
  }

  async heartbeat(desktopSlug, threadId, ownerUserId = "", fencingToken = "") {
    const slug = normalizeDesktopSlug(desktopSlug);
    const owner = String(threadId || "").trim();
    const ownerUser = ownerUserId ? normalizeUserId(ownerUserId) : "";
    return this.mutateState((state) => {
      const active = state.desktopLeases.find((lease) => lease.desktopSlug === slug && (!ownerUser || lease.ownerUserId === ownerUser) && !lease.releasedAt) || null;
      if (!active) return { ok: false, reason: "lease_not_found", lease: null };
      if (owner && active.threadId !== owner) return { ok: false, reason: "lease_owned_by_other_thread", lease: active };
      if (fencingToken && active.fencingToken !== String(fencingToken).trim()) return { ok: false, reason: "lease_fencing_token_invalid", lease: active };
      Object.assign(active, { heartbeatAt: nowIso(), updatedAt: nowIso() });
      return { ok: true, lease: active };
    });
  }

  async release(desktopSlug, { threadId = "", ownerUserId = "", fencingToken = "", force = false, reason = "released" } = {}) {
    const slug = normalizeDesktopSlug(desktopSlug);
    const owner = String(threadId || "").trim();
    const ownerUser = ownerUserId ? normalizeUserId(ownerUserId) : "";
    return this.mutateState((state) => {
      const active = state.desktopLeases.find((lease) => lease.desktopSlug === slug && (!ownerUser || lease.ownerUserId === ownerUser) && !lease.releasedAt) || null;
      if (!active) return { ok: false, reason: "lease_not_found", lease: null };
      if (owner && active.threadId !== owner && !force) return { ok: false, reason: "lease_owned_by_other_thread", lease: active };
      if (fencingToken && active.fencingToken !== String(fencingToken).trim() && !force) return { ok: false, reason: "lease_fencing_token_invalid", lease: active };
      const now = nowIso();
      Object.assign(active, { releasedAt: now, releaseReason: reason, updatedAt: now });
      return { ok: true, lease: active };
    });
  }
}

export function desktopLeaseStore(env = process.env) {
  return new DesktopLeaseStore(dataPaths(env).desktopLeases);
}
