import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";
import { readJson, writeJson } from "../../storage/src/store.js";
import { withFileLock } from "./whatsapp-media-echo-lock.js";

const ledgerQueues = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

function ledgerKey(accountId = "", eventId = "") {
  const account = clean(accountId);
  const event = clean(eventId);
  return account && event ? `${account}:${event}` : "";
}

function retentionLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_INBOUND_NOTICE_LEDGER_LIMIT || 1000);
  return Number.isFinite(parsed) ? Math.max(100, Math.min(5000, Math.floor(parsed))) : 1000;
}

function ledgerPath(env = process.env) {
  return path.join(dataPaths(env).home, "whatsapp-inbound-failure-notices.json");
}

async function withLedger(env, work) {
  const filePath = ledgerPath(env);
  const previous = ledgerQueues.get(filePath) || Promise.resolve();
  const next = previous.catch(() => null).then(() => withFileLock(filePath, env, work));
  const stored = next.catch(() => null).finally(() => {
    if (ledgerQueues.get(filePath) === stored) ledgerQueues.delete(filePath);
  });
  ledgerQueues.set(filePath, stored);
  return next;
}

export async function claimWhatsAppInboundFailureNotice(input = {}, env = process.env) {
  const key = ledgerKey(input.accountId, input.eventId);
  if (!key) return { claimed: false, reason: "missing_target" };
  return withLedger(env, async (filePath) => {
    const state = await readJson(filePath, {}).catch(() => ({}));
    const existing = Array.isArray(state.inboundFailureNotices) ? state.inboundFailureNotices : [];
    const prior = existing.find((entry) => clean(entry?.key) === key);
    if (prior) return { claimed: false, reason: "already_notified", entry: prior };
    const entry = {
      key,
      accountId: clean(input.accountId),
      eventId: clean(input.eventId),
      chatId: clean(input.chatId),
      failureCode: clean(input.failureCode),
      claimedAt: new Date().toISOString(),
    };
    await writeJson(filePath, {
      inboundFailureNotices: [...existing, entry].slice(-retentionLimit(env)),
      updatedAt: new Date().toISOString(),
    });
    return { claimed: true, entry };
  });
}
