import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { normalizeUserId } from "../../core/src/users.js";
import { withDesktopLeaseLock, leaseStoreError } from "./desktop-lease-lock.js";
import { readLeaseState, validateLeaseState, MAX_LEASE_STATE_BYTES } from "./desktop-lease-state.js";
import { validateActionBinding, currentActionLease, synchronousCallback, synchronousResult } from "./desktop-lease-action.js";
import { normalizeLegacyAdoption } from "./desktop-lease-legacy.js";
import { legacyAdoptionFileConfig, readLegacyAdoptionFile } from "./desktop-lease-adoption-file.js";

const VALID_MODES = new Set(["exclusive", "viewOnly", "sharedRead"]);

function nowIso() {
  return new Date().toISOString();
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

export class DesktopLeaseStore {
  #adoption;
  #adoptionFile;
  #adoptionRead;

  constructor(filePath, { lockTimeoutMs = 5000, staleAfterMs = 15 * 60_000,
    legacyAdoption, legacyAdoptionPath, legacyAdoptionSha256 } = {}) {
    this.filePath = filePath;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleAfterMs = Number.isSafeInteger(staleAfterMs) && staleAfterMs > 0 ? staleAfterMs : 15 * 60_000;
    this.queue = Promise.resolve();
    this.#adoptionFile = legacyAdoptionFileConfig(legacyAdoptionPath, legacyAdoptionSha256);
    if (legacyAdoption !== undefined && this.#adoptionFile) throw leaseStoreError("desktop_lease_legacy_adoption_config_invalid");
    this.#adoption = legacyAdoption === undefined ? null : normalizeLegacyAdoption(legacyAdoption);
  }

  #locked(operation) {
    const run = this.queue.then(async () => {
      // Resolve external configuration before taking the local mutation gate.
      // A failed read stays failed for this instance; never fall back to a marker.
      if (this.#adoptionFile) this.#adoptionRead ??= readLegacyAdoptionFile(this.#adoptionFile);
      const adoption = this.#adoptionRead ? await this.#adoptionRead : this.#adoption;
      return withDesktopLeaseLock(this.filePath, this.lockTimeoutMs, (gate) => operation(gate, adoption));
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async init() {
    return this.#locked(async (gate, adoption) => {
      const state = await readLeaseState(gate, adoption);
      // Existing valid evidence is never normalized, renewed or reset by init.
      // First adoption adds only the lock identity; old mkdir writers must be
      // stopped before this source is activated.
      if (!state || state.lockIdentity === undefined) {
        await this.#writeState(state || { fencingCounter: 0, desktopLeases: [] }, gate, adoption);
      } else if (!gate.initialized) {
        await gate.markInitialized();
      }
    });
  }

  async readState() {
    return this.#locked(async (gate, adoption) => await readLeaseState(gate, adoption) || { fencingCounter: 0, desktopLeases: [] });
  }

  async #writeState(state, gate, adoption) {
    await gate.assertCurrent();
    const persisted = { ...state, lockIdentity: gate.identity };
    validateLeaseState(persisted, gate.identity, adoption);
    const serialized = `${JSON.stringify(persisted, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_LEASE_STATE_BYTES) throw leaseStoreError("desktop_lease_state_too_large");
    const temporaryPath = `${gate.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, serialized, { mode: 0o600, flag: "wx" });
      await gate.assertCurrent();
      await fs.rename(temporaryPath, gate.filePath);
      await gate.markInitialized();
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async mutateState(mutator) {
    synchronousCallback(mutator);
    return this.#locked(async (gate, adoption) => {
      const state = await readLeaseState(gate, adoption) || { fencingCounter: 0, desktopLeases: [] };
      const counter = state.fencingCounter;
      const result = synchronousResult(mutator(state));
      if (state.fencingCounter < counter) throw leaseStoreError("desktop_lease_generation_regressed");
      await this.#writeState(state, gate, adoption);
      return result;
    });
  }

  async withCurrentLeaseAction(binding, action) {
    const expected = validateActionBinding(binding);
    synchronousCallback(action);
    return this.#locked(async (gate, adoption) => {
      const state = await readLeaseState(gate, adoption);
      if (!state || state.lockIdentity !== gate.identity || !gate.initialized) {
        throw leaseStoreError("desktop_lease_store_uninitialized");
      }
      await gate.assertCurrent();
      // No await between this current-authority check and the synchronous local
      // callback. No permissive access mode, null principal or break-glass path.
      const lease = currentActionLease(state, expected, this.staleAfterMs);
      return synchronousResult(action(lease));
    });
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

  async acquire(lease, { force = false, releaseReason = "superseded", recoveryCandidate = null } = {}) {
    const normalized = normalizeLease(lease);
    if (!normalized) {
      const error = new Error("invalid_desktop_lease");
      error.statusCode = 400;
      throw error;
    }
    return this.mutateState((state) => {
      const active = state.desktopLeases.find((item) => item.desktopSlug === normalized.desktopSlug && item.ownerUserId === normalized.ownerUserId && !item.releasedAt) || null;
      const now = nowIso();
      const recoveryMatches = active && recoveryCandidate &&
        active.id === String(recoveryCandidate.id || "").trim() &&
        active.threadId === String(recoveryCandidate.threadId || "").trim() &&
        String(active.heartbeatAt || "") === String(recoveryCandidate.heartbeatAt || "") &&
        String(active.expiresAt || "") === String(recoveryCandidate.expiresAt || "");
      if (active && active.threadId !== normalized.threadId && !force && !recoveryMatches) return { ok: false, conflict: active, lease: null };
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
        return { ok: true, lease: active, renewed: true, recovered: false, previousLease: null };
      }
      if (active) Object.assign(active, { releasedAt: now, releaseReason, updatedAt: now });
      if (state.fencingCounter === Number.MAX_SAFE_INTEGER) throw leaseStoreError("desktop_lease_generation_exhausted", 409);
      state.fencingCounter += 1;
      const retiredId = state.legacyRetiredCohort?.retiredIds.includes(normalized.id);
      state.desktopLeases.unshift({
        ...normalized,
        ...(retiredId ? { id: randomUUID(), releasedAt: null, releaseReason: null } : {}),
        acquiredAt: retiredId ? now : normalized.acquiredAt || now,
        heartbeatAt: retiredId ? now : normalized.heartbeatAt || now,
        updatedAt: now,
        fencingToken: randomUUID(),
        fencingVersion: state.fencingCounter,
      });
      return { ok: true, lease: state.desktopLeases[0], renewed: false, recovered: Boolean(active && recoveryMatches), previousLease: active || null };
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
  return new DesktopLeaseStore(dataPaths(env).desktopLeases, {
    staleAfterMs: Number(env.ORKESTR_DESKTOP_LEASE_STALE_MS),
    legacyAdoptionPath: env.ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_PATH,
    legacyAdoptionSha256: env.ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_SHA256,
  });
}
