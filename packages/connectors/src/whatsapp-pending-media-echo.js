import crypto from "node:crypto";

// Tracks our own media sends that are still in flight, per account and chat.
// WhatsApp can report an own message before sendMessage returns its id. An
// inbound own media message that arrives meanwhile waits for these sends to
// settle and is an echo only if its id is one of the ids they delivered. Being
// in flight never classifies a message by itself, and nothing is consumed.

const inFlight = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

function echoKey(accountId, chatId) {
  return `${clean(accountId)}:${clean(chatId)}`;
}

export function pendingAttachmentEchoWaitMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_PENDING_ATTACHMENT_ECHO_WAIT_MS ||
    Number(env.ORKESTR_WHATSAPP_SEND_OPERATION_TIMEOUT_MS || env.WA_SEND_OPERATION_TIMEOUT_MS || 20_000) + 2_000);
  return Number.isFinite(parsed) ? Math.max(100, Math.min(10 * 60_000, Math.floor(parsed))) : 22_000;
}

export function rememberPendingOutboundAttachmentEcho(accountId, chatId, kind = "") {
  const key = echoKey(accountId, chatId);
  let resolve;
  const settled = new Promise((done) => { resolve = done; });
  const entry = { token: crypto.randomUUID(), kind: clean(kind).toLowerCase(), settled, resolve };
  const entries = inFlight.get(key) || [];
  entries.push(entry);
  inFlight.set(key, entries);
  return { key, token: entry.token };
}

// Ends the in-flight send. deliveredMessageId is "" when the send failed.
export function settlePendingOutboundAttachmentEcho(fence = {}, deliveredMessageId = "") {
  const key = clean(fence?.key);
  const token = clean(fence?.token);
  if (!key || !token) return;
  const entries = inFlight.get(key) || [];
  const entry = entries.find((item) => item.token === token);
  if (!entry) return;
  entry.resolve(clean(deliveredMessageId));
  const retained = entries.filter((item) => item !== entry);
  if (retained.length) inFlight.set(key, retained);
  else inFlight.delete(key);
}

export function forgetPendingOutboundAttachmentEcho(fence = {}) {
  settlePendingOutboundAttachmentEcho(fence, "");
}

export function hasPendingOutboundAttachmentEcho(accountId, chatId) {
  return (inFlight.get(echoKey(accountId, chatId)) || []).length > 0;
}

// Waits for the sends in flight right now. Returns the ids they delivered and
// whether every one of them settled within the wait.
export async function waitForPendingOutboundAttachmentEchoes(accountId, chatId, env = process.env) {
  const entries = [...(inFlight.get(echoKey(accountId, chatId)) || [])];
  if (!entries.length) return { waited: false, settled: true, deliveredIds: [] };
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), pendingAttachmentEchoWaitMs(env)); });
  const all = Promise.all(entries.map((entry) => entry.settled));
  const result = await Promise.race([all, timeout]);
  clearTimeout(timer);
  return { waited: true, settled: result !== null, deliveredIds: (result || []).filter(Boolean) };
}

export function resetPendingOutboundAttachmentEchoes() {
  for (const entries of inFlight.values()) for (const entry of entries) entry.resolve("");
  inFlight.clear();
}
