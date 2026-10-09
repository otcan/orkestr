import { appendEvent } from "../../storage/src/store.js";
import { canAccessOwner, isAdminPrincipal, policyError } from "./policy.js";
import { publicUrlConfig } from "./public-url-config.js";
import {
  decryptSecretValue,
  encryptSecretValue,
  parseSecureSecretReference,
  resolveSecureSecretReference,
  setSecureSecret,
  validateSecureSecretName,
} from "./secure-secrets.js";
import {
  assertSecretLinkValue,
  findSecretLinkByToken,
  mutateSecretLinks,
  newSecretLinkId,
  newSecretLinkToken,
  parseSecretLinkTtl,
  publicSecretLink,
  secretLinkActive,
  secretLinkError,
  secretLinkTokenHash,
} from "./secret-links-store.js";
import { appendThreadSignal } from "./thread-signals.js";
import { getThreadForPrincipal } from "./threads.js";
import { adminUserId, normalizeUserId } from "./users.js";

// One-time secret links (docs/secret-links.md). "share" links carry an
// encrypted value from Orkestr to the owner; "request" links let the owner
// submit a value that is stored as secret://user/<owner>/<name>. Values never
// enter events, thread messages, logs, errors or list responses.

function clean(value) {
  return String(value ?? "").trim();
}

function cleanLabel(value) {
  return clean(value).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200);
}

export function secretLinkPublicBase(env = process.env) {
  const configured = clean(publicUrlConfig(env).appUrl).replace(/\/+$/, "");
  return configured || `http://127.0.0.1:${clean(env.ORKESTR_PORT || env.PORT) || "19812"}`;
}

// Public end-to-end links open without login: shares (vault-share-links.js)
// under /s/e/, receive requests (vault-receive-links.js) under /s/r/.
const publicPrefixes = { e2e: "e/", "e2e-request": "r/" };

export function secretLinkUrl(token, env = process.env, kind = "") {
  return `${secretLinkPublicBase(env)}/s/${publicPrefixes[kind] || ""}${token}`;
}

export async function audit(type, link, env) {
  await appendEvent({
    type,
    linkId: clean(link.id),
    kind: clean(link.kind),
    name: clean(link.name) || null,
    ownerUserId: clean(link.ownerUserId),
    threadId: clean(link.threadId) || null,
  }, env).catch(() => {});
}

export async function auditExpired(expired = [], env) {
  for (const link of expired) await audit("secret_link_expired", link, env);
}

// The link owner is the thread owner when a thread is given, otherwise the
// requested owner or the caller. Callers may only act for owners they can
// access, mirroring the secure-input secret APIs.
async function resolveOwner(input = {}, principal = {}, env) {
  const threadRef = clean(input.threadId);
  let thread = null;
  if (threadRef) {
    thread = await getThreadForPrincipal(threadRef, principal, env);
    if (!thread) throw secretLinkError("thread_not_found", 404);
  }
  const ownerUserId = normalizeUserId(thread?.ownerUserId || input.ownerUserId || principal.userId || adminUserId);
  if (!canAccessOwner(principal, ownerUserId, env)) throw policyError("secret_link_owner_forbidden", 403);
  return { ownerUserId, threadId: thread?.id || "" };
}

async function shareValueFromReference(reference, ownerUserId, principal, env) {
  const target = parseSecureSecretReference(reference, { ownerUserId });
  if (!target.name) throw secretLinkError("secret_reference_invalid");
  if (target.scope === "global" && !isAdminPrincipal(principal)) throw policyError("secret_link_global_forbidden", 403);
  const resolved = await resolveSecureSecretReference(reference, { ownerUserId, createRequest: false, usedBy: "secret-link" }, env);
  if (!resolved?.value) throw secretLinkError("secret_not_found", 404);
  if (resolved.secret?.scope === "global" && !isAdminPrincipal(principal)) throw policyError("secret_link_global_forbidden", 403);
  return { value: resolved.value, name: target.name, handle: clean(resolved.secret?.handle || target.handle) };
}

export async function createLink(kind, base, extra, env) {
  const token = newSecretLinkToken();
  const now = Date.now();
  const link = {
    id: newSecretLinkId(),
    tokenHash: secretLinkTokenHash(token),
    kind,
    status: "active",
    ...base,
    ...extra,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + base.ttlMs).toISOString(),
  };
  delete link.ttlMs;
  const { expired } = await mutateSecretLinks(env, (links) => { links.push(link); });
  await auditExpired(expired, env);
  await audit("secret_link_created", link, env);
  return { ok: true, link: publicSecretLink(link), url: secretLinkUrl(token, env, kind) };
}

export async function linkBase(input, principal, env) {
  const ttlMs = parseSecretLinkTtl(input.ttl);
  const owner = await resolveOwner(input, principal, env);
  return {
    ...owner,
    ttlMs,
    label: cleanLabel(input.label),
    createdBy: normalizeUserId(principal.userId || adminUserId),
  };
}

export async function createSecretShareLink(input = {}, principal = {}, env = process.env) {
  const hasValue = input.value !== undefined && input.value !== null && input.value !== "";
  const from = clean(input.from);
  if (hasValue && from) throw secretLinkError("secret_link_value_and_from_conflict");
  if (!hasValue && !from) throw secretLinkError("secret_value_required");
  const base = await linkBase(input, principal, env);
  const source = from
    ? await shareValueFromReference(from, base.ownerUserId, principal, env)
    : { value: input.value, name: "", handle: "" };
  const value = assertSecretLinkValue(source.value);
  const encryptedValue = await encryptSecretValue(value, env);
  return createLink("share", base, { name: source.name, handle: source.handle, encryptedValue }, env);
}

export async function createSecretRequestLink(input = {}, principal = {}, env = process.env) {
  const name = validateSecureSecretName(input.name);
  const base = await linkBase(input, principal, env);
  return createLink("request", base, { name, handle: `secret://user/${base.ownerUserId}/${name}` }, env);
}

export async function listSecretLinks(options = {}, principal = {}, env = process.env) {
  const ownerUserId = normalizeUserId(options.ownerUserId || principal.userId || adminUserId);
  if (!canAccessOwner(principal, ownerUserId, env)) throw policyError("secret_link_owner_forbidden", 403);
  const all = isAdminPrincipal(principal) && clean(options.all) === "1";
  const { result, expired } = await mutateSecretLinks(env, (links) => links
    .filter((link) => all || normalizeUserId(link.ownerUserId) === ownerUserId)
    .map(publicSecretLink)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))));
  await auditExpired(expired, env);
  return { ok: true, links: result };
}

export async function revokeSecretLink(id = "", principal = {}, env = process.env) {
  const linkId = clean(id);
  const { result, expired } = await mutateSecretLinks(env, (links) => {
    const index = links.findIndex((link) => link.id === linkId);
    if (index < 0) return null;
    const link = links[index];
    if (!canAccessOwner(principal, link.ownerUserId, env)) return { forbidden: true };
    if (!secretLinkActive(link)) return { link, changed: false };
    const { encryptedValue: _dropped, ...rest } = link;
    links[index] = { ...rest, status: "revoked", endedAt: new Date().toISOString(), revokedBy: normalizeUserId(principal.userId || adminUserId) };
    return { link: links[index], changed: true };
  });
  await auditExpired(expired, env);
  if (!result || result.forbidden) throw secretLinkError("secret_link_not_found", 404);
  if (result.changed) await audit("secret_link_revoked", result.link, env);
  return { ok: true, link: publicSecretLink(result.link) };
}

// Token lookups for the browser pages. A link is only visible to the session
// whose user id equals the link owner; anything else is "unknown" so a
// foreign or guessed token reveals nothing (not even existence).
function ownedLink(links, token, userId) {
  const link = findSecretLinkByToken(links, token);
  if (!link || normalizeUserId(link.ownerUserId) !== normalizeUserId(userId)) return null;
  return link;
}

/** Read-only view for GET: never consumes the link. */
export async function inspectSecretLink(token, userId, env = process.env) {
  const { result, expired } = await mutateSecretLinks(env, (links) => {
    const link = ownedLink(links, token, userId);
    if (!link) return { state: "unknown" };
    return { state: secretLinkActive(link) ? "active" : "ended", link: publicSecretLink(link) };
  });
  await auditExpired(expired, env);
  return result;
}

/**
 * Reveals a share link exactly once. The link is marked used and its
 * ciphertext removed under the store lock, and that state is written to disk
 * before the decrypted value is returned to the caller.
 */
export async function revealSecretShareLink(token, userId, env = process.env) {
  const { result, expired } = await mutateSecretLinks(env, async (links) => {
    const link = ownedLink(links, token, userId);
    if (!link || link.kind !== "share") return { state: "unknown" };
    if (!secretLinkActive(link)) return { state: "ended", link: publicSecretLink(link) };
    let value = null;
    try {
      value = await decryptSecretValue({ encryptedValue: link.encryptedValue }, env);
    } catch {
      value = null;
    }
    const { encryptedValue: _dropped, ...rest } = link;
    const used = { ...rest, status: "used", endedAt: new Date().toISOString() };
    links[links.indexOf(link)] = used;
    if (value === null || value === "") return { state: "ended", link: publicSecretLink(used), failed: true };
    return { state: "revealed", link: publicSecretLink(used), value };
  });
  await auditExpired(expired, env);
  if (result.state === "revealed") await audit("secret_link_revealed", result.link, env);
  return result;
}

/**
 * Stores the submitted value through the secure-input manager and consumes
 * the request link in the same locked step. The optional thread note names
 * the secret handle only.
 */
export async function submitSecretRequestLink(token, value, principal = {}, env = process.env) {
  const userId = normalizeUserId(principal.userId);
  const { result, expired } = await mutateSecretLinks(env, async (links) => {
    const link = ownedLink(links, token, userId);
    if (!link || link.kind !== "request") return { state: "unknown" };
    if (!secretLinkActive(link)) return { state: "ended", link: publicSecretLink(link) };
    const accepted = assertSecretLinkValue(value);
    await setSecureSecret({ scope: "user", ownerUserId: link.ownerUserId, name: link.name, value: accepted }, principal, env);
    const used = { ...link, status: "used", endedAt: new Date().toISOString() };
    links[links.indexOf(link)] = used;
    return { state: "submitted", link: publicSecretLink(used) };
  });
  await auditExpired(expired, env);
  if (result.state !== "submitted") return result;
  await audit("secret_link_submitted", result.link, env);
  if (result.link.threadId) {
    await appendThreadSignal(result.link.threadId, {
      source: "secret_link",
      signalKind: "secret_link",
      signalMode: "record_only",
      text: `The owner submitted the secret "${result.link.name}" through a one-time link. Use it by reference: ${result.link.handle}`,
    }, env).catch(() => {});
  }
  return result;
}
