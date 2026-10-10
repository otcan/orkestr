import { audit, auditExpired, createLink, linkBase } from "./secret-links.js";
import {
  findSecretLinkByToken,
  mutateSecretLinks,
  publicSecretLink,
  secretLinkActive,
  secretLinkError,
} from "./secret-links-store.js";
import { normalizeVaultShareEnvelope } from "./vault-share-crypto.js";

// Public, end-to-end encrypted share links for people outside Orkestr
// (docs/vault-sharing.md). They reuse the one-time secret link store with
// kind "e2e": the record holds only the client-built envelope (in the
// `encryptedValue` slot, so the store's expiry/revoke purging applies), a
// view counter and coarse "opened at" status. No IP or user agent is kept.

export const VAULT_SHARE_MAX_VIEWS = 10;

function parseViews(value) {
  if (value === undefined || value === null || value === "") return 1;
  const views = Number(value);
  if (!Number.isInteger(views) || views < 1 || views > VAULT_SHARE_MAX_VIEWS) throw secretLinkError("vault_share_views_invalid");
  return views;
}

export async function createVaultShareLink(input = {}, principal = {}, env = process.env) {
  const envelope = normalizeVaultShareEnvelope(input.envelope);
  const maxViews = parseViews(input.views);
  const base = await linkBase(input, principal, env);
  const name = String(input.name ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 120);
  return createLink("e2e", base, {
    name,
    encryptedValue: JSON.stringify(envelope),
    passphrase: Boolean(envelope.kdf),
    maxViews,
    views: 0,
  }, env);
}

function activeShare(links, token) {
  const link = findSecretLinkByToken(links, token);
  return link && link.kind === "e2e" && secretLinkActive(link) ? link : null;
}

/** Read-only lookup for the public GET page. Unknown, used, revoked and expired look the same. */
export async function inspectVaultShareLink(token, env = process.env) {
  const { result, expired } = await mutateSecretLinks(env, (links) => {
    const link = activeShare(links, token);
    return link ? { state: "active", link: publicSecretLink(link) } : { state: "unknown" };
  });
  await auditExpired(expired, env);
  return result;
}

/**
 * Hands out the envelope and counts one view under the store lock. The last
 * permitted view marks the link used and deletes the envelope before the
 * state is written, so concurrent opens never exceed `maxViews`.
 */
export async function openVaultShareLink(token, env = process.env) {
  const { result, expired } = await mutateSecretLinks(env, (links) => {
    const link = activeShare(links, token);
    if (!link) return { state: "unknown" };
    const now = new Date().toISOString();
    const views = (Number(link.views) || 0) + 1;
    let envelope = null;
    try {
      envelope = JSON.parse(link.encryptedValue);
    } catch {
      envelope = null;
    }
    const next = { ...link, views, openedAt: link.openedAt || now };
    if (views >= (Number(link.maxViews) || 1) || !envelope) {
      delete next.encryptedValue;
      Object.assign(next, { status: "used", endedAt: now });
    }
    links[links.indexOf(link)] = next;
    return envelope ? { state: "opened", link: publicSecretLink(next), envelope } : { state: "unknown" };
  });
  await auditExpired(expired, env);
  if (result.state === "opened") await audit("secret_link_opened", result.link, env);
  return result;
}
