import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { readManagedDesktopSession } from "../../browsers/src/browserctl.js";
import { activeDesktopLeaseStatus, normalizeDesktopSlug } from "../../browsers/src/desktop-leases.js";
import { exactOrigin, probePasswordField } from "../../browsers/src/password-field-probe.js";
import { savedLoginSince } from "../../browsers/src/chrome-saved-login-probe.js";
import { normalizeUserId } from "./users.js";
import { assertRecentAuth, assertVaultOwner, resolveAgentThread, vaultError } from "./vault-access.js";

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
// is "password-blind": every non-owner desktop path refuses via
// assertDesktopNotPasswordBlind(). Only the owner's explicit end unblinds it;
// expiry, a closed tab or an origin change only change the reported status,
// because the password may still be on screen. Signup submission and terms
// acceptance are outside this flow.

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

const END_REASONS = new Set(["owner_ended", "owner_cancelled", "signup_abandoned"]);
// Value-free selectors only: an element id, or an input attribute match.
const SELECTOR_PATTERN = /^(?:#[A-Za-z][\w-]{0,63}|input\[(?:name|id|autocomplete)~?=(?:'[\w-]{1,64}'|"[\w-]{1,64}"|[\w-]{1,64})\])$/;

function isOpen(record) {
  return Boolean(record) && record.state === "open";
}

function isExpired(record, nowMs = Date.now()) {
  return !(Date.parse(record.expiresAt) > nowMs);
}

function blindError() {
  return Object.assign(new Error("desktop_password_blind"), { statusCode: 423 });
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

/** True while an open handoff blinds this desktop (until the owner ends it). */
export async function desktopPasswordBlind(desktopSlug, env = process.env) {
  const slug = normalizeDesktopSlug(desktopSlug);
  return (await readHandoffs(env)).some((record) => record.desktopSlug === slug && isOpen(record));
}

/**
 * Refuses (423 desktop_password_blind) unless no handoff is open on the desktop
 * or `ownerPrincipal` is the handoff owner's own vault-owner browser session.
 * Agents, machine credentials and desktop shares pass `null` or a non-owner.
 */
export async function assertDesktopNotPasswordBlind(desktopSlug, ownerPrincipal = null, env = process.env) {
  const slug = normalizeDesktopSlug(desktopSlug);
  const record = (await readHandoffs(env)).find((item) => item.desktopSlug === slug && isOpen(item));
  if (!record) return;
  if (ownerPrincipal?.vaultOwner && ownerPrincipal.kind !== "system" && normalizeUserId(ownerPrincipal.userId) === record.ownerUserId) return;
  throw blindError();
}

const blindListeners = new Set();

/** In-process notice when a desktop turns blind, so live viewers can be cut. */
export function onDesktopPasswordBlind(listener) {
  blindListeners.add(listener);
  return () => blindListeners.delete(listener);
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
  if (selector && !SELECTOR_PATTERN.test(selector)) throw vaultError("password_handoff_selector_invalid", 400);
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
    if (handoffs.some((item) => item.desktopSlug === desktopSlug && isOpen(item))) {
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
  for (const listener of blindListeners) {
    try { listener({ desktopSlug, ownerUserId: owner }); } catch { /* listener errors never block the handoff */ }
  }
  return publicHandoff(record, { status: "awaiting_owner" });
}

async function findOwned(owner, handoffId, env) {
  const record = (await readHandoffs(env)).find((item) => item.id === clean(handoffId));
  if (!record || record.ownerUserId !== owner) throw vaultError("password_handoff_not_found", 404);
  return record;
}

// Probes the bound tab and login store. Never closes the handoff: a lost tab,
// origin change or expiry is reported, and the desktop stays blind.
async function probeStatus(record, env, deps) {
  if (record.state !== "open") return publicHandoff(record, { status: record.finalStatus || "unknown", reason: record.reason || record.state });
  const expired = isExpired(record) ? { expired: true } : {};
  const desktop = await desktopFor(record.desktopSlug, record.ownerUserId, null, env, deps).catch(() => null);
  if (!desktop) return publicHandoff(record, { status: "unknown", reason: "desktop_unavailable", ...expired });
  const probe = await (deps.probePasswordField || probePasswordField)(desktop.cdpUrl, { targetId: record.targetId, expectedOrigin: record.origin, selector: record.selector });
  if (!probe.ok) return publicHandoff(record, { status: "unknown", reason: probe.reason, ...expired });
  if (!probe.field.found || !probe.field.isPassword) return publicHandoff(record, { status: "unknown", reason: "field_not_password", ...expired });
  if (!probe.field.filled) return publicHandoff(record, { status: "awaiting_owner", ...expired });
  const saved = await (deps.savedLoginSince || savedLoginSince)(desktop.profileDir, record.origin, Date.parse(record.startedAt));
  return publicHandoff(record, {
    status: saved.ok && saved.saved ? "saved_verified" : "accepted",
    chromeFilled: probe.field.chromeFilled,
    ...(saved.ok ? {} : { saveCheck: saved.reason }),
    ...expired,
  });
}

/** Value-free status for the handoff owner's own vault-owner session. */
export async function ownerPasswordHandoffStatus(principal, handoffId, env = process.env, deps = {}) {
  const owner = assertVaultOwner(principal);
  return probeStatus(await findOwned(owner, handoffId, env), env, deps);
}

/** Value-free status for the agent thread the handoff is bound to. */
export async function agentPasswordHandoffStatus(threadRef, handoffId, env = process.env, deps = {}) {
  const thread = await (deps.resolveAgentThread || resolveAgentThread)(threadRef, env);
  const record = await findOwned(normalizeUserId(thread.ownerUserId), handoffId, env);
  if (record.threadId !== thread.threadId) throw vaultError("password_handoff_not_found", 404);
  return probeStatus(record, env, deps);
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

/** The owner ends the handoff; only this unblinds the desktop. */
export async function endPasswordHandoff(principal, handoffId, input = {}, env = process.env, deps = {}) {
  const owner = assertVaultOwner(principal);
  const reason = clean(input.reason) || "owner_ended";
  if (!END_REASONS.has(reason)) throw vaultError("password_handoff_reason_invalid", 400);
  const record = await findOwned(owner, handoffId, env);
  const last = record.state === "open"
    ? await probeStatus(record, env, deps).catch(() => ({ status: "unknown" }))
    : { status: record.finalStatus || "unknown" };
  await closeHandoff(record.id, "ended", { finalStatus: last.status, reason }, env);
  return publicHandoff({ ...record, state: "ended" }, { status: last.status });
}

/** The owner's open handoffs, optionally for one desktop (no probing). */
export async function listOwnerPasswordHandoffs(principal, { desktopSlug = "" } = {}, env = process.env) {
  const owner = assertVaultOwner(principal);
  const slug = desktopSlug ? normalizeDesktopSlug(desktopSlug) : "";
  return (await readHandoffs(env))
    .filter((record) => record.ownerUserId === owner && isOpen(record) && (!slug || record.desktopSlug === slug))
    .map((record) => publicHandoff(record, isExpired(record) ? { expired: true } : {}));
}

/**
 * What the owner picks from when starting a handoff: the thread holding the
 * desktop lease and the desktop's page tabs as `{ targetId, origin }`. Only
 * origins a handoff may bind are listed; paths, titles and queries never are.
 */
export async function ownerPasswordHandoffTargets(principal, desktopSlug, env = process.env, deps = {}) {
  const owner = assertVaultOwner(principal);
  const slug = normalizeDesktopSlug(desktopSlug);
  if (!slug) throw vaultError("password_handoff_input_required", 400);
  const lease = await (deps.activeDesktopLeaseStatus || activeDesktopLeaseStatus)(slug, env, { ownerUserId: owner });
  const threadId = lease?.active && !lease.expired && !lease.stale ? clean(lease.threadId) : "";
  const desktop = await desktopFor(slug, owner, principal, env, deps);
  let pages = [];
  try {
    const response = await (deps.fetch || fetch)(`${desktop.cdpUrl.replace(/\/+$/g, "")}/json/list`, { signal: AbortSignal.timeout(5_000) });
    pages = response.ok ? await response.json() : [];
  } catch {
    throw vaultError("password_handoff_devtools_unavailable", 409);
  }
  const tabs = (Array.isArray(pages) ? pages : [])
    .filter((page) => clean(page?.type) === "page" && clean(page?.id))
    .map((page) => ({ targetId: clean(page.id), origin: handoffOrigin(exactOrigin(page.url)) }))
    .filter((tab) => tab.origin);
  return { desktopSlug: slug, threadId, tabs };
}
