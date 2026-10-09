import { appendEvent } from "../../storage/src/store.js";
import { readManagedDesktopSession } from "../../browsers/src/browserctl.js";
import { desktopDisplay, typeIntoDesktop } from "../../browsers/src/desktop-keystrokes.js";
import { activeDesktopLeaseStatus, normalizeDesktopSlug } from "../../browsers/src/desktop-leases.js";
import { getUser } from "./users.js";
import {
  assertRecentAuth,
  assertVaultOwner,
  consumeVaultRateLimit,
  itemGrantedToThread,
  resolveAgentThread,
  vaultError,
} from "./vault-access.js";
import { findGrantedItem } from "./vault-agent.js";
import { claimItemUse } from "./vault-item-use.js";
import { findItem, mutateVault, openRecord, readVault } from "./vault-store.js";

// Fills a vault credential into the focused field of a managed desktop
// (docs/vault.md, "Filling into a desktop"). The value goes from the vault
// straight to the keystroke process's stdin; callers only get
// `{ status: "filled" | "failed" }`. Agents must hold the desktop lease.

const FILL_FIELDS = new Set(["username", "password", "both"]);

function clean(value) {
  return String(value ?? "").trim();
}

export function fillOptions(input = {}) {
  const desktopSlug = normalizeDesktopSlug(input?.desktop);
  if (!desktopSlug) throw vaultError("vault_fill_desktop_required", 400);
  const field = clean(input?.field) || "password";
  if (!FILL_FIELDS.has(field)) throw vaultError("vault_field_invalid", 400, { field: "field" });
  return { desktopSlug, field, submit: input?.submit === true };
}

/** Keystroke steps for a field choice: "both" types username, Tab, password. */
export function fillSteps(payload = {}, field = "password", submit = false) {
  const username = String(payload.username || "");
  const password = String(payload.password || "");
  const steps = field === "username" ? [username] : field === "password" ? [password] : [username, password];
  if (steps.some((text) => !text)) throw vaultError("vault_fill_field_empty", 409);
  const keys = steps.flatMap((text, index) => (index ? [{ key: "Tab" }, { text }] : [{ text }]));
  return submit ? [...keys, { key: "Return" }] : keys;
}

// Keystrokes go to a local X display, so remote browser providers (whose
// displays live on another host) are not supported.
async function ownerDesktopDisplay(ownerUserId, desktopSlug, env, principal = null) {
  if (clean(env.ORKESTR_BROWSER_API_URL) || clean(env.ORKESTR_BROWSER_SESSIONS_URL)) throw vaultError("vault_fill_desktop_unsupported", 409);
  const user = principal ? null : await getUser(ownerUserId, env).catch(() => null);
  const scopePrincipal = principal || { userId: ownerUserId, role: user?.role || "user" };
  const session = await readManagedDesktopSession(desktopSlug, env, { principal: scopePrincipal, ownerUserId }).catch(() => null);
  const display = desktopDisplay(session);
  if (!display) throw vaultError(session ? "vault_fill_desktop_unsupported" : "vault_fill_desktop_not_found", session ? 409 : 404);
  return display;
}

/** The agent's thread must hold a live lease on the desktop. */
export async function assertThreadHoldsDesktop(desktopSlug, ownerUserId, threadId, env = process.env) {
  const lease = await activeDesktopLeaseStatus(desktopSlug, env, { ownerUserId });
  if (!lease?.active) throw vaultError("desktop_lease_required", 403);
  if (lease.threadId !== threadId) throw vaultError("desktop_lease_owned_by_other_thread", 409);
  if (lease.expired || lease.stale) throw vaultError("desktop_lease_expired", 403);
}

async function fillFromVault({ owner, itemId, threadId = "", display, desktopSlug, field, submit, principalKind }, env) {
  const steps = await mutateVault(owner, async (store) => {
    const record = findItem(store, itemId);
    if (threadId && !itemGrantedToThread(record, threadId)) throw vaultError("vault_item_not_found", 404);
    const prepared = fillSteps(await openRecord(owner, record, env), field, submit);
    claimItemUse(record, "desktop_fill");
    return prepared;
  }, env);
  const ok = await typeIntoDesktop(display, steps, env);
  steps.length = 0;
  await appendEvent({
    type: "vault_fill",
    ownerUserId: owner,
    itemId,
    ...(threadId ? { threadId } : {}),
    desktopSlug,
    field,
    submit,
    outcome: ok ? "filled" : "failed",
    principalKind,
  }, env).catch(() => {});
  return { status: ok ? "filled" : "failed" };
}

export async function agentFillDesktop(threadRef, itemRef, input = {}, env = process.env) {
  const options = fillOptions(input);
  const thread = await resolveAgentThread(threadRef, env);
  const owner = thread.ownerUserId;
  const item = findGrantedItem(await readVault(owner, env), itemRef, thread.threadId);
  await assertThreadHoldsDesktop(options.desktopSlug, owner, thread.threadId, env);
  const display = await ownerDesktopDisplay(owner, options.desktopSlug, env);
  await consumeVaultRateLimit("agentRead", `${owner}:${item.id}:${thread.threadId}`, env);
  return fillFromVault({ owner, itemId: item.id, threadId: thread.threadId, display, ...options, principalKind: "agent" }, env);
}

/** Owner-triggered fill from the WebUI. Recent sign-in required, like reveal. */
export async function ownerFillDesktop(principal, itemId, input = {}, env = process.env) {
  const owner = assertVaultOwner(principal);
  assertRecentAuth(principal, env);
  const options = fillOptions(input);
  findItem(await readVault(owner, env), itemId);
  const display = await ownerDesktopDisplay(owner, options.desktopSlug, env, principal);
  await consumeVaultRateLimit("ownerReveal", owner, env);
  return fillFromVault({ owner, itemId: clean(itemId), display, ...options, principalKind: "owner" }, env);
}
