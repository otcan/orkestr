import { appendEvent } from "../../storage/src/store.js";
import {
  assertSecretLinkValue,
  findSecretLinkByToken,
  mutateSecretLinks,
  newSecretLinkId,
  newSecretLinkToken,
  parseSecretLinkTtl,
  secretLinkActive,
  secretLinkTokenHash,
} from "./secret-links-store.js";
import { revokeSecretLink, secretLinkUrl } from "./secret-links.js";
import { appendThreadSignal } from "./thread-signals.js";
import { normalizeUserId } from "./users.js";
import { assertGrantableThreads, assertVaultOwner, resolveAgentThread, vaultError } from "./vault-access.js";
import { markSingleUse } from "./vault-single-use.js";
import { VAULT_LIMITS, applyItemInput, mutateVault, newItemMeta, nowIso, sealRecord } from "./vault-store.js";

// "Request into vault" (docs/vault.md). An agent asks the owner for a
// password through a one-time secret link (kind "vault", same store, token
// rules and /s/<token> pages as docs/secret-links.md). The owner's submission
// becomes a Vault item, saved or single-use, granted only to the requesting
// thread. The thread gets a record-only note naming the item, never a value.

function clean(value) {
  return String(value ?? "").trim();
}

async function audit(type, link, env, extra = {}) {
  await appendEvent({
    type,
    linkId: clean(link.id),
    kind: "vault",
    name: clean(link.name) || null,
    ownerUserId: clean(link.ownerUserId),
    threadId: clean(link.threadId) || null,
    ...extra,
  }, env).catch(() => {});
}

async function auditExpired(expired = [], env) {
  for (const link of expired) await audit("secret_link_expired", link, env);
}

export function publicVaultRequest(link = {}) {
  const active = secretLinkActive(link);
  return {
    id: clean(link.id),
    name: clean(link.name),
    label: clean(link.label) || null,
    threadId: clean(link.threadId) || null,
    once: link.vault?.once === true,
    usernameToo: link.vault?.usernameToo === true,
    status: active ? "active" : clean(link.status) === "active" ? "expired" : clean(link.status),
    itemId: clean(link.itemId) || null,
    createdAt: clean(link.createdAt) || null,
    expiresAt: clean(link.expiresAt) || null,
    endedAt: clean(link.endedAt) || null,
  };
}

/** Agent side: creates the request link for the token's thread. */
export async function createVaultRequestLink(threadRef, input = {}, env = process.env) {
  const thread = await resolveAgentThread(threadRef, env);
  const name = clean(input.name).replace(/[\u0000-\u001f\u007f]+/g, " ");
  if (!name) throw vaultError("vault_name_required", 400);
  if (name.length > VAULT_LIMITS.maxName) throw vaultError("vault_name_too_large", 413);
  const ttlMs = parseSecretLinkTtl(typeof input.ttl === "string" ? input.ttl : "");
  const token = newSecretLinkToken();
  const nowMs = Date.now();
  const link = {
    id: newSecretLinkId(),
    tokenHash: secretLinkTokenHash(token),
    kind: "vault",
    status: "active",
    ownerUserId: thread.ownerUserId,
    threadId: thread.threadId,
    name,
    label: clean(input.label).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200),
    createdBy: "agent",
    vault: { once: input.once === true, usernameToo: input.usernameToo === true, ttlMs },
    createdAt: nowIso(nowMs),
    expiresAt: nowIso(nowMs + ttlMs),
  };
  const { expired } = await mutateSecretLinks(env, (links) => { links.push(link); });
  await auditExpired(expired, env);
  await audit("secret_link_created", link, env);
  return { ok: true, request: publicVaultRequest(link), url: secretLinkUrl(token, env) };
}

/** Owner view for the Vault page: this owner's vault request links. */
export async function listVaultRequests(principal, env = process.env) {
  const owner = assertVaultOwner(principal);
  const { result, expired } = await mutateSecretLinks(env, (links) => links
    .filter((link) => link.kind === "vault" && normalizeUserId(link.ownerUserId) === owner)
    .map(publicVaultRequest)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))));
  await auditExpired(expired, env);
  return { requests: result };
}

export async function revokeVaultRequest(principal, id, env = process.env) {
  const { requests } = await listVaultRequests(principal, env);
  if (!requests.some((request) => request.id === clean(id))) throw vaultError("vault_request_not_found", 404);
  const { link } = await revokeSecretLink(id, principal, env);
  return { ok: true, status: link.status };
}

/** Read-only token lookup for the /s/<token> page (owner session only). */
export async function inspectVaultRequestLink(token, userId, env = process.env) {
  const { result } = await mutateSecretLinks(env, (links) => findSecretLinkByToken(links, token));
  if (!result || result.kind !== "vault" || normalizeUserId(result.ownerUserId) !== normalizeUserId(userId)) return null;
  return publicVaultRequest(result);
}

async function storeRequestedItem(link, values, env) {
  const owner = normalizeUserId(link.ownerUserId);
  const [threadId] = await assertGrantableThreads(owner, [link.threadId], env);
  const record = await mutateVault(owner, async (store) => {
    if (store.items.length >= VAULT_LIMITS.maxItems) throw vaultError("vault_full", 409);
    const applied = applyItemInput(newItemMeta(), {}, { name: link.name, ...values });
    const nowMs = Date.now();
    let meta = { ...applied.meta, threadGrants: [{ threadId, grantedAt: nowIso(nowMs), grantedBy: owner }] };
    if (link.vault?.once) meta = markSingleUse(meta, Number(link.vault.ttlMs) || 15 * 60 * 1000, nowMs);
    const sealed = await sealRecord(owner, meta, applied.payload, env);
    store.items.push(sealed);
    return sealed;
  }, env);
  await appendEvent({ type: "vault_item_created", ownerUserId: owner, itemId: record.id, source: "vault_request", linkId: link.id, threadId, singleUse: link.vault?.once === true }, env).catch(() => {});
  return record;
}

/**
 * Stores the owner's submission as a Vault item and consumes the link in the
 * same locked step (concurrent submits store at most one item).
 */
export async function submitVaultRequestLink(token, values = {}, principal = {}, env = process.env) {
  const userId = normalizeUserId(principal.userId);
  const { result, expired } = await mutateSecretLinks(env, async (links) => {
    const link = findSecretLinkByToken(links, token);
    if (!link || link.kind !== "vault" || normalizeUserId(link.ownerUserId) !== userId) return { state: "unknown" };
    if (!secretLinkActive(link)) return { state: "ended" };
    const password = assertSecretLinkValue(values.password);
    const username = link.vault?.usernameToo && typeof values.username === "string" ? values.username.trim() : undefined;
    const record = await storeRequestedItem(link, { password, ...(username ? { username } : {}) }, env);
    const used = { ...link, status: "used", endedAt: nowIso(), itemId: record.id };
    links[links.indexOf(link)] = used;
    return { state: "submitted", request: publicVaultRequest(used), item: { id: record.id, singleUseExpiresAt: record.singleUseExpiresAt || null } };
  });
  await auditExpired(expired, env);
  if (result.state !== "submitted") return result;
  await audit("secret_link_submitted", result.request, env, { itemId: result.item.id });
  const { request, item } = result;
  const kind = request.once ? `a single-use item (one release, expires ${item.singleUseExpiresAt})` : "a saved item";
  await appendThreadSignal(request.threadId, {
    source: "vault_request",
    signalKind: "vault_request",
    signalMode: "record_only",
    text: `The owner stored "${request.name}" in the Vault as ${kind}, granted to this thread (item ${item.id}). Use it with: orkestr vault exec ${item.id} -- <command>`,
  }, env).catch(() => {});
  return result;
}
