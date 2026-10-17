import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { readManagedDesktopSession } from "../../browsers/src/browserctl.js";
import { activeDesktopLeaseStatus, normalizeDesktopSlug } from "../../browsers/src/desktop-leases.js";
import { exactOrigin, probePasswordField } from "../../browsers/src/password-field-probe.js";
import { savedLoginSince } from "../../browsers/src/chrome-saved-login-probe.js";
import { assertRecentAuth, assertVaultOwner, vaultError } from "./vault-access.js";

// Password-blind Chrome password handoff (docs/password-handoff.md).
//
// The owner, signed in recently, opens a handoff for one exact tab and origin
// on a desktop their agent thread holds. The owner then lets Chrome suggest,
// accept and save a password in the live desktop view. Orkestr never
// generates, types, reads or stores the password. It only reports
// value-free statuses:
//   awaiting_owner  field present, empty
//   accepted        field filled (chromeFilled tells whether Chrome filled it)
//   saved_verified  Chrome's login store has a new login for that origin
//   unknown         the bound tab/origin/field cannot be confirmed (reason)
// A filled field is never proof of saving. While a handoff is open the desktop
// is "password-blind": desktopPasswordBlind() is true for agent-facing
// screenshot/CDP paths to refuse. Signup submission and terms acceptance are
// outside this flow.

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_TTL_MS = 30 * 60_000;

function clean(value) {
  return String(value ?? "").trim();
}

function storePath(env) {
  return path.join(dataPaths(env).home, "password-handoffs.json");
}

async function readHandoffs(env) {
  const value = await readJson(storePath(env), { handoffs: [] });
  return Array.isArray(value?.handoffs) ? value.handoffs : [];
}

async function mutateHandoffs(env, operation) {
  const file = storePath(env);
  return withStorageFileLock(file, async () => {
    const handoffs = await readHandoffs(env);
    const result = await operation(handoffs);
    await writeJson(file, { handoffs: handoffs.slice(-200) });
    return result;
  });
}

function isOpen(record, nowMs = Date.now()) {
  return record && record.state === "open" && Date.parse(record.expiresAt) > nowMs;
}

/** Origins the handoff may bind: https only, or http on loopback (fixtures). */
export function handoffOrigin(value) {
  const origin = exactOrigin(value);
  if (!origin || origin !== clean(value).replace(/\/+$/g, "")) return "";
  const url = new URL(origin);
  if (url.protocol === "https:") return origin;
  if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return origin;
  return "";
}

/** True while an open handoff blinds this desktop for agents. */
export async function desktopPasswordBlind(desktopSlug, env = process.env) {
  const slug = normalizeDesktopSlug(desktopSlug);
  return (await readHandoffs(env)).some((record) => record.desktopSlug === slug && isOpen(record));
}

function publicHandoff(record, status = {}) {
  return {
    id: record.id,
    desktopSlug: record.desktopSlug,
    threadId: record.threadId,
    targetId: record.targetId,
    origin: record.origin,
    state: record.state,
    startedAt: record.startedAt,
    expiresAt: record.expiresAt,
    ...status,
  };
}

async function event(type, record, extra, env) {
  // Value-free by construction: ids, origin, status words only.
  await appendEvent({
    type,
    handoffId: record.id,
    ownerUserId: record.ownerUserId,
    threadId: record.threadId,
    desktopSlug: record.desktopSlug,
    origin: record.origin,
    ...extra,
  }, env).catch(() => {});
}

async function desktopFor(slug, owner, principal, env, deps) {
  const read = deps.readManagedDesktopSession || readManagedDesktopSession;
  const session = await read(slug, env, { principal, ownerUserId: owner }).catch(() => null);
  if (!session) throw vaultError("password_handoff_desktop_not_found", 404);
  const cdpUrl = clean(session.cdp_url || session.cdpUrl);
  if (!cdpUrl) throw vaultError("password_handoff_devtools_unavailable", 409);
  return { cdpUrl, profileDir: clean(session.profileDir || session.profile_path) };
}

/**
 * Owner opens a handoff for one exact tab/origin on a desktop that `threadId`
 * holds. Refuses unless the bound field is an empty password field.
 */
export async function startPasswordHandoff(principal, input = {}, env = process.env, deps = {}) {
  const owner = assertVaultOwner(principal);
  assertRecentAuth(principal, env);
  const desktopSlug = normalizeDesktopSlug(input.desktopSlug);
  const threadId = clean(input.threadId);
  const targetId = clean(input.targetId);
  const origin = handoffOrigin(input.origin);
  const selector = clean(input.selector);
  if (!desktopSlug || !threadId || !targetId) throw vaultError("password_handoff_input_required", 400);
  if (!origin) throw vaultError("password_handoff_origin_invalid", 400);
  const leaseStatus = deps.activeDesktopLeaseStatus || activeDesktopLeaseStatus;
  const lease = await leaseStatus(desktopSlug, env, { ownerUserId: owner });
  if (!lease?.active || lease.expired || lease.stale) throw vaultError("desktop_lease_required", 403);
  if (lease.threadId !== threadId) throw vaultError("desktop_lease_owned_by_other_thread", 409);
  const desktop = await desktopFor(desktopSlug, owner, principal, env, deps);
  const probe = await (deps.probePasswordField || probePasswordField)(desktop.cdpUrl, { targetId, expectedOrigin: origin, selector });
  if (!probe.ok) throw vaultError(`password_handoff_${probe.reason}`, 409);
  if (!probe.field.found || !probe.field.isPassword) throw vaultError("password_handoff_field_not_password", 409);
  if (probe.field.filled) throw vaultError("password_handoff_field_not_empty", 409);
  const ttl = Math.min(MAX_TTL_MS, Math.max(60_000, Number(input.ttlMs) || DEFAULT_TTL_MS));
  const nowMs = Date.now();
  const record = await mutateHandoffs(env, async (handoffs) => {
    if (handoffs.some((item) => item.desktopSlug === desktopSlug && isOpen(item, nowMs))) {
      throw vaultError("password_handoff_already_open", 409);
    }
    const created = {
      id: `pwh_${randomUUID()}`,
      ownerUserId: owner,
      threadId,
      desktopSlug,
      targetId,
      origin,
      selector,
      state: "open",
      startedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + ttl).toISOString(),
    };
    handoffs.push(created);
    return created;
  });
  await event("password_handoff_started", record, {}, env);
  return publicHandoff(record, { status: "awaiting_owner" });
}

async function findOwned(owner, handoffId, env) {
  const record = (await readHandoffs(env)).find((item) => item.id === clean(handoffId));
  if (!record || record.ownerUserId !== owner) throw vaultError("password_handoff_not_found", 404);
  return record;
}

/**
 * Value-free status. The owner or the bound thread may ask. A tab or origin
 * change closes the handoff as aborted.
 */
export async function passwordHandoffStatus(caller = {}, handoffId, env = process.env, deps = {}) {
  const owner = clean(caller.ownerUserId);
  const record = await findOwned(owner, handoffId, env);
  if (caller.threadId && caller.threadId !== record.threadId) throw vaultError("password_handoff_not_found", 404);
  if (record.state !== "open") return publicHandoff(record, { status: record.finalStatus || "unknown", reason: record.reason || record.state });
  if (!isOpen(record)) {
    await closeHandoff(record.id, "expired", { finalStatus: "unknown", reason: "expired" }, env);
    return publicHandoff({ ...record, state: "expired" }, { status: "unknown", reason: "expired" });
  }
  const desktop = await desktopFor(record.desktopSlug, owner, null, env, deps).catch(() => null);
  if (!desktop) return publicHandoff(record, { status: "unknown", reason: "desktop_unavailable" });
  const probe = await (deps.probePasswordField || probePasswordField)(desktop.cdpUrl, { targetId: record.targetId, expectedOrigin: record.origin, selector: record.selector });
  if (!probe.ok) {
    if (["tab_not_found", "origin_mismatch"].includes(probe.reason)) {
      await closeHandoff(record.id, "aborted", { finalStatus: "unknown", reason: probe.reason }, env);
      return publicHandoff({ ...record, state: "aborted" }, { status: "unknown", reason: probe.reason });
    }
    return publicHandoff(record, { status: "unknown", reason: probe.reason });
  }
  if (!probe.field.found || !probe.field.isPassword) return publicHandoff(record, { status: "unknown", reason: "field_not_password" });
  if (!probe.field.filled) return publicHandoff(record, { status: "awaiting_owner" });
  const saved = await (deps.savedLoginSince || savedLoginSince)(desktop.profileDir, record.origin, Date.parse(record.startedAt));
  const status = saved.ok && saved.saved ? "saved_verified" : "accepted";
  return publicHandoff(record, {
    status,
    chromeFilled: probe.field.chromeFilled,
    ...(saved.ok ? {} : { saveCheck: saved.reason }),
  });
}

async function closeHandoff(handoffId, state, extra, env) {
  const record = await mutateHandoffs(env, async (handoffs) => {
    const found = handoffs.find((item) => item.id === handoffId);
    if (!found || found.state !== "open") return null;
    Object.assign(found, { state, closedAt: new Date().toISOString(), ...extra });
    return found;
  });
  if (record) await event(`password_handoff_${state}`, record, { status: extra.finalStatus || "", reason: extra.reason || "" }, env);
  return record;
}

/** The owner ends the handoff; the desktop stops being password-blind. */
export async function endPasswordHandoff(principal, handoffId, input = {}, env = process.env, deps = {}) {
  const owner = assertVaultOwner(principal);
  const record = await findOwned(owner, handoffId, env);
  const last = record.state === "open"
    ? await passwordHandoffStatus({ ownerUserId: owner }, record.id, env, deps).catch(() => ({ status: "unknown" }))
    : { status: record.finalStatus || "unknown" };
  await closeHandoff(record.id, "ended", { finalStatus: last.status, reason: clean(input.reason) || "owner_ended" }, env);
  return publicHandoff({ ...record, state: "ended" }, { status: last.status });
}
