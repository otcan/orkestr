import crypto from "node:crypto";
import { appendEvent } from "../../storage/src/store.js";
import { audit, auditExpired, createLink, linkBase } from "./secret-links.js";
import {
  assertSecretLinkValue,
  findSecretLinkByToken,
  mutateSecretLinks,
  publicSecretLink,
  secretLinkActive,
  secretLinkError,
} from "./secret-links-store.js";
import { appendThreadSignal } from "./thread-signals.js";
import { normalizeUserId } from "./users.js";
import { assertGrantableThreads, vaultError } from "./vault-access.js";
import { openItemPayload, sealItemPayload } from "./vault-crypto.js";
import { markSingleUse } from "./vault-single-use.js";
import { VAULT_LIMITS, applyItemInput, mutateVault, newItemMeta, nowIso, sealRecord } from "./vault-store.js";

// Receive links (docs/vault-sharing.md): a person outside Orkestr submits a
// password through a public page and it lands in the link owner's Vault.
// Each link has its own RSA-OAEP-3072 key pair. The public key is served to
// the page, which encrypts in the browser (RSA-OAEP-SHA256 wrapping a fresh
// AES-256-GCM key). The private key is sealed under the vault key and kept in
// the link's ciphertext slot, so the store's used/revoked/expired purging
// removes it. The value is only decrypted in memory to seal the vault item.

const kind = "e2e-request";
const maxWrappedKeyBytes = 512;
const maxCiphertextBytes = 24 * 1024;
const b64url = /^[A-Za-z0-9_-]+$/;
const receivedSingleUseTtlMs = 24 * 60 * 60 * 1000;

function clean(value) {
  return String(value ?? "").trim();
}

function keyAad(keyRef) {
  return `receive:${keyRef}`;
}

function cleanName(value) {
  const name = clean(value).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 120);
  if (!name) throw secretLinkError("vault_receive_name_required");
  return name;
}

export async function createVaultReceiveLink(input = {}, principal = {}, env = process.env) {
  const name = cleanName(input.name);
  const base = await linkBase(input, principal, env);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
  const keyRef = crypto.randomBytes(12).toString("hex");
  const sealed = await sealItemPayload({ pkcs8: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url") }, base.ownerUserId, keyAad(keyRef), env);
  return createLink(kind, base, {
    name,
    once: input.once === true,
    keyRef,
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    encryptedValue: JSON.stringify(sealed),
  }, env);
}

function activeRequest(links, token) {
  const link = findSecretLinkByToken(links, token);
  return link && link.kind === kind && secretLinkActive(link) ? link : null;
}

/** Read-only lookup for the public GET page. Unknown, used, revoked and expired look the same. */
export async function inspectVaultReceiveLink(token, env = process.env) {
  const { result, expired } = await mutateSecretLinks(env, (links) => {
    const link = activeRequest(links, token);
    return link ? { state: "active", link: publicSecretLink(link), publicKey: link.publicKey } : { state: "unknown" };
  });
  await auditExpired(expired, env);
  return result;
}

function decodePart(value, max) {
  const text = typeof value === "string" ? value : "";
  if (!text || !b64url.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.length && bytes.length <= max ? bytes : null;
}

async function decryptSubmission(link, envelope, env) {
  const parts = envelope && typeof envelope === "object" && envelope.v === 1 && envelope.alg === "RSA-OAEP-256+A256GCM"
    ? [decodePart(envelope.wk, maxWrappedKeyBytes), decodePart(envelope.iv, 12), decodePart(envelope.ct, maxCiphertextBytes)]
    : [];
  if (parts.length !== 3 || parts.some((part) => !part) || parts[1].length !== 12 || parts[2].length < 17) return null;
  const [wrapped, iv, ct] = parts;
  try {
    const { pkcs8 } = await openItemPayload(JSON.parse(link.encryptedValue), link.ownerUserId, keyAad(link.keyRef), env);
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(pkcs8, "base64url"), format: "der", type: "pkcs8" });
    const aesKey = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, wrapped);
    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    const plain = JSON.parse(Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString("utf8"));
    return { password: plain?.p, username: typeof plain?.u === "string" ? plain.u.trim().slice(0, 500) : "" };
  } catch {
    return null;
  }
}

// `once` links store a single-use item (vault-single-use): one release to a
// thread, valid for a day after it was received.
async function storeReceivedItem(link, values, env) {
  const owner = normalizeUserId(link.ownerUserId);
  const grants = link.threadId ? await assertGrantableThreads(owner, [link.threadId], env) : [];
  return mutateVault(owner, async (store) => {
    if (store.items.length >= VAULT_LIMITS.maxItems) throw vaultError("vault_full", 409);
    const applied = applyItemInput(newItemMeta(), {}, { name: link.name, ...values });
    const now = Date.now();
    let meta = { ...applied.meta, threadGrants: grants.map((threadId) => ({ threadId, grantedAt: nowIso(now), grantedBy: owner })) };
    if (link.once) meta = markSingleUse(meta, receivedSingleUseTtlMs, now);
    const sealed = await sealRecord(owner, meta, applied.payload, env);
    store.items.push(sealed);
    return sealed;
  }, env);
}

/**
 * Decrypts the browser envelope, stores the Vault item and consumes the link
 * in one locked step, so concurrent submits store at most one item. An
 * envelope that does not decrypt leaves the link active ("invalid").
 */
export async function submitVaultReceiveLink(token, envelope, env = process.env) {
  const { result, expired } = await mutateSecretLinks(env, async (links) => {
    const link = activeRequest(links, token);
    if (!link) return { state: "unknown" };
    const values = await decryptSubmission(link, envelope, env);
    if (!values) return { state: "invalid" };
    const password = assertSecretLinkValue(values.password);
    const record = await storeReceivedItem(link, { password, ...(values.username ? { username: values.username } : {}) }, env);
    const { encryptedValue: _dropped, ...rest } = link;
    const used = { ...rest, status: "used", endedAt: new Date().toISOString(), itemId: record.id };
    links[links.indexOf(link)] = used;
    return { state: "submitted", link: { ...publicSecretLink(used), itemId: record.id } };
  });
  await auditExpired(expired, env);
  if (result.state !== "submitted") return result;
  const { link } = result;
  await audit("secret_link_submitted", link, env);
  await appendEvent({ type: "vault_item_created", ownerUserId: link.ownerUserId, itemId: link.itemId, source: "vault_receive", linkId: link.id, singleUse: link.once === true }, env).catch(() => {});
  if (link.threadId) {
    await appendThreadSignal(link.threadId, {
      source: "vault_receive",
      signalKind: "vault_receive",
      signalMode: "record_only",
      text: `Someone outside Orkestr submitted "${link.name}" through a receive link. It is in the Vault (item ${link.itemId}), granted to this thread. Use it with: orkestr vault exec ${link.itemId} -- <command>`,
    }, env).catch(() => {});
  }
  return result;
}
