import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { connectorFile, listConnectorScopePaths } from "./connector-storage.js";

// Gmail OAuth callback state validation (ORK-512).
//
// A callback may only complete the authorization that the matching start
// created. The state is claimed (marked consumed) under the state file lock
// before any code exchange, so absent, replaced, replayed, expired, wrong-host
// and wrong-principal callbacks fail before stored credentials are touched.

const DEFAULT_STATE_TTL_MS = 30 * 60 * 1000;

function clean(value) {
  return String(value || "").trim();
}

function stateError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

export function gmailOAuthStateFile(scope) {
  return connectorFile(scope, "oauth", "gmail-state.json");
}

function stateTtlMs(env = process.env) {
  const parsed = Math.floor(Number(env.ORKESTR_GMAIL_OAUTH_STATE_TTL_MS));
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : DEFAULT_STATE_TTL_MS;
}

function redirectHost(savedState = {}) {
  try {
    return new URL(clean(savedState.redirectUri)).host.toLowerCase();
  } catch {
    return "";
  }
}

// A tenant VM receives its callbacks forwarded by the parent, so the request
// host there is the tenant endpoint rather than the public redirect host.
function forwardedTenantState(savedState = {}, env = process.env) {
  const tenantVmId = clean(savedState.tenantVmId);
  return Boolean(tenantVmId) && tenantVmId === clean(env.ORKESTR_TENANT_VM_ID);
}

function claimRejection(savedState, context, nowMs, env) {
  if (clean(savedState.consumedAt)) return "gmail_oauth_state_replayed";
  const createdAt = Date.parse(clean(savedState.createdAt));
  if (!Number.isFinite(createdAt) || createdAt + stateTtlMs(env) <= nowMs) return "gmail_oauth_state_expired";
  const host = clean(context.host).toLowerCase();
  const expectedHost = redirectHost(savedState);
  if (host && expectedHost && host !== expectedHost && !forwardedTenantState(savedState, env)) {
    return "gmail_oauth_state_wrong_host";
  }
  const principalUserId = clean(context.principal?.userId);
  if (principalUserId) {
    const allowed = [clean(savedState.initiatorUserId), clean(savedState.userId)].filter(Boolean);
    if (allowed.length && !allowed.includes(principalUserId)) return "gmail_oauth_state_wrong_principal";
  }
  return "";
}

/**
 * Validates and consumes the saved OAuth state for a callback.
 * `context.host` is the callback request host ("" skips the host check for
 * direct local calls); `context.principal` is the authenticated callback
 * principal or null for an anonymous browser.
 */
export async function claimGmailOAuthState(state = "", context = {}, env = process.env) {
  const requested = clean(state);
  const nowMs = Number(context.nowMs || Date.now());
  if (!requested) {
    await appendEvent({ type: "gmail_oauth_callback_rejected", reason: "gmail_oauth_state_required" }, env).catch(() => {});
    throw stateError("gmail_oauth_state_required");
  }
  for (const scope of await listConnectorScopePaths(env)) {
    const filePath = gmailOAuthStateFile(scope);
    const claimed = await withStorageFileLock(filePath, async () => {
      const savedState = await readJson(filePath, {});
      if (!clean(savedState.state) || savedState.state !== requested) return null;
      const rejection = claimRejection(savedState, context, nowMs, env);
      if (rejection) return { rejection, savedState };
      const consumed = { ...savedState, consumedAt: new Date(nowMs).toISOString() };
      await writeJson(filePath, consumed);
      return { savedState: consumed };
    });
    if (!claimed) continue;
    if (claimed.rejection) {
      await appendEvent({
        type: "gmail_oauth_callback_rejected",
        reason: claimed.rejection,
        userId: clean(claimed.savedState.userId) || undefined,
      }, env).catch(() => {});
      throw stateError(claimed.rejection, claimed.rejection === "gmail_oauth_state_wrong_principal" ? 403 : 400);
    }
    return {
      savedState: claimed.savedState,
      scopeOptions: scope.userId ? { userId: scope.userId } : {},
    };
  }
  // Unknown or replaced by a newer start: the state no longer matches any
  // pending authorization.
  await appendEvent({ type: "gmail_oauth_callback_rejected", reason: "gmail_oauth_state_mismatch" }, env).catch(() => {});
  throw stateError("gmail_oauth_state_mismatch");
}
