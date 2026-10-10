import { appendEvent } from "../../storage/src/store.js";
import { readManagedDesktopSession } from "../../browsers/src/browserctl.js";
import { focusRefusal, probeFocusedField } from "../../browsers/src/desktop-focus-probe.js";
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
import { claimItemUse, finishItemUse } from "./vault-item-use.js";
import { findItem, mutateVault, openRecord, readVault } from "./vault-store.js";

// Fills a vault credential into the focused field of a managed desktop
// (docs/vault-fill.md). The value goes from the vault straight to the
// keystroke process's stdin; callers only get `{ status: "filled" | "failed",
// reason? }`. Agents must hold the desktop lease. Before each value is typed,
// the focused element is checked read-only through DevTools
// (desktop-focus-probe); a wrong or unverifiable focus types nothing.

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

/**
 * Keystroke segments for a field choice. Each segment starts with a focus
 * expectation; "both" types username, Tab, then re-checks for a password field.
 */
export function fillPlan(payload = {}, field = "password", submit = false) {
  const username = String(payload.username || "");
  const password = String(payload.password || "");
  if ((field !== "password" && !username) || (field !== "username" && !password)) throw vaultError("vault_fill_field_empty", 409);
  const plan = field === "username" ? [{ expect: "username", steps: [{ text: username }] }]
    : field === "password" ? [{ expect: "password", steps: [{ text: password }] }]
    : [{ expect: "login-username", steps: [{ text: username }, { key: "Tab" }] }, { expect: "password", steps: [{ text: password }] }];
  if (submit) plan[plan.length - 1].steps.push({ key: "Return" });
  return plan;
}

// "" when typing may go ahead, else a refusal reason. An unverifiable focus
// is only accepted with the owner's explicit override.
async function focusCheck(cdpUrl, expect, allowUnverified) {
  const probe = cdpUrl ? await probeFocusedField(cdpUrl) : { verified: false };
  if (!probe.verified) return allowUnverified ? "" : "focus_unverifiable";
  return focusRefusal(probe.field, expect);
}

// Keystrokes go to a local X display, so remote browser providers (whose
// displays live on another host) are not supported.
async function ownerDesktop(ownerUserId, desktopSlug, env, principal = null) {
  if (clean(env.ORKESTR_BROWSER_API_URL) || clean(env.ORKESTR_BROWSER_SESSIONS_URL)) throw vaultError("vault_fill_desktop_unsupported", 409);
  const user = principal ? null : await getUser(ownerUserId, env).catch(() => null);
  const scopePrincipal = principal || { userId: ownerUserId, role: user?.role || "user" };
  const session = await readManagedDesktopSession(desktopSlug, env, { principal: scopePrincipal, ownerUserId }).catch(() => null);
  const display = desktopDisplay(session);
  if (!display) throw vaultError(session ? "vault_fill_desktop_unsupported" : "vault_fill_desktop_not_found", session ? 409 : 404);
  return { display, cdpUrl: clean(session?.cdp_url) };
}

/** The agent's thread must hold a live lease on the desktop. */
export async function assertThreadHoldsDesktop(desktopSlug, ownerUserId, threadId, env = process.env) {
  const lease = await activeDesktopLeaseStatus(desktopSlug, env, { ownerUserId });
  if (!lease?.active) throw vaultError("desktop_lease_required", 403);
  if (lease.threadId !== threadId) throw vaultError("desktop_lease_owned_by_other_thread", 409);
  if (lease.expired || lease.stale) throw vaultError("desktop_lease_expired", 403);
}

async function runPlan(plan, { display, cdpUrl, allowUnverifiedFocus }, env) {
  for (const segment of plan) {
    const reason = await focusCheck(cdpUrl, segment.expect, allowUnverifiedFocus);
    if (reason) return reason;
    if (!await typeIntoDesktop(display, segment.steps, env)) return "typing_failed";
  }
  return "";
}

async function fillFromVault({ owner, itemId, threadId = "", desktop, allowUnverifiedFocus = false, desktopSlug, field, submit, principalKind }, env) {
  // Refuse before the vault is opened (and a single-use item is reserved).
  const firstExpect = field === "both" ? "login-username" : field;
  let reason = await focusCheck(desktop.cdpUrl, firstExpect, allowUnverifiedFocus);
  if (!reason) {
    const { plan, claim } = await mutateVault(owner, async (store) => {
      const record = findItem(store, itemId);
      if (threadId && !itemGrantedToThread(record, threadId)) throw vaultError("vault_item_not_found", 404);
      const prepared = fillPlan(await openRecord(owner, record, env), field, submit);
      return { plan: prepared, claim: claimItemUse(owner, record) };
    }, env);
    try {
      reason = await runPlan(plan, { ...desktop, allowUnverifiedFocus }, env);
    } finally {
      plan.length = 0;
      // Single-use: only a completed fill is the release; a refusal consumes nothing.
      await finishItemUse(claim, !reason, { usedVia: "desktop_fill", ...(threadId ? { usedByThreadId: threadId } : {}) }, env);
    }
  }
  const ok = !reason;
  await appendEvent({
    type: "vault_fill",
    ownerUserId: owner,
    itemId,
    ...(threadId ? { threadId } : {}),
    desktopSlug,
    field,
    submit,
    outcome: ok ? "filled" : "failed",
    ...(reason ? { reason } : {}),
    ...(allowUnverifiedFocus ? { focusOverride: true } : {}),
    principalKind,
  }, env).catch(() => {});
  return ok ? { status: "filled" } : { status: "failed", reason };
}

export async function agentFillDesktop(threadRef, itemRef, input = {}, env = process.env) {
  const options = fillOptions(input);
  const thread = await resolveAgentThread(threadRef, env);
  const owner = thread.ownerUserId;
  const item = findGrantedItem(await readVault(owner, env), itemRef, thread.threadId);
  await assertThreadHoldsDesktop(options.desktopSlug, owner, thread.threadId, env);
  const desktop = await ownerDesktop(owner, options.desktopSlug, env);
  await consumeVaultRateLimit("agentRead", `${owner}:${item.id}:${thread.threadId}`, env);
  return fillFromVault({ owner, itemId: item.id, threadId: thread.threadId, desktop, ...options, principalKind: "agent" }, env);
}

/**
 * Owner-triggered fill from the WebUI. Recent sign-in required, like reveal.
 * `allowUnverifiedFocus: true` (owner only) types even when DevTools cannot
 * report the focused element; a focus known to be wrong is still refused.
 */
export async function ownerFillDesktop(principal, itemId, input = {}, env = process.env) {
  const owner = assertVaultOwner(principal);
  assertRecentAuth(principal, env);
  const options = fillOptions(input);
  findItem(await readVault(owner, env), itemId);
  const desktop = await ownerDesktop(owner, options.desktopSlug, env, principal);
  await consumeVaultRateLimit("ownerReveal", owner, env);
  const allowUnverifiedFocus = input?.allowUnverifiedFocus === true;
  return fillFromVault({ owner, itemId: clean(itemId), desktop, allowUnverifiedFocus, ...options, principalKind: "owner" }, env);
}
