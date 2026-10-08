import { consumeDurableRateLimit, positiveIntegerEnv } from "./durable-rate-limit.js";
import { resourceOwnerUserId } from "./policy.js";
import { getThread } from "./threads.js";
import { normalizeUserId } from "./users.js";

// Access rules for the vault.
//
// Owner: a real, unscoped browser session principal (no anonymous fallback,
// machine credential, shared-app or auth-intent session). The owner only ever
// sees their own vault; there is no user id parameter, so admins cannot read
// other users' vault contents.
//
// Agent: the CLI machine credential acting for a thread. The thread id comes
// from the CLI (ORKESTR_THREAD_ID or whereiam cwd resolution) and only selects
// which grants apply; the vault owner is always the thread's owner.

const HOUR_MS = 60 * 60 * 1000;
const RECENT_AUTH_MAX_MS = 15 * 60 * 1000;

function clean(value) {
  return String(value ?? "").trim();
}

export function vaultError(code, statusCode = 400, extra = {}) {
  return Object.assign(new Error(code), { statusCode, code, ...extra });
}

/** Returns the owner principal for a browser session request, or null. */
export function vaultOwnerFromRequest(request = {}) {
  if (!request || request.orkestrAnonymous === true || request.orkestrMachineAuth) return null;
  const session = request.orkestrSecuritySession;
  if (!session?.id || session.shareId || session.authIntent) return null;
  if (Array.isArray(session.allowedActions) && session.allowedActions.length) return null;
  const principal = request.orkestrPrincipal;
  if (!principal?.userId || principal.kind === "system") return null;
  return { ...principal, vaultOwner: true };
}

/** True when the request carries the local CLI machine credential. */
export function vaultAgentRequest(request = {}) {
  return Boolean(request && request.orkestrAnonymous !== true && request.orkestrMachineAuth === "cli");
}

export function assertVaultOwner(principal) {
  if (!principal?.vaultOwner || !clean(principal.userId) || principal.kind === "system") {
    throw vaultError("vault_owner_session_required", 401);
  }
  return normalizeUserId(principal.userId);
}

function recentAuthWindowMs(env = process.env) {
  return Math.max(1_000, Math.min(RECENT_AUTH_MAX_MS, positiveIntegerEnv(env.ORKESTR_VAULT_RECENT_AUTH_MS, RECENT_AUTH_MAX_MS, 1_000)));
}

/** Throws 401 vault_reauth_required unless the principal signed in recently. */
export function assertRecentAuth(principal = {}, env = process.env, nowMs = Date.now()) {
  const at = Date.parse(clean(principal?.recentAuthAt || principal?.authenticatedAt));
  const recent = Number.isFinite(at) && at >= nowMs - recentAuthWindowMs(env) && at <= nowMs + 60_000;
  if (!recent) throw vaultError("vault_reauth_required", 401);
}

const limits = {
  agentRead: { bucket: "vault-agent-reads", env: "ORKESTR_VAULT_AGENT_READ_LIMIT", fallback: 30 },
  agentTotp: { bucket: "vault-agent-totp", env: "ORKESTR_VAULT_AGENT_TOTP_LIMIT", fallback: 20 },
  ownerReveal: { bucket: "vault-owner-reveals", env: "ORKESTR_VAULT_OWNER_REVEAL_LIMIT", fallback: 120 },
  ownerTotp: { bucket: "vault-owner-totp", env: "ORKESTR_VAULT_OWNER_TOTP_LIMIT", fallback: 600 },
};

/** Consumes one hit of the named vault rate limit or throws 429. */
export async function consumeVaultRateLimit(kind, key, env = process.env) {
  const config = limits[kind];
  if (!config) throw vaultError("vault_rate_limit_unknown", 500);
  const result = await consumeDurableRateLimit({
    bucket: config.bucket,
    key: `${kind}:${key}`,
    limit: positiveIntegerEnv(env[config.env], config.fallback),
    windowMs: HOUR_MS,
  }, env);
  if (!result.ok) throw vaultError("vault_rate_limited", 429, { retryAfterMs: result.retryAfterMs });
  return result;
}

/**
 * Resolves the agent's thread. Returns `{ threadId, threadName, ownerUserId }`.
 * @param {string} threadRef thread id supplied by the CLI
 */
export async function resolveAgentThread(threadRef = "", env = process.env) {
  const id = clean(threadRef);
  if (!id || id.length > 200) throw vaultError("vault_agent_thread_required", 400);
  const thread = await getThread(id, env).catch(() => null);
  if (!thread?.id || thread.id !== id) throw vaultError("vault_agent_thread_unknown", 403);
  return { threadId: thread.id, threadName: clean(thread.name) || thread.id, ownerUserId: resourceOwnerUserId(thread, env) };
}

/** Thread ids that may be granted: the owner's own threads only. */
export async function assertGrantableThreads(ownerUserId, threadIds = [], env = process.env) {
  const owner = normalizeUserId(ownerUserId);
  const unique = [...new Set((Array.isArray(threadIds) ? threadIds : []).map(clean).filter(Boolean))];
  if (unique.length > 50) throw vaultError("vault_too_many_grants", 400);
  for (const threadId of unique) {
    const thread = await getThread(threadId, env).catch(() => null);
    if (!thread?.id || thread.id !== threadId || resourceOwnerUserId(thread, env) !== owner) {
      throw vaultError("vault_grant_thread_invalid", 400);
    }
  }
  return unique;
}

export function itemGrantedToThread(record = {}, threadId = "") {
  const id = clean(threadId);
  return Boolean(id) && (Array.isArray(record.threadGrants) ? record.threadGrants : []).some((grant) => clean(grant?.threadId) === id);
}
