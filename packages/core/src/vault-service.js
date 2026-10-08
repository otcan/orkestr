import { appendEvent } from "../../storage/src/store.js";
import { isAdminPrincipal } from "./policy.js";
import { normalizeUserId } from "./users.js";
import {
  assertGrantableThreads,
  assertRecentAuth,
  assertVaultOwner,
  consumeVaultRateLimit,
  vaultError,
} from "./vault-access.js";
import { vaultKeyStatus } from "./vault-crypto.js";
import { planVaultImport, publicImportReasons } from "./vault-import.js";
import { buildOtpauthUri, parseOtpauthUri } from "./vault-otpauth.js";
import {
  VAULT_LIMITS,
  applyItemInput,
  findItem,
  itemMeta,
  mutateVault,
  newItemMeta,
  nowIso,
  openRecord,
  readVault,
  sealRecord,
} from "./vault-store.js";
import { currentCode, normalizeTotpConfig } from "./vault-totp.js";

// Owner-facing vault operations. Every function takes the owner principal
// (see vaultOwnerFromRequest) and only touches that principal's own vault.
// Responses and events never include secret values unless stated.

function clean(value) {
  return String(value ?? "").trim();
}

function optionalString(body, key) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, key) || body[key] === undefined) return undefined;
  if (body[key] === null) return "";
  if (typeof body[key] !== "string") throw vaultError("vault_field_invalid", 400, { field: key });
  return body[key];
}

/** Maps the HTTP body to a store input patch (validates types). */
export function itemInputFromBody(body = {}) {
  const input = {};
  for (const key of ["name", "url", "username", "password", "notes"]) {
    const value = optionalString(body, key);
    if (value !== undefined) input[key] = value;
  }
  if (body?.tags !== undefined) {
    if (!Array.isArray(body.tags) && typeof body.tags !== "string") throw vaultError("vault_field_invalid", 400, { field: "tags" });
    input.tags = body.tags;
  }
  const totpUri = optionalString(body, "totpUri");
  const totpSecret = optionalString(body, "totpSecret");
  if (clean(totpUri)) input.totp = parseOtpauthUri(totpUri);
  else if (clean(totpSecret)) input.totp = normalizeTotpConfig({ secret: totpSecret });
  else if (totpUri !== undefined || totpSecret !== undefined) input.totp = null;
  return input;
}

async function event(type, ownerUserId, fields = {}, env = process.env) {
  await appendEvent({ type, ownerUserId, ...fields }, env).catch(() => {});
}

async function ownerItemView(ownerUserId, record, env) {
  const payload = await openRecord(ownerUserId, record, env);
  return { ...itemMeta(record), username: String(payload.username || "") };
}

export async function listVaultItems(principal, env = process.env) {
  const owner = assertVaultOwner(principal);
  const store = await readVault(owner, env);
  const items = [];
  for (const record of store.items) items.push(await ownerItemView(owner, record, env));
  items.sort((left, right) => left.name.localeCompare(right.name));
  return { items };
}

export async function createVaultItem(principal, body = {}, env = process.env) {
  const owner = assertVaultOwner(principal);
  const input = itemInputFromBody(body);
  const record = await mutateVault(owner, async (store) => {
    if (store.items.length >= VAULT_LIMITS.maxItems) throw vaultError("vault_full", 409);
    const { meta, payload } = applyItemInput(newItemMeta(), {}, input);
    const sealed = await sealRecord(owner, meta, payload, env);
    store.items.push(sealed);
    return sealed;
  }, env);
  await event("vault_item_created", owner, { itemId: record.id }, env);
  return { item: await ownerItemView(owner, record, env) };
}

export async function updateVaultItem(principal, itemId, body = {}, env = process.env) {
  const owner = assertVaultOwner(principal);
  const input = itemInputFromBody(body);
  const record = await mutateVault(owner, async (store) => {
    const current = findItem(store, itemId);
    const { secret, ...meta } = current;
    const { meta: nextMeta, payload } = applyItemInput(meta, await openRecord(owner, current, env), input);
    const sealed = await sealRecord(owner, { ...nextMeta, updatedAt: nowIso() }, payload, env);
    store.items[store.items.indexOf(current)] = sealed;
    return sealed;
  }, env);
  await event("vault_item_updated", owner, { itemId: record.id, fields: Object.keys(input).sort() }, env);
  return { item: await ownerItemView(owner, record, env) };
}

export async function deleteVaultItem(principal, itemId, env = process.env) {
  const owner = assertVaultOwner(principal);
  await mutateVault(owner, async (store) => {
    const current = findItem(store, itemId);
    store.items = store.items.filter((item) => item !== current);
    store.approvals = store.approvals.filter((approval) => approval.itemId !== current.id);
  }, env);
  await event("vault_item_deleted", owner, { itemId: clean(itemId) }, env);
  return { ok: true };
}

/** Owner reveal of password + notes. Requires a recent sign-in. */
export async function revealVaultItem(principal, itemId, env = process.env) {
  const owner = assertVaultOwner(principal);
  assertRecentAuth(principal, env);
  await consumeVaultRateLimit("ownerReveal", owner, env);
  const payload = await mutateVault(owner, async (store) => {
    const record = findItem(store, itemId);
    record.lastUsedAt = nowIso();
    return openRecord(owner, record, env);
  }, env);
  await event("vault_reveal", owner, { itemId: clean(itemId) }, env);
  return { password: String(payload.password || ""), notes: String(payload.notes || "") };
}

/**
 * Issues the current code for a stored TOTP/HOTP config inside an open vault
 * mutation. HOTP advances the stored counter in the same write. Shared by the
 * owner and agent code paths (never nest mutateVault calls).
 */
export async function issueCodeInStore(owner, store, itemId, env = process.env) {
  const record = findItem(store, itemId);
  const payload = await openRecord(owner, record, env);
  if (!payload.totp) throw vaultError("vault_totp_not_configured", 404);
  const result = currentCode(payload.totp);
  record.lastUsedAt = nowIso();
  if (payload.totp.type === "hotp") {
    const { secret, ...meta } = record;
    const sealed = await sealRecord(owner, meta, { ...payload, totp: { ...payload.totp, counter: result.nextCounter } }, env);
    store.items[store.items.indexOf(record)] = sealed;
  }
  return { code: result.code, expiresInSeconds: result.expiresInSeconds, period: result.period, digits: result.digits };
}

export async function ownerTotpCode(principal, itemId, env = process.env) {
  const owner = assertVaultOwner(principal);
  await consumeVaultRateLimit("ownerTotp", owner, env);
  return mutateVault(owner, (store) => issueCodeInStore(owner, store, itemId, env), env);
}

/** Exports the TOTP secret as an otpauth:// URI. Requires a recent sign-in. */
export async function exportTotpSecret(principal, itemId, env = process.env) {
  const owner = assertVaultOwner(principal);
  assertRecentAuth(principal, env);
  await consumeVaultRateLimit("ownerReveal", owner, env);
  const store = await readVault(owner, env);
  const payload = await openRecord(owner, findItem(store, itemId), env);
  if (!payload.totp) throw vaultError("vault_totp_not_configured", 404);
  await event("vault_reveal", owner, { itemId: clean(itemId), field: "totp" }, env);
  return { otpauthUri: buildOtpauthUri(payload.totp) };
}

function attachTarget(store, config) {
  const issuer = clean(config?.issuer).toLowerCase();
  if (!issuer) return null;
  return store.items.find((item) => !item.hasTotp && (
    clean(item.name).toLowerCase() === issuer ||
    clean(item.domain) === issuer ||
    clean(item.domain).split(".")[0] === issuer
  )) || null;
}

export async function importVault(principal, body = {}, env = process.env) {
  const owner = assertVaultOwner(principal);
  const plan = planVaultImport({ format: body?.format, content: body?.content });
  const attach = body?.attachToExisting === true;
  const summary = await mutateVault(owner, async (store) => {
    let imported = 0;
    let withTotp = 0;
    const reasons = [...plan.reasons];
    for (const entry of plan.entries) {
      try {
        const target = attach && entry.totpOnly ? attachTarget(store, entry.input.totp) : null;
        if (target) {
          const { secret, ...meta } = target;
          const payload = await openRecord(owner, target, env);
          const next = applyItemInput(meta, payload, { totp: entry.input.totp });
          store.items[store.items.indexOf(target)] = await sealRecord(owner, { ...next.meta, updatedAt: nowIso() }, next.payload, env);
        } else {
          if (store.items.length >= VAULT_LIMITS.maxItems) throw vaultError("vault_full", 409);
          const { meta, payload } = applyItemInput(newItemMeta(), {}, entry.input);
          store.items.push(await sealRecord(owner, meta, payload, env));
        }
        imported += 1;
        if (entry.input.totp) withTotp += 1;
      } catch (error) {
        reasons.push({ row: entry.row, reason: clean(error?.code) || "invalid_entry", skipped: true });
      }
    }
    const skipped = reasons.filter((reason) => reason.skipped).length;
    return { imported, skipped, withTotp, reasons: publicImportReasons(reasons) };
  }, env);
  await event("vault_imported", owner, { count: summary.imported, skipped: summary.skipped, withTotp: summary.withTotp, format: plan.format }, env);
  return summary;
}

export async function setVaultGrants(principal, itemId, threadIds, env = process.env) {
  const owner = assertVaultOwner(principal);
  if (!Array.isArray(threadIds)) throw vaultError("vault_field_invalid", 400, { field: "threadIds" });
  const unique = await assertGrantableThreads(owner, threadIds, env);
  const grantedBy = normalizeUserId(principal.userId);
  const record = await mutateVault(owner, async (store) => {
    const current = findItem(store, itemId);
    const prior = new Map((current.threadGrants || []).map((grant) => [grant.threadId, grant]));
    current.threadGrants = unique.map((threadId) => prior.get(threadId) || { threadId, grantedAt: nowIso(), grantedBy });
    const kept = new Set(unique);
    store.approvals = store.approvals.filter((approval) => approval.itemId !== current.id || kept.has(approval.threadId));
    return current;
  }, env);
  await event("vault_grant_changed", owner, { itemId: record.id, threadIds: unique }, env);
  return { item: await ownerItemView(owner, record, env) };
}

/** Counts only. Admins may pass `userId` to see another user's counts. */
export async function vaultStatus(principal, query = {}, env = process.env) {
  const requested = clean(query?.userId);
  let owner;
  if (requested && isAdminPrincipal(principal) && principal?.vaultOwner) owner = normalizeUserId(requested);
  else owner = assertVaultOwner(principal);
  const store = await readVault(owner, env);
  const nowMs = Date.now();
  return {
    itemCount: store.items.length,
    totpCount: store.items.filter((item) => item.hasTotp).length,
    ...await vaultKeyStatus(env),
    pendingApprovals: store.approvals.filter((approval) => approval.status === "pending" && Date.parse(approval.expiresAt) > nowMs).length,
  };
}
