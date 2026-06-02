import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDataDirs } from "../../storage/src/paths.js";

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function mergeByKey(existing = [], next = [], keyFn = () => "") {
  const merged = new Map();
  for (const item of [...(existing || []), ...(next || [])]) {
    const key = keyFn(item);
    if (!key) continue;
    merged.set(key, item);
  }
  return [...merged.values()];
}

export function normalizedDeliveryText(value) {
  return String(value || "").replace(/\n\ndbg: .+$/s, "").replace(/\s+/g, " ").trim();
}

export function deliveryTextKey(chatId, text) {
  return crypto
    .createHash("sha256")
    .update(`${String(chatId || "").trim()}\n${normalizedDeliveryText(text)}`)
    .digest("hex");
}

export function outboundDeliveryKey(delivery = {}) {
  return [
    pickString(delivery.kind),
    pickString(delivery.deliveryType),
    pickString(delivery.chatId),
    pickString(delivery.accountId),
    pickString(delivery.messageId),
    pickString(delivery.textKey),
  ].join("|");
}

export function outboundDeliveryClaimTtlMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_OUTBOUND_CLAIM_TTL_MS || env.WHATSAPP_OUTBOUND_CLAIM_TTL_MS || 120_000);
  return Number.isFinite(parsed) ? Math.max(5_000, Math.floor(parsed)) : 120_000;
}

export function outboundDeliveryClaimExpired(claim = {}, nowMs = Date.now(), env = process.env) {
  const status = String(claim.status || "claimed").trim().toLowerCase();
  const ttlMs = outboundDeliveryClaimTtlMs(env);
  const expiresAtMs = Date.parse(String(claim.expiresAt || ""));
  if (Number.isFinite(expiresAtMs)) return expiresAtMs <= nowMs;
  const baseMs = Date.parse(String(claim.updatedAt || claim.claimedAt || claim.deliveredAt || claim.failedAt || ""));
  if (!Number.isFinite(baseMs)) return status === "claimed";
  const retentionMs = status === "claimed" ? ttlMs : Math.max(ttlMs, 60_000);
  return nowMs - baseMs > retentionMs;
}

export function pruneOutboundDeliveryClaims(claims = [], { env = process.env, retentionLimit = 500 } = {}) {
  const nowMs = Date.now();
  return (claims || [])
    .filter((claim) => pickString(claim.claimKey) && !outboundDeliveryClaimExpired(claim, nowMs, env))
    .slice(-Math.max(500, Number(retentionLimit) || 500));
}

export function outboundDeliveryClaimKey({ accountId = "", chatId = "", textKey = "" } = {}) {
  return crypto
    .createHash("sha256")
    .update(`${pickString(accountId)}\n${pickString(chatId)}\n${pickString(textKey)}`)
    .digest("hex");
}

async function outboundDeliveryClaimDir(env = process.env) {
  const paths = await ensureDataDirs(env);
  const dir = path.join(paths.home, "whatsapp-delivery-claims");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readOutboundDeliveryClaimFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function upsertOutboundDeliveryClaim(state, claim) {
  state.outboundDeliveryClaims = mergeByKey(
    state.outboundDeliveryClaims || [],
    [claim],
    (item) => pickString(item.claimKey),
  );
}

export async function acquireOutboundDeliveryClaim({
  state,
  kind,
  deliveryType,
  agentId,
  threadId,
  messageId,
  sourceMessageId,
  chatId,
  accountId,
  textKey,
} = {}, env = process.env, { persistState = null } = {}) {
  const claimKey = outboundDeliveryClaimKey({ accountId, chatId, textKey });
  if (!claimKey || !textKey || !chatId) return { acquired: false, reason: "missing_delivery_claim_key" };
  const dir = await outboundDeliveryClaimDir(env);
  const filePath = path.join(dir, `${claimKey}.json`);
  const ttlMs = outboundDeliveryClaimTtlMs(env);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const claim = {
    claimKey,
    kind,
    deliveryType,
    agentId: agentId || null,
    threadId: threadId || null,
    messageId,
    sourceMessageId: sourceMessageId || null,
    chatId,
    accountId,
    textKey,
    status: "claimed",
    claimedAt: nowIso,
    updatedAt: nowIso,
    expiresAt: new Date(now + ttlMs).toISOString(),
    pid: process.pid,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle = null;
    try {
      handle = await fs.open(filePath, "wx");
      await handle.writeFile(JSON.stringify(claim, null, 2) + "\n", "utf8");
      await handle.close();
      upsertOutboundDeliveryClaim(state, claim);
      await persistState?.(state, env);
      return { acquired: true, claim, filePath };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      const existing = await readOutboundDeliveryClaimFile(filePath);
      if (outboundDeliveryClaimExpired(existing, now, env)) {
        await fs.unlink(filePath).catch(() => {});
        continue;
      }
      return { acquired: false, reason: "delivery_claim_active", claim: existing, filePath };
    }
  }
  return { acquired: false, reason: "delivery_claim_active", filePath };
}

export async function finishOutboundDeliveryClaim({ state, claim, filePath, status, error = "", delivery = null } = {}, env = process.env, { persistState = null } = {}) {
  if (!claim?.claimKey) return;
  const nowIso = new Date().toISOString();
  const updated = {
    ...claim,
    status,
    updatedAt: nowIso,
    ...(status === "delivered" ? { deliveredAt: delivery?.deliveredAt || nowIso } : {}),
    ...(status === "failed" ? { failedAt: nowIso, error: String(error || "").slice(0, 500) } : {}),
  };
  upsertOutboundDeliveryClaim(state, updated);
  await persistState?.(state, env);
  if (status === "delivered" && filePath) await fs.unlink(filePath).catch(() => {});
}
