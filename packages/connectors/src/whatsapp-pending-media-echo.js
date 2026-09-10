import crypto from "node:crypto";

const pendingEchoes = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

function echoTtlMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_PENDING_ATTACHMENT_ECHO_TTL_MS || 60_000);
  return Number.isFinite(parsed) ? Math.max(1_000, Math.min(10 * 60_000, Math.floor(parsed))) : 60_000;
}

function echoKey(accountId, chatId) {
  return `${clean(accountId)}:${clean(chatId)}`;
}

function prune(env = process.env) {
  const cutoff = Date.now() - echoTtlMs(env);
  for (const [key, entries] of pendingEchoes.entries()) {
    const retained = (Array.isArray(entries) ? entries : []).filter((entry) => Number(entry?.rememberedAt || 0) >= cutoff);
    if (retained.length) pendingEchoes.set(key, retained);
    else pendingEchoes.delete(key);
  }
  while (pendingEchoes.size > 500) {
    const [oldest] = pendingEchoes.keys();
    pendingEchoes.delete(oldest);
  }
}

export function rememberPendingOutboundAttachmentEcho(accountId, chatId, kind = "", env = process.env) {
  prune(env);
  const key = echoKey(accountId, chatId);
  const token = crypto.randomUUID();
  const entries = pendingEchoes.get(key) || [];
  entries.push({ token, kind: clean(kind).toLowerCase(), rememberedAt: Date.now() });
  pendingEchoes.set(key, entries);
  return { key, token };
}

export function forgetPendingOutboundAttachmentEcho(fence = {}) {
  const key = clean(fence?.key);
  const token = clean(fence?.token);
  if (!key || !token) return;
  const retained = (pendingEchoes.get(key) || []).filter((entry) => entry.token !== token);
  if (retained.length) pendingEchoes.set(key, retained);
  else pendingEchoes.delete(key);
}

export function claimPendingOutboundAttachmentEcho(accountId, chatId, message = {}, env = process.env) {
  prune(env);
  const key = echoKey(accountId, chatId);
  const entries = pendingEchoes.get(key) || [];
  if (!entries.length) return null;
  const messageKind = clean(message?.type || message?._data?.type).toLowerCase();
  const index = entries.findIndex((entry) => !entry.kind || !messageKind || entry.kind === messageKind);
  if (index < 0) return null;
  const [claimed] = entries.splice(index, 1);
  if (entries.length) pendingEchoes.set(key, entries);
  else pendingEchoes.delete(key);
  return claimed;
}

export function resetPendingOutboundAttachmentEchoes() {
  pendingEchoes.clear();
}
