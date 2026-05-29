import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson } from "../../storage/src/store.js";
import { requestThreadInputDelivery } from "../../core/src/runtime-leases.js";
import { listThreads } from "../../core/src/threads.js";
import { setGeneratedLocalWhatsAppGroupPicture } from "./whatsapp-chat-picture.js";

export const localWhatsAppAccountIds = ["account-1", "account-2"];
export const localWhatsAppBridgeBasePath = "/api/connectors/whatsapp/bridge";

const runtimes = new Map();
const accountStates = new Map();
const outboundMessageIds = new Set();
const outboundMessageTextKeys = new Set();
const inboundFailureNoticeKeys = new Set();
const typingSessions = new Map();
const typingClearRetryTimers = new Map();

function nowIso() {
  return new Date().toISOString();
}

function splitAccountList(value) {
  return String(value || "")
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function localWhatsAppAccountIdsForEnv(env = process.env) {
  const configured = splitAccountList(env.ORKESTR_WHATSAPP_ACCOUNT_IDS || env.WHATSAPP_LOCAL_ACCOUNT_IDS);
  return configured.length ? [...new Set(configured)] : localWhatsAppAccountIds;
}

function accountClientIdMap(env = process.env) {
  const pairs = splitAccountList(env.ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS || env.WHATSAPP_LOCAL_ACCOUNT_CLIENT_IDS);
  return new Map(pairs.map((pair) => {
    const [accountId, ...clientIdParts] = pair.split(":");
    return [String(accountId || "").trim(), clientIdParts.join(":").trim()];
  }).filter(([accountId, clientId]) => accountId && clientId));
}

function clientIdForAccount(accountId, env = process.env) {
  return accountClientIdMap(env).get(accountId) || accountId;
}

function accountSessionRootMap(env = process.env) {
  const pairs = splitAccountList(env.ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS || env.WHATSAPP_LOCAL_ACCOUNT_SESSION_ROOTS);
  return new Map(pairs.map((pair) => {
    const [accountId, ...rootParts] = pair.split(":");
    return [String(accountId || "").trim(), rootParts.join(":").trim()];
  }).filter(([accountId, root]) => accountId && root));
}

function sessionRootForAccount(accountId, env = process.env) {
  return accountSessionRootMap(env).get(accountId) || sessionRoot(env);
}

function normalizeAccountId(accountId = "", env = process.env) {
  const ids = localWhatsAppAccountIdsForEnv(env);
  const normalized = String(accountId || ids[0] || "account-1").trim();
  if (!ids.includes(normalized)) {
    const error = new Error("unknown_whatsapp_account");
    error.statusCode = 404;
    throw error;
  }
  return normalized;
}

function accountLabel(accountId) {
  if (!localWhatsAppAccountIds.includes(accountId)) return accountId;
  return accountId === "account-2" ? "WhatsApp 2" : "WhatsApp 1";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

export function transientLocalWhatsAppSendError(error) {
  const message = String(error?.message || error || "");
  return /Promise was collected|Runtime\.callFunctionOn|Execution context was destroyed|Target closed/i.test(message);
}

function serializedMessageId(message = {}) {
  return String(message?.id?._serialized || message?.id || "");
}

function sentMessageText(message = {}) {
  return String(message?.body || message?.text || message?.caption || "");
}

async function recentOwnTextMessage(client, chatId, text) {
  if (!client || !chatId || !String(text || "")) return null;
  const chat = await client.getChatById(chatId).catch(() => null);
  if (!chat || typeof chat.fetchMessages !== "function") return null;
  const messages = await chat.fetchMessages({ limit: 20 }).catch(() => []);
  return [...(Array.isArray(messages) ? messages : [])].reverse().find((message) =>
    Boolean(message?.fromMe) && sentMessageText(message) === text
  ) || null;
}

export async function sendWhatsAppTextWithConfirmation({
  client,
  chatId = "",
  text = "",
  maxAttempts = 2,
  retryDelayMs = 500,
} = {}) {
  let lastError = null;
  const attempts = Math.max(1, Number(maxAttempts || 1));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await client.sendMessage(chatId, text);
    } catch (error) {
      lastError = error;
      if (!transientLocalWhatsAppSendError(error)) throw error;
      const confirmed = await recentOwnTextMessage(client, chatId, text);
      if (confirmed) return confirmed;
      if (attempt >= attempts) throw error;
      await wait(retryDelayMs);
    }
  }
  throw lastError || new Error("whatsapp_send_failed");
}

function normalizePairingPhoneNumber(phoneNumber = "") {
  return String(phoneNumber || "").replace(/\D+/g, "").trim();
}

export function normalizeGroupParticipantIds(participantIds = []) {
  const values = Array.isArray(participantIds)
    ? participantIds
    : String(participantIds || "").split(/[\s,]+/g);
  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const id = String(value || "").trim();
    const comparable = id.toLowerCase();
    if (!id || seen.has(comparable)) continue;
    seen.add(comparable);
    normalized.push(id);
  }
  return normalized;
}

function maskPairingPhoneNumber(phoneNumber = "") {
  const normalized = normalizePairingPhoneNumber(phoneNumber);
  if (!normalized) return "";
  return `${"*".repeat(Math.max(0, normalized.length - 4))}${normalized.slice(-4)}`;
}

function bridgeRoot(env = process.env) {
  return path.join(dataPaths(env).home, "whatsapp-bridge");
}

function qrPath(accountId, env = process.env) {
  return path.join(bridgeRoot(env), "qrs", `${accountId}.svg`);
}

function sessionRoot(env = process.env) {
  return path.join(bridgeRoot(env), "sessions");
}

function inboundMediaRoot(env = process.env) {
  return path.join(bridgeRoot(env), "inbound-media");
}

export function webCacheRoot(env = process.env) {
  return path.join(bridgeRoot(env), "web-cache");
}

async function ensureBridgeDirs(env = process.env) {
  await ensureDataDirs(env);
  await fs.mkdir(path.join(bridgeRoot(env), "qrs"), { recursive: true });
  await fs.mkdir(sessionRoot(env), { recursive: true });
  await fs.mkdir(inboundMediaRoot(env), { recursive: true });
  await fs.mkdir(webCacheRoot(env), { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function qrUrl(accountId) {
  return `${localWhatsAppBridgeBasePath}/qr.svg?accountId=${encodeURIComponent(accountId)}`;
}

function defaultAccountState(accountId) {
  return {
    accountId,
    label: accountLabel(accountId),
    state: "idle",
    ready: false,
    authenticated: false,
    started: false,
    qrAvailable: false,
    qrUrl: "",
    pairingCode: "",
    pairingCodeUpdatedAt: null,
    pairingPhoneNumber: "",
    authenticatedAt: null,
    loadingPercent: null,
    loadingMessage: "",
    waState: "",
    error: "",
    updatedAt: null,
  };
}

function setAccountState(accountId, patch) {
  const current = accountStates.get(accountId) || defaultAccountState(accountId);
  const next = {
    ...current,
    ...patch,
    accountId,
    label: accountLabel(accountId),
    updatedAt: nowIso(),
  };
  accountStates.set(accountId, next);
  return next;
}

async function accountSnapshot(accountId, env = process.env) {
  const state = accountStates.get(accountId) || defaultAccountState(accountId);
  const qrAvailable = Boolean(state.qrAvailable || (await exists(qrPath(accountId, env))));
  return {
    ...state,
    clientId: clientIdForAccount(accountId, env),
    sessionRoot: sessionRootForAccount(accountId, env),
    qrAvailable,
    qrUrl: qrAvailable ? qrUrl(accountId) : "",
    started: Boolean(state.started || runtimes.has(accountId)),
  };
}

export function reduceLocalWhatsAppBridgeState(accounts) {
  if (accounts.some((account) => account.ready)) return "ready";
  if (accounts.some((account) => account.pairingCode || account.state === "pairing_code")) return "pairing_code";
  if (accounts.some((account) => account.qrAvailable)) return "qr_needed";
  if (accounts.some((account) => account.state === "starting")) return "starting";
  if (accounts.some((account) => ["auth_failure", "auth_ready_timeout", "dependency_missing", "failed"].includes(account.state))) return "failed";
  if (accounts.some((account) => account.authenticated || account.state === "authenticated")) return "authenticated";
  if (accounts.some((account) => account.state === "disconnected")) return "disconnected";
  return "idle";
}

function isGroupChatId(chatId) {
  return /@g\.us$/i.test(String(chatId || "").trim());
}

function localAccountMatches(accountId, selectedAccountId, env = process.env) {
  const account = String(accountId || "").trim();
  if (!account) return true;
  if (!localWhatsAppAccountIdsForEnv(env).includes(account)) return true;
  return account === selectedAccountId;
}

function addChat(target, chat) {
  const id = String(chat?.id || "").trim();
  if (!id) return;
  const existing = target.get(id) || {};
  target.set(id, {
    ...existing,
    ...chat,
    id,
    name: String(chat.name || existing.name || id).trim(),
    isGroup: Boolean(chat.isGroup ?? existing.isGroup ?? isGroupChatId(id)),
    unreadCount: Number(chat.unreadCount ?? existing.unreadCount ?? 0) || 0,
    timestamp: chat.timestamp || existing.timestamp || null,
  });
}

function rememberOutboundMessageId(messageId) {
  const id = String(messageId || "").trim();
  if (!id) return;
  outboundMessageIds.add(id);
  if (outboundMessageIds.size > 500) {
    const [oldest] = outboundMessageIds;
    outboundMessageIds.delete(oldest);
  }
}

function textKey(accountId, chatId, text) {
  return `${String(accountId || "").trim()}:${String(chatId || "").trim()}:${String(text || "").replace(/\s+/g, " ").trim()}`;
}

function rememberOutboundText(accountId, chatId, text) {
  const key = textKey(accountId, chatId, text);
  if (!key.endsWith(":")) outboundMessageTextKeys.add(key);
  if (outboundMessageTextKeys.size > 500) {
    const [oldest] = outboundMessageTextKeys;
    outboundMessageTextKeys.delete(oldest);
  }
}

function rememberInboundFailureNotice(accountId, eventId) {
  const key = `${String(accountId || "").trim()}:${String(eventId || "").trim()}`;
  if (!key.endsWith(":")) inboundFailureNoticeKeys.add(key);
  if (inboundFailureNoticeKeys.size > 500) {
    const [oldest] = inboundFailureNoticeKeys;
    inboundFailureNoticeKeys.delete(oldest);
  }
  return key;
}

function hasInboundFailureNotice(accountId, eventId) {
  const key = `${String(accountId || "").trim()}:${String(eventId || "").trim()}`;
  return Boolean(key.trim() && inboundFailureNoticeKeys.has(key));
}

function serializedId(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  return String(value._serialized || value.user || value.id || "").trim();
}

function runtimeIdentity(runtime) {
  return serializedId(runtime?.client?.info?.wid || runtime?.client?.info?.me);
}

export function localWhatsAppMessageRouteFields(message = {}) {
  const fromMe = Boolean(message?.fromMe);
  const remote = serializedId(message?.id?.remote);
  const chatId = String(fromMe
    ? (message?.to || remote || message?.from || "")
    : (message?.from || remote || message?.to || "")
  ).trim();
  const from = String(message?.author || message?.from || "").trim();
  return { chatId, from, fromMe };
}

function groupIdFromCreateResult(result) {
  return serializedId(result?.gid || result?.id || result?.chatId || result?.groupId);
}

async function knownLocalWhatsAppChats(accountId, env = process.env) {
  const selectedAccountId = normalizeAccountId(accountId, env);
  const known = new Map();
  const threads = await listThreads(env).catch(() => []);
  for (const thread of threads) {
    const binding = thread?.binding || {};
    if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") continue;
    const chatId = String(binding.chatId || "").trim();
    const accountIds = [binding.senderAccountId, binding.responderAccountId, binding.outboundAccountId]
      .map((candidate) => String(candidate || "").trim())
      .filter(Boolean);
    if (!chatId || (accountIds.length && !accountIds.some((candidate) => localAccountMatches(candidate, selectedAccountId, env)))) continue;
    addChat(known, {
      id: chatId,
      name: String(binding.displayName || thread.bindingName || thread.name || thread.title || chatId).trim(),
      isGroup: isGroupChatId(chatId),
      unreadCount: 0,
      timestamp: binding.updatedAt || thread.updatedAt || thread.createdAt || null,
      source: "thread_binding",
      threadId: thread.id,
      accountId: String(binding.responderAccountId || binding.outboundAccountId || binding.senderAccountId || selectedAccountId).trim(),
    });
  }
  const state = await readJson(dataPaths(env).whatsapp, { inboundEvents: [], outboundDeliveries: [] }).catch(() => ({ inboundEvents: [], outboundDeliveries: [] }));
  for (const event of state.inboundEvents || []) {
    const chatId = String(event?.chatId || "").trim();
    if (!chatId || !localAccountMatches(event.accountId, selectedAccountId, env)) continue;
    addChat(known, {
      id: chatId,
      name: String(event.chatName || event.displayName || event.chatId || chatId).trim(),
      isGroup: isGroupChatId(chatId),
      timestamp: event.receivedAt || event.createdAt || null,
      source: "inbound_event",
      accountId: String(event.accountId || selectedAccountId).trim(),
    });
  }
  for (const delivery of state.outboundDeliveries || []) {
    const chatId = String(delivery?.chatId || "").trim();
    if (!chatId || !localAccountMatches(delivery.accountId, selectedAccountId, env)) continue;
    addChat(known, {
      id: chatId,
      name: chatId,
      isGroup: isGroupChatId(chatId),
      timestamp: delivery.deliveredAt || null,
      source: "outbound_delivery",
      accountId: String(delivery.accountId || selectedAccountId).trim(),
    });
  }
  return [...known.values()].sort((a, b) =>
    String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { sensitivity: "base" }),
  );
}

export async function getLocalWhatsAppBridgeStatus(env = process.env) {
  const accountIds = localWhatsAppAccountIdsForEnv(env);
  const accounts = await Promise.all(accountIds.map((accountId) => accountSnapshot(accountId, env)));
  const state = reduceLocalWhatsAppBridgeState(accounts);
  const qrAccount = accounts.find((account) => account.qrAvailable);
  return {
    ok: true,
    mode: "local",
    state,
    ready: state === "ready",
    clientReady: state === "ready",
    authenticated: accounts.some((account) => account.authenticated || account.ready),
    qrAvailable: Boolean(qrAccount),
    qrUrl: qrAccount?.qrUrl || "",
    maxAccounts: accountIds.length,
    accounts,
  };
}

async function loadBridgeDependencies() {
  const [whatsappModule, qrcodeModule] = await Promise.all([
    import("whatsapp-web.js"),
    import("qrcode"),
  ]);
  return {
    whatsapp: whatsappModule.default || whatsappModule,
    qrcode: qrcodeModule.default || qrcodeModule,
  };
}

function puppeteerOptions(env = process.env) {
  const executablePath = String(env.WA_CHROME_PATH || env.PUPPETEER_EXECUTABLE_PATH || "").trim();
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  };
}

function whatsappUserAgent(env = process.env) {
  return String(
    env.WA_USER_AGENT ||
    env.WHATSAPP_USER_AGENT ||
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  ).trim();
}

function typingRefreshMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_TYPING_REFRESH_MS || env.WA_TYPING_REFRESH_MS || 8000);
  return Number.isFinite(parsed) ? Math.max(2000, parsed) : 8000;
}

export function localWhatsAppTypingClearRetryDelaysMs(env = process.env) {
  const raw = String(env.ORKESTR_WHATSAPP_TYPING_CLEAR_RETRY_MS || env.WA_TYPING_CLEAR_RETRY_MS || "750,2500,8000").trim();
  if (!raw || raw === "0" || raw.toLowerCase() === "off") return [];
  const delays = raw
    .split(/[\s,]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item >= 0 && item <= 60_000);
  return [...new Set(delays)];
}

function typingKey(accountId, chatId) {
  return `${String(accountId || "").trim()}:${String(chatId || "").trim()}`;
}

function clearTypingClearRetryTimers(key) {
  for (const timer of typingClearRetryTimers.get(key) || []) clearTimeout(timer);
  typingClearRetryTimers.delete(key);
}

async function sendChatTypingState(runtime, chatId, active) {
  const chat = await runtime.client.getChatById(chatId);
  if (active) {
    await runtime.client.sendPresenceAvailable?.().catch(() => {});
    await chat.sendStateTyping();
    return;
  }
  await chat.clearState?.();
}

function scheduleTypingClearRetries({ accountId = "", chatId = "", env = process.env } = {}) {
  const selectedAccountId = String(accountId || "").trim();
  const id = String(chatId || "").trim();
  if (!selectedAccountId || !id) return;
  const key = typingKey(selectedAccountId, id);
  const delays = localWhatsAppTypingClearRetryDelaysMs(env);
  clearTypingClearRetryTimers(key);
  if (!delays.length) return;
  const timers = delays.map((delayMs) => {
    const timer = setTimeout(() => {
      const remaining = (typingClearRetryTimers.get(key) || []).filter((item) => item !== timer);
      if (remaining.length) typingClearRetryTimers.set(key, remaining);
      else typingClearRetryTimers.delete(key);
      if (typingSessions.has(key)) return;
      const runtime = runtimes.get(selectedAccountId);
      const state = accountStates.get(selectedAccountId);
      if (!runtime?.client || !state?.ready) return;
      sendChatTypingState(runtime, id, false)
        .then(() => appendEvent({ type: "whatsapp_local_typing_clear_retry", accountId: selectedAccountId, chatId: id, delayMs }, env).catch(() => {}))
        .catch((error) => {
          appendEvent({ type: "whatsapp_local_typing_clear_retry_failed", accountId: selectedAccountId, chatId: id, delayMs, error: error.message || String(error) }, env).catch(() => {});
        });
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  });
  typingClearRetryTimers.set(key, timers);
}

export async function startLocalWhatsAppTyping({ chatId = "", accountId = "", env = process.env } = {}) {
  const selectedAccountId = accountId
    ? normalizeAccountId(accountId, env)
    : localWhatsAppAccountIdsForEnv(env).find((id) => accountStates.get(id)?.ready);
  const id = String(chatId || "").trim();
  const runtime = selectedAccountId ? runtimes.get(selectedAccountId) : null;
  const state = selectedAccountId ? accountStates.get(selectedAccountId) : null;
  if (!id || !runtime?.client || !state?.ready) return { ok: false, reason: !id ? "missing_chat_id" : "whatsapp_local_bridge_not_ready" };
  const key = typingKey(selectedAccountId, id);
  if (typingSessions.has(key)) return { ok: true, active: true, reused: true, accountId: selectedAccountId, chatId: id };
  clearTypingClearRetryTimers(key);

  await sendChatTypingState(runtime, id, true);
  const interval = setInterval(() => {
    sendChatTypingState(runtime, id, true).catch((error) => {
      appendEvent({ type: "whatsapp_local_typing_refresh_failed", accountId: selectedAccountId, chatId: id, error: error.message || String(error) }, env).catch(() => {});
    });
  }, typingRefreshMs(env));
  if (typeof interval.unref === "function") interval.unref();
  typingSessions.set(key, { accountId: selectedAccountId, chatId: id, interval });
  await appendEvent({ type: "whatsapp_local_typing_started", accountId: selectedAccountId, chatId: id }, env).catch(() => {});
  return { ok: true, active: true, reused: false, accountId: selectedAccountId, chatId: id };
}

export async function stopLocalWhatsAppTyping({ chatId = "", accountId = "", env = process.env } = {}) {
  const selectedAccountId = accountId
    ? normalizeAccountId(accountId, env)
    : localWhatsAppAccountIdsForEnv(env).find((id) => accountStates.get(id)?.ready);
  const id = String(chatId || "").trim();
  if (!selectedAccountId || !id) return { ok: false, reason: "missing_target" };
  const key = typingKey(selectedAccountId, id);
  const session = typingSessions.get(key);
  if (session?.interval) clearInterval(session.interval);
  typingSessions.delete(key);
  const runtime = runtimes.get(selectedAccountId);
  const state = accountStates.get(selectedAccountId);
  if (runtime?.client && state?.ready) {
    await sendChatTypingState(runtime, id, false).catch((error) => {
      appendEvent({ type: "whatsapp_local_typing_clear_failed", accountId: selectedAccountId, chatId: id, error: error.message || String(error) }, env).catch(() => {});
    });
    scheduleTypingClearRetries({ accountId: selectedAccountId, chatId: id, env });
  }
  if (session) await appendEvent({ type: "whatsapp_local_typing_stopped", accountId: selectedAccountId, chatId: id }, env).catch(() => {});
  return { ok: true, active: false, accountId: selectedAccountId, chatId: id };
}

export async function syncLocalWhatsAppTypingTargets(targets = [], env = process.env) {
  const active = new Set();
  const started = [];
  const stopped = [];
  for (const target of targets) {
    const chatId = String(target?.chatId || "").trim();
    if (!chatId) continue;
    let selectedAccountId = "";
    if (target?.accountId) {
      try {
        selectedAccountId = normalizeAccountId(target.accountId, env);
      } catch {
        selectedAccountId = "";
      }
    }
    selectedAccountId ||= localWhatsAppAccountIdsForEnv(env).find((id) => accountStates.get(id)?.ready) || "";
    if (!selectedAccountId) continue;
    const result = await startLocalWhatsAppTyping({ accountId: selectedAccountId, chatId, env }).catch((error) => ({ ok: false, error: error.message || String(error) }));
    if (!result?.ok) continue;
    active.add(typingKey(result.accountId || selectedAccountId, chatId));
    if (result?.ok && !result.reused) started.push(result);
  }
  for (const session of [...typingSessions.values()]) {
    if (active.has(typingKey(session.accountId, session.chatId))) continue;
    const result = await stopLocalWhatsAppTyping({ accountId: session.accountId, chatId: session.chatId, env });
    if (result?.ok) stopped.push(result);
  }
  return { ok: true, active: active.size, started, stopped };
}

function authReadyTimeoutMs(env = process.env, options = {}) {
  const parsed = Number(options.authReadyTimeoutMs || env.WA_AUTH_READY_TIMEOUT_MS || env.WHATSAPP_AUTH_READY_TIMEOUT_MS || 180_000);
  return Number.isFinite(parsed) ? Math.max(30_000, parsed) : 180_000;
}

export function localWhatsAppReadyFallbackEligible(state = {}) {
  if (state.ready || !state.authenticated) return false;
  const percent = Number(state.loadingPercent ?? 0);
  if (percent >= 100) return true;
  const message = String(state.loadingMessage || "").trim().toLowerCase();
  return percent >= 99 && message === "whatsapp";
}

function safeFilePart(value = "", fallback = "attachment") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[/\\]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return cleaned || fallback;
}

function extensionForMime(mimetype = "") {
  const normalized = String(mimetype || "").toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("gif")) return ".gif";
  if (normalized.includes("pdf")) return ".pdf";
  if (normalized.includes("ogg")) return ".ogg";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return ".mp3";
  if (normalized.includes("mp4")) return ".mp4";
  if (normalized.includes("csv")) return ".csv";
  if (normalized.includes("json")) return ".json";
  if (normalized.includes("plain")) return ".txt";
  return ".bin";
}

async function saveInboundMedia(accountId, message, env = process.env) {
  if (!message?.hasMedia || typeof message.downloadMedia !== "function") return [];
  let media = null;
  try {
    media = await message.downloadMedia();
  } catch (error) {
    await appendEvent({
      type: "whatsapp_local_inbound_media_download_failed",
      accountId,
      eventId: String(message.id?._serialized || ""),
      error: error.message || String(error),
    }, env).catch(() => {});
    return [];
  }
  if (!media?.data) return [];
  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(inboundMediaRoot(env), date);
  await fs.mkdir(outDir, { recursive: true });
  const eventId = safeFilePart(String(message.id?._serialized || `${accountId}-${Date.now()}`), "message");
  const originalName = safeFilePart(media.filename || message._data?.filename || "", "");
  const ext = path.extname(originalName) || extensionForMime(media.mimetype);
  const baseName = originalName
    ? `${eventId}-${originalName}`
    : `${eventId}-attachment${ext}`;
  const filePath = path.join(outDir, baseName);
  await fs.writeFile(filePath, Buffer.from(media.data, "base64"));
  return [{
    path: filePath,
    filename: originalName || path.basename(filePath),
    mimetype: media.mimetype || "",
    kind: message.type || "",
    size: Buffer.byteLength(media.data, "base64"),
  }];
}

function attachmentSummaryText(attachments = []) {
  if (!attachments.length) return "";
  return [
    "WhatsApp attachment received.",
    ...attachments.map((attachment, index) => [
      `Attachment ${index + 1}: ${attachment.path}`,
      attachment.filename ? `filename: ${attachment.filename}` : "",
      attachment.mimetype ? `mimetype: ${attachment.mimetype}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}

function inboundRoutingFailureNoticeText(error) {
  const reason = String(error?.message || error || "routing_failed").trim();
  if (reason === "llm_sanitizer_unconfigured") {
    return "Orkestr could not accept your message because the isolated-user LLM sanitizer is not configured. Ask the admin to connect the sanitizer, then resend.";
  }
  if (reason.startsWith("llm_sanitizer")) {
    return `Orkestr could not accept your message because the isolated-user LLM sanitizer blocked or could not verify it: ${reason}.`;
  }
  if (reason === "whatsapp_target_required") {
    return "Orkestr could not route your message because this WhatsApp chat is not connected to a thread.";
  }
  return `Orkestr could not route your message: ${reason}.`;
}

async function sendInboundRoutingFailureNotice({ accountId = "", chatId = "", eventId = "", error = null, client = null, env = process.env } = {}) {
  const selectedAccountId = String(accountId || "").trim();
  const id = String(chatId || "").trim();
  const sourceEventId = String(eventId || "").trim();
  if (!selectedAccountId || !id || !sourceEventId) return { sent: false, reason: "missing_target" };
  if (hasInboundFailureNotice(selectedAccountId, sourceEventId)) return { sent: false, reason: "already_notified" };
  const text = inboundRoutingFailureNoticeText(error);
  rememberInboundFailureNotice(selectedAccountId, sourceEventId);
  try {
    if (client) {
      rememberOutboundText(selectedAccountId, id, text);
      const message = await sendWhatsAppTextWithConfirmation({ client, chatId: id, text });
      rememberOutboundMessageId(serializedMessageId(message));
    } else {
      await sendLocalWhatsAppText({ accountId: selectedAccountId, chatId: id, text, env });
    }
    await appendEvent({
      type: "whatsapp_local_inbound_failure_notice_delivered",
      accountId: selectedAccountId,
      eventId: sourceEventId,
      chatId: id,
      reason: String(error?.message || error || ""),
    }, env).catch(() => {});
    return { sent: true };
  } catch (noticeError) {
    await appendEvent({
      type: "whatsapp_local_inbound_failure_notice_failed",
      accountId: selectedAccountId,
      eventId: sourceEventId,
      chatId: id,
      reason: String(error?.message || error || ""),
      error: noticeError?.message || String(noticeError),
    }, env).catch(() => {});
    return { sent: false, reason: noticeError?.message || String(noticeError) };
  }
}

async function clearQr(accountId, env = process.env) {
  await fs.unlink(qrPath(accountId, env)).catch(() => {});
}

async function writeQr(accountId, qr, qrcode, env = process.env) {
  await ensureBridgeDirs(env);
  const svg = await qrcode.toString(qr, { type: "svg", margin: 1, width: 320 });
  await fs.writeFile(qrPath(accountId, env), svg);
}

async function handleInboundMessage(accountId, message, env = process.env, options = {}) {
  const fromMe = Boolean(message?.fromMe);
  if (options.ownOnly && !fromMe) return { skipped: "not_own_message" };
  if (message?.isStatus) return { skipped: "status_message" };
  const text = String(message?.body || "").trim();
  const attachments = await saveInboundMedia(accountId, message, env).catch((error) => {
    void appendEvent({
      type: "whatsapp_local_inbound_media_save_failed",
      accountId,
      eventId: String(message?.id?._serialized || ""),
      error: error.message || String(error),
    }, env).catch(() => {});
    return [];
  });
  if (!text && !attachments.length) return { skipped: "empty_message" };
  const { chatId, from, fromMe: routeFromMe } = localWhatsAppMessageRouteFields(message);
  const eventId = String(message.id?._serialized || `${accountId}:${chatId}:${message.timestamp || Date.now()}`).trim();
  if (fromMe && outboundMessageIds.has(eventId)) return { skipped: "outbound_echo_id", eventId, chatId };
  if (fromMe && outboundMessageTextKeys.has(textKey(accountId, chatId, text))) return { skipped: "outbound_echo_text", eventId, chatId };
  const routedText = text || attachmentSummaryText(attachments);
  try {
    const { deliverWhatsAppReplies, routeWhatsAppInbound } = await import("./whatsapp.js");
    const routed = await routeWhatsAppInbound(
      {
        eventId,
        chatId,
        from,
        accountId,
        fromMe: routeFromMe,
        text: routedText,
        attachments,
        timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : nowIso(),
      },
      env,
    );
    if (routed.threadId && !routed.duplicate) {
      await deliverWhatsAppReplies(env).catch(() => {});
      requestThreadInputDelivery(routed.threadId, env);
    }
    return { routed, eventId, chatId, from, fromMe: routeFromMe };
  } catch (error) {
    const notice = await sendInboundRoutingFailureNotice({
      accountId,
      chatId,
      eventId,
      error,
      client: options.client || null,
      env,
    }).catch((noticeError) => ({ sent: false, reason: noticeError?.message || String(noticeError) }));
    await appendEvent(
      {
        type: "whatsapp_local_inbound_failed",
        accountId,
        eventId,
        chatId,
        from,
        fromMe: routeFromMe,
        error: error.message || String(error),
        noticeSent: notice?.sent === true,
      },
      env,
    );
    return { error: error.message || String(error), eventId, chatId, from, fromMe: routeFromMe, noticeSent: notice?.sent === true };
  }
}

export async function recoverLocalWhatsAppChatMessages({ accountId = "", chatId = "", limit = 20, unreadOnly = true, markSeen = true } = {}, env = process.env) {
  return recoverLocalWhatsAppChatMessagesWithClient({ accountId, chatId, limit, unreadOnly, markSeen }, env);
}

async function recoverLocalWhatsAppChatMessagesWithClient({ accountId = "", chatId = "", limit = 20, unreadOnly = true, markSeen = true } = {}, env = process.env, options = {}) {
  const normalized = normalizeAccountId(accountId, env);
  const id = String(chatId || "").trim();
  if (!id) {
    const error = new Error("whatsapp_chat_id_required");
    error.statusCode = 400;
    throw error;
  }
  const client = options.client || runtimes.get(normalized)?.client;
  const state = options.state || accountStates.get(normalized) || defaultAccountState(normalized);
  if (!client || !state.ready) {
    return { ok: false, accountId: normalized, chatId: id, ready: false, state: state.state || "idle", routed: [], skipped: [] };
  }
  const chat = options.chat || await client.getChatById(id);
  const fetchLimit = Math.max(1, Math.min(100, Number(limit || 20) || 20));
  const messages = await chat.fetchMessages({ limit: fetchLimit });
  const unreadCount = Number(chat?.unreadCount || 0) || 0;
  const candidates = unreadOnly && unreadCount > 0
    ? messages.slice(-Math.min(unreadCount, messages.length))
    : messages;
  const routed = [];
  const skipped = [];
  for (const message of candidates) {
    const eventId = String(message?.id?._serialized || "").trim();
    if (message?.fromMe) {
      skipped.push({ eventId, reason: "from_me" });
      continue;
    }
    const result = await handleInboundMessage(normalized, message, env, { client });
    if (result?.routed?.threadId && !result.routed.duplicate) routed.push({ eventId, threadId: result.routed.threadId, messageId: result.routed.messageId });
    else skipped.push({ eventId, reason: result?.routed?.duplicate ? "duplicate" : result?.skipped || result?.error || "not_routed", noticeSent: result?.noticeSent === true });
  }
  const notifiedFailures = skipped.filter((entry) => entry.noticeSent === true).length;
  if (markSeen && (routed.length || notifiedFailures) && typeof chat.sendSeen === "function") await chat.sendSeen().catch(() => {});
  await appendEvent({
    type: "whatsapp_local_chat_recovered",
    accountId: normalized,
    chatId: id,
    unreadOnly: unreadOnly !== false,
    unreadCount,
    fetched: messages.length,
    candidates: candidates.length,
    routed: routed.length,
    skipped: skipped.length,
  }, env).catch(() => {});
  return { ok: true, accountId: normalized, chatId: id, unreadCount, fetched: messages.length, candidates: candidates.length, routed, skipped };
}

function localWhatsAppUnreadRecoveryEnabled(env = process.env) {
  const raw = String(env.ORKESTR_WHATSAPP_UNREAD_RECOVERY || env.WHATSAPP_LOCAL_UNREAD_RECOVERY || "1").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

export function localWhatsAppUnreadRecoveryIntervalMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_UNREAD_RECOVERY_MS || env.WHATSAPP_LOCAL_UNREAD_RECOVERY_MS || 30_000);
  return Number.isFinite(parsed) ? Math.max(10_000, parsed) : 30_000;
}

function localWhatsAppUnreadRecoveryFetchLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_UNREAD_RECOVERY_FETCH_LIMIT || env.WHATSAPP_LOCAL_UNREAD_RECOVERY_FETCH_LIMIT || 20);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 20;
}

function localWhatsAppUnreadRecoveryMaxChats(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_UNREAD_RECOVERY_MAX_CHATS || env.WHATSAPP_LOCAL_UNREAD_RECOVERY_MAX_CHATS || 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 10;
}

function bindingAccountIds(binding = {}) {
  return [binding.senderAccountId, binding.responderAccountId, binding.outboundAccountId]
    .map((candidate) => String(candidate || "").trim())
    .filter(Boolean);
}

export function localWhatsAppUnreadRecoveryBoundChats(threads = [], accountId = "", env = process.env) {
  const selectedAccountId = normalizeAccountId(accountId, env);
  const byChatId = new Map();
  for (const thread of Array.isArray(threads) ? threads : []) {
    const binding = thread?.binding || {};
    if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") continue;
    if (binding.enabled === false) continue;
    const chatId = String(binding.chatId || "").trim();
    if (!chatId) continue;
    const accounts = bindingAccountIds(binding);
    if (accounts.length && !accounts.some((candidate) => localAccountMatches(candidate, selectedAccountId, env))) continue;
    byChatId.set(chatId, {
      chatId,
      threadId: String(thread?.id || "").trim(),
      accountId: selectedAccountId,
    });
  }
  return [...byChatId.values()];
}

function optionMapLookup(collection, key) {
  if (!collection) return undefined;
  if (collection instanceof Map) return collection.get(key);
  return collection[key];
}

async function recoverUnreadLocalWhatsAppMessagesOnce(env = process.env, options = {}) {
  const accountIds = options.accountIds || localWhatsAppAccountIdsForEnv(env);
  const threads = options.threads || await listThreads(env).catch(() => []);
  const maxChats = localWhatsAppUnreadRecoveryMaxChats(env);
  const limit = Number(options.limit || localWhatsAppUnreadRecoveryFetchLimit(env));
  const checked = [];
  const recovered = [];
  const skipped = [];
  const failed = [];
  for (const accountId of accountIds) {
    const normalized = normalizeAccountId(accountId, env);
    const state = optionMapLookup(options.accountStates, normalized) || accountStates.get(normalized) || defaultAccountState(normalized);
    const client = optionMapLookup(options.clients, normalized) || optionMapLookup(options.runtimes, normalized)?.client || runtimes.get(normalized)?.client;
    const boundChats = localWhatsAppUnreadRecoveryBoundChats(threads, normalized, env);
    checked.push({ accountId: normalized, boundChats: boundChats.length, ready: Boolean(client && state.ready) });
    if (!boundChats.length) continue;
    if (!client || !state.ready) {
      skipped.push({ accountId: normalized, reason: "not_ready" });
      continue;
    }
    let chats = [];
    try {
      chats = optionMapLookup(options.chatsByAccount, normalized) || await client.getChats();
    } catch (error) {
      failed.push({ accountId: normalized, reason: "list_chats_failed", error: error?.message || String(error) });
      continue;
    }
    const boundIds = new Set(boundChats.map((chat) => chat.chatId));
    const unreadChats = (Array.isArray(chats) ? chats : [])
      .map((chat) => ({
        chat,
        chatId: String(chat?.id?._serialized || chat?.id || "").trim(),
        unreadCount: Number(chat?.unreadCount || 0) || 0,
      }))
      .filter((entry) => entry.chatId && boundIds.has(entry.chatId) && entry.unreadCount > 0)
      .slice(0, maxChats);
    if (!unreadChats.length) continue;
    for (const entry of unreadChats) {
      try {
        const result = await recoverLocalWhatsAppChatMessagesWithClient({
          accountId: normalized,
          chatId: entry.chatId,
          limit,
          unreadOnly: true,
          markSeen: true,
        }, env, { client, state, chat: entry.chat });
        recovered.push(result);
      } catch (error) {
        failed.push({ accountId: normalized, chatId: entry.chatId, error: error?.message || String(error) });
      }
    }
  }
  const routed = recovered.reduce((count, result) => count + Number(result?.routed?.length || 0), 0);
  if (recovered.length || failed.length) {
    await appendEvent({
      type: "whatsapp_local_unread_recovery_checked",
      checked: checked.length,
      recovered: recovered.length,
      routed,
      failed: failed.length,
    }, env).catch(() => {});
  }
  return { enabled: true, checked, recovered, routed, skipped, failed };
}

export async function recoverUnreadLocalWhatsAppMessages(env = process.env, options = {}) {
  if (!localWhatsAppUnreadRecoveryEnabled(env) && !options.force) {
    return { enabled: false, checked: [], recovered: [], routed: 0, skipped: [], failed: [] };
  }
  const nowMs = Number(options.nowMs || Date.now());
  const intervalMs = localWhatsAppUnreadRecoveryIntervalMs(env);
  if (!options.force && localWhatsAppUnreadRecoveryLastRunMs && nowMs - localWhatsAppUnreadRecoveryLastRunMs < intervalMs) {
    return { enabled: true, checked: [], recovered: [], routed: 0, skipped: [{ reason: "cooldown", intervalMs }], failed: [] };
  }
  if (localWhatsAppUnreadRecoveryInFlight) return localWhatsAppUnreadRecoveryInFlight;
  localWhatsAppUnreadRecoveryLastRunMs = nowMs;
  localWhatsAppUnreadRecoveryInFlight = recoverUnreadLocalWhatsAppMessagesOnce(env, options).finally(() => {
    localWhatsAppUnreadRecoveryInFlight = null;
  });
  return localWhatsAppUnreadRecoveryInFlight;
}

function localWhatsAppAutostartEnabled(env = process.env) {
  const raw = String(env.ORKESTR_WHATSAPP_AUTOSTART || env.WHATSAPP_LOCAL_AUTOSTART || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function localWhatsAppAutostartAccountIds(env = process.env) {
  if (!localWhatsAppAutostartEnabled(env)) return [];
  const accountIds = splitAccountList(env.ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS || env.WHATSAPP_LOCAL_AUTOSTART_ACCOUNT_IDS);
  return accountIds.length ? accountIds : localWhatsAppAccountIdsForEnv(env);
}

export async function startConfiguredLocalWhatsAppAccounts(env = process.env) {
  if (!localWhatsAppAutostartEnabled(env)) return { enabled: false, accounts: [] };
  const selected = localWhatsAppAutostartAccountIds(env);
  const accounts = await Promise.all(selected.map((accountId) => startLocalWhatsAppAccount(accountId, env)));
  return { enabled: true, accounts };
}

const localWhatsAppRecoveryAttempts = new Map();
const recoverableLocalWhatsAppStates = new Set(["auth_ready_timeout", "disconnected"]);
let localWhatsAppUnreadRecoveryInFlight = null;
let localWhatsAppUnreadRecoveryLastRunMs = 0;

function recoverableLocalWhatsAppFailure(account = {}) {
  const state = String(account?.state || "").trim();
  if (recoverableLocalWhatsAppStates.has(state)) return true;
  if (state !== "failed") return false;
  const error = String(account?.error || "").toLowerCase();
  return error.includes("target closed") ||
    error.includes("runtime.addbinding") ||
    error.includes("browser is already running") ||
    error.includes("userdatadir");
}

function localWhatsAppRecoveryCooldownMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_AUTO_RECOVER_MS || env.WHATSAPP_LOCAL_AUTO_RECOVER_MS || 60_000);
  return Number.isFinite(parsed) ? Math.max(5000, parsed) : 60_000;
}

export function recoverableLocalWhatsAppAccountIds(accounts = [], selectedAccountIds = []) {
  const selected = new Set(selectedAccountIds.map((accountId) => String(accountId || "").trim()).filter(Boolean));
  return accounts
    .filter((account) => {
      const accountId = String(account?.accountId || "").trim();
      return accountId &&
        selected.has(accountId) &&
        account.ready !== true &&
        recoverableLocalWhatsAppFailure(account);
    })
    .map((account) => String(account.accountId).trim());
}

export async function recoverConfiguredLocalWhatsAppAccounts(env = process.env, options = {}) {
  const selected = localWhatsAppAutostartAccountIds(env);
  if (!selected.length) return { enabled: false, recovered: [], skipped: [] };
  const status = options.status || await getLocalWhatsAppBridgeStatus(env);
  const candidates = recoverableLocalWhatsAppAccountIds(status.accounts || [], selected);
  const cooldownMs = localWhatsAppRecoveryCooldownMs(env);
  const nowMs = Number(options.nowMs || Date.now());
  const recovered = [];
  const skipped = [];
  for (const accountId of candidates) {
    const lastAttemptMs = Number(localWhatsAppRecoveryAttempts.get(accountId) || 0);
    if (!options.force && lastAttemptMs && nowMs - lastAttemptMs < cooldownMs) {
      skipped.push({ accountId, reason: "cooldown" });
      continue;
    }
    localWhatsAppRecoveryAttempts.set(accountId, nowMs);
    await appendEvent({ type: "whatsapp_local_auto_recover_start", accountId }, env).catch(() => {});
    try {
      const account = await startLocalWhatsAppAccount(accountId, env, options.startOptions || {});
      recovered.push({ accountId, state: account.state, ready: account.ready === true });
      await appendEvent({ type: "whatsapp_local_auto_recover_started", accountId, state: account.state, ready: account.ready === true }, env).catch(() => {});
    } catch (error) {
      skipped.push({ accountId, reason: error?.message || String(error) });
      await appendEvent({ type: "whatsapp_local_auto_recover_failed", accountId, error: error?.message || String(error) }, env).catch(() => {});
    }
  }
  return { enabled: true, recovered, skipped };
}

export async function startLocalWhatsAppAccount(accountId = "", env = process.env, options = {}) {
  const normalized = normalizeAccountId(accountId, env);
  if (runtimes.has(normalized)) return accountSnapshot(normalized, env);

  const pairingPhoneNumber = normalizePairingPhoneNumber(options.phoneNumber);
  if (options.phoneNumber && !pairingPhoneNumber) {
    const error = new Error("whatsapp_pairing_phone_number_invalid");
    error.statusCode = 400;
    throw error;
  }
  await ensureBridgeDirs(env);
  setAccountState(normalized, {
    state: "starting",
    started: true,
    ready: false,
    pairingCode: "",
    pairingCodeUpdatedAt: null,
    pairingPhoneNumber: maskPairingPhoneNumber(pairingPhoneNumber),
    error: "",
  });

  let dependencies;
  try {
    dependencies = await loadBridgeDependencies();
  } catch (error) {
    setAccountState(normalized, {
      state: "dependency_missing",
      started: false,
      error: "Install whatsapp-web.js and qrcode dependencies before starting the local bridge.",
    });
    await appendEvent({ type: "whatsapp_local_dependency_missing", accountId: normalized, error: error.message || String(error) }, env);
    return accountSnapshot(normalized, env);
  }

  const { Client, LocalAuth } = dependencies.whatsapp;
  const authTimeoutMs = authReadyTimeoutMs(env, options);
  let authReadyTimer = null;
  const clearAuthReadyTimer = () => {
    if (!authReadyTimer) return;
    clearTimeout(authReadyTimer);
    authReadyTimer = null;
  };
  const scheduleAuthReadyTimer = () => {
    clearAuthReadyTimer();
    authReadyTimer = setTimeout(() => {
      void handleAuthReadyTimeout();
    }, authTimeoutMs);
    if (typeof authReadyTimer.unref === "function") authReadyTimer.unref();
  };
  const handleAuthReadyTimeout = async () => {
    const state = accountStates.get(normalized) || defaultAccountState(normalized);
    if (state.ready || state.state !== "authenticated") return;
    const message = `WhatsApp authenticated but did not become ready within ${Math.round(authTimeoutMs / 1000)}s. Restart the bridge or re-link the device.`;
    setAccountState(normalized, {
      state: "auth_ready_timeout",
      ready: false,
      authenticated: true,
      started: false,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      error: message,
    });
    runtimes.delete(normalized);
    await clearQr(normalized, env).catch(() => {});
    await appendEvent({
      type: "whatsapp_local_auth_ready_timeout",
      accountId: normalized,
      timeoutMs: authTimeoutMs,
      waState: state.waState || "",
      loadingPercent: state.loadingPercent ?? null,
      loadingMessage: state.loadingMessage || "",
    }, env).catch(() => {});
    await client.destroy().catch(() => {});
  };
  let readyFallbackTriggered = false;
  let readyFallbackTimer = null;
  const clearReadyFallbackTimer = () => {
    if (!readyFallbackTimer) return;
    clearTimeout(readyFallbackTimer);
    readyFallbackTimer = null;
  };
  const triggerReadyFallback = async (reason) => {
    const state = accountStates.get(normalized) || defaultAccountState(normalized);
    if (readyFallbackTriggered || state.ready || !state.authenticated) return;
    readyFallbackTriggered = true;
    try {
      const result = await client.pupPage?.evaluate(async () => {
        if (typeof window.onAppStateHasSyncedEvent !== "function") {
          return { ok: false, reason: "callback_missing", title: document.title, wwebjs: typeof window.WWebJS };
        }
        await window.onAppStateHasSyncedEvent();
        return { ok: true, title: document.title, wwebjs: typeof window.WWebJS };
      });
      await appendEvent({
        type: "whatsapp_local_ready_fallback_triggered",
        accountId: normalized,
        reason: String(reason || ""),
        ok: result?.ok === true,
        fallbackReason: String(result?.reason || ""),
        wwebjs: String(result?.wwebjs || ""),
      }, env).catch(() => {});
      if (result?.ok !== true) readyFallbackTriggered = false;
    } catch (error) {
      readyFallbackTriggered = false;
      await appendEvent({
        type: "whatsapp_local_ready_fallback_failed",
        accountId: normalized,
        reason: String(reason || ""),
        error: error?.message || String(error),
      }, env).catch(() => {});
    }
  };
  const scheduleReadyFallback = (reason) => {
    const state = accountStates.get(normalized) || defaultAccountState(normalized);
    if (readyFallbackTriggered || state.ready || !state.authenticated) return;
    if (!localWhatsAppReadyFallbackEligible(state)) return;
    clearReadyFallbackTimer();
    readyFallbackTimer = setTimeout(() => {
      readyFallbackTimer = null;
      void triggerReadyFallback(reason);
    }, 3000);
    if (typeof readyFallbackTimer.unref === "function") readyFallbackTimer.unref();
  };
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: clientIdForAccount(normalized, env), dataPath: sessionRootForAccount(normalized, env) }),
    puppeteer: puppeteerOptions(env),
    userAgent: whatsappUserAgent(env),
    webVersionCache: {
      type: "local",
      path: webCacheRoot(env),
    },
    ...(pairingPhoneNumber
      ? {
          pairWithPhoneNumber: {
            phoneNumber: pairingPhoneNumber,
            showNotification: options.showNotification !== false,
            intervalMs: Number(options.intervalMs || 180000) || 180000,
          },
        }
      : {}),
  });

  client.on("qr", async (qr) => {
    try {
      await writeQr(normalized, qr, dependencies.qrcode, env);
      setAccountState(normalized, {
        state: "qr_needed",
        ready: false,
        authenticated: false,
        started: true,
        qrAvailable: true,
        pairingCode: "",
        pairingCodeUpdatedAt: null,
        error: "",
      });
      await appendEvent({ type: "whatsapp_local_qr_ready", accountId: normalized }, env);
    } catch (error) {
      setAccountState(normalized, { state: "failed", error: error.message || String(error) });
      await appendEvent({ type: "whatsapp_local_qr_failed", accountId: normalized, error: error.message || String(error) }, env);
    }
  });

  client.on("code", async (code) => {
    setAccountState(normalized, {
      state: "pairing_code",
      ready: false,
      authenticated: false,
      started: true,
      qrAvailable: false,
      pairingCode: String(code || "").trim(),
      pairingCodeUpdatedAt: nowIso(),
      error: "",
    });
    await appendEvent({ type: "whatsapp_local_pairing_code_ready", accountId: normalized }, env);
  });

  client.on("authenticated", async () => {
    setAccountState(normalized, {
      state: "authenticated",
      authenticated: true,
      authenticatedAt: nowIso(),
      started: true,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      error: "",
    });
    scheduleAuthReadyTimer();
    scheduleReadyFallback("authenticated");
    await appendEvent({ type: "whatsapp_local_authenticated", accountId: normalized }, env);
  });

  client.on("ready", async () => {
    clearAuthReadyTimer();
    clearReadyFallbackTimer();
    await clearQr(normalized, env);
    setAccountState(normalized, {
      state: "ready",
      ready: true,
      authenticated: true,
      started: true,
      qrAvailable: false,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      loadingPercent: null,
      loadingMessage: "",
      error: "",
    });
    await appendEvent({ type: "whatsapp_local_ready", accountId: normalized }, env);
  });

  client.on("auth_failure", async (message) => {
    clearAuthReadyTimer();
    clearReadyFallbackTimer();
    setAccountState(normalized, {
      state: "auth_failure",
      ready: false,
      authenticated: false,
      started: false,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      error: String(message || "WhatsApp authentication failed."),
    });
    runtimes.delete(normalized);
    await appendEvent({ type: "whatsapp_local_auth_failure", accountId: normalized }, env);
  });

  client.on("disconnected", async (reason) => {
    clearAuthReadyTimer();
    clearReadyFallbackTimer();
    const current = accountStates.get(normalized) || defaultAccountState(normalized);
    if (["auth_failure", "auth_ready_timeout", "failed"].includes(current.state)) {
      runtimes.delete(normalized);
      await appendEvent({ type: "whatsapp_local_disconnected_after_failure", accountId: normalized, reason: String(reason || "") }, env);
      return;
    }
    setAccountState(normalized, {
      state: "disconnected",
      ready: false,
      authenticated: false,
      started: false,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      error: String(reason || ""),
    });
    runtimes.delete(normalized);
    await appendEvent({ type: "whatsapp_local_disconnected", accountId: normalized, reason: String(reason || "") }, env);
  });

  client.on("loading_screen", async (percent, message) => {
    setAccountState(normalized, {
      loadingPercent: Number(percent),
      loadingMessage: String(message || ""),
    });
    scheduleReadyFallback("loading_screen");
    await appendEvent({
      type: "whatsapp_local_loading_screen",
      accountId: normalized,
      percent: Number(percent),
      message: String(message || ""),
    }, env).catch(() => {});
  });

  client.on("change_state", async (state) => {
    setAccountState(normalized, { waState: String(state || "") });
    await appendEvent({ type: "whatsapp_local_state_changed", accountId: normalized, state: String(state || "") }, env).catch(() => {});
  });

  client.on("error", async (error) => {
    clearAuthReadyTimer();
    clearReadyFallbackTimer();
    setAccountState(normalized, {
      state: "failed",
      ready: false,
      authenticated: false,
      started: false,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      error: error?.message || String(error),
    });
    runtimes.delete(normalized);
    await appendEvent({ type: "whatsapp_local_client_error", accountId: normalized, error: error?.message || String(error) }, env).catch(() => {});
    await client.destroy().catch(() => {});
  });

  client.on("message", (message) => {
    void handleInboundMessage(normalized, message, env, { client });
  });

  client.on("message_create", (message) => {
    void handleInboundMessage(normalized, message, env, { ownOnly: true, client });
  });

  const initializePromise = client.initialize().catch(async (error) => {
    clearAuthReadyTimer();
    clearReadyFallbackTimer();
    await client.destroy().catch(() => {});
    setAccountState(normalized, {
      state: "failed",
      ready: false,
      authenticated: false,
      started: false,
      error: error.message || String(error),
    });
    runtimes.delete(normalized);
    await appendEvent({ type: "whatsapp_local_start_failed", accountId: normalized, error: error.message || String(error) }, env);
  });
  runtimes.set(normalized, { client, initializePromise, clearAuthReadyTimer });
  await appendEvent({ type: "whatsapp_local_start_requested", accountId: normalized }, env);
  return accountSnapshot(normalized, env);
}

export async function logoutLocalWhatsAppAccount(accountId = "", env = process.env) {
  const normalized = normalizeAccountId(accountId, env);
  for (const session of [...typingSessions.values()].filter((item) => item.accountId === normalized)) {
    await stopLocalWhatsAppTyping({ accountId: session.accountId, chatId: session.chatId, env }).catch(() => {});
  }
  for (const key of [...typingClearRetryTimers.keys()].filter((item) => item.startsWith(`${normalized}:`))) {
    clearTypingClearRetryTimers(key);
  }
  const runtime = runtimes.get(normalized);
  if (runtime?.client) {
    runtime.clearAuthReadyTimer?.();
    await runtime.client.logout().catch(() => {});
    await runtime.client.destroy().catch(() => {});
  }
  runtimes.delete(normalized);
  await clearQr(normalized, env);
  setAccountState(normalized, {
    state: "idle",
    ready: false,
    authenticated: false,
    started: false,
    qrAvailable: false,
    pairingCode: "",
    pairingCodeUpdatedAt: null,
    pairingPhoneNumber: "",
    authenticatedAt: null,
    loadingPercent: null,
    loadingMessage: "",
    waState: "",
    error: "",
  });
  await appendEvent({ type: "whatsapp_local_logged_out", accountId: normalized }, env);
  return accountSnapshot(normalized, env);
}

export async function stopLocalWhatsAppBridge(env = process.env) {
  const entries = [...runtimes.entries()];
  for (const session of [...typingSessions.values()]) {
    if (session?.interval) clearInterval(session.interval);
  }
  typingSessions.clear();
  for (const key of [...typingClearRetryTimers.keys()]) clearTypingClearRetryTimers(key);
  runtimes.clear();
  await Promise.all(entries.map(async ([accountId, runtime]) => {
    if (runtime?.client) {
      runtime.clearAuthReadyTimer?.();
      await runtime.client.destroy().catch(() => {});
    }
    await clearQr(accountId, env).catch(() => {});
    setAccountState(accountId, {
      state: "idle",
      ready: false,
      authenticated: false,
      started: false,
      qrAvailable: false,
      pairingCode: "",
      pairingCodeUpdatedAt: null,
      authenticatedAt: null,
      loadingPercent: null,
      loadingMessage: "",
      waState: "",
      error: "",
    });
  }));
  if (entries.length > 0) {
    await appendEvent({ type: "whatsapp_local_bridge_stopped", accounts: entries.map(([accountId]) => accountId) }, env).catch(() => {});
  }
}

export async function getLocalWhatsAppQrSvg(accountId = "", env = process.env) {
  const normalized = normalizeAccountId(accountId, env);
  return fs.readFile(qrPath(normalized, env), "utf8").catch(() => "");
}

export async function listLocalWhatsAppChats(accountId = "", env = process.env) {
  const normalized = normalizeAccountId(accountId, env);
  const runtime = runtimes.get(normalized);
  const state = accountStates.get(normalized) || defaultAccountState(normalized);
  const knownChats = await knownLocalWhatsAppChats(normalized, env);
  if (!runtime?.client || !state.ready) {
    return {
      accountId: normalized,
      state: state.state || "idle",
      ready: false,
      chats: knownChats,
    };
  }
  const chats = await runtime.client.getChats();
  const merged = new Map();
  for (const chat of knownChats) addChat(merged, chat);
  for (const chat of chats) {
    addChat(merged, {
      id: String(chat?.id?._serialized || ""),
      name: String(chat?.name || chat?.formattedTitle || chat?.id?.user || ""),
      isGroup: Boolean(chat?.isGroup),
      unreadCount: Number(chat?.unreadCount || 0),
      timestamp: chat?.timestamp ? new Date(Number(chat.timestamp) * 1000).toISOString() : null,
      source: "whatsapp_client",
      accountId: normalized,
    });
  }
  return {
    accountId: normalized,
    state: state.state || "ready",
    ready: true,
    chats: [...merged.values()],
  };
}

export async function listLocalWhatsAppChatParticipants({ accountId = "", chatId = "", env = process.env } = {}) {
  const normalized = normalizeAccountId(accountId, env);
  const id = String(chatId || "").trim();
  if (!id) {
    const error = new Error("whatsapp_chat_id_required");
    error.statusCode = 400;
    throw error;
  }
  const runtime = runtimes.get(normalized);
  const state = accountStates.get(normalized) || defaultAccountState(normalized);
  if (!runtime?.client || !state.ready) {
    return { accountId: normalized, chatId: id, ready: false, participants: [] };
  }
  const chat = await runtime.client.getChatById(id);
  const participants = Array.isArray(chat?.participants)
    ? chat.participants.map((participant) => ({
      id: serializedId(participant?.id || participant),
      name: String(participant?.name || participant?.pushname || participant?.shortName || "").trim(),
      isAdmin: Boolean(participant?.isAdmin),
      isSuperAdmin: Boolean(participant?.isSuperAdmin),
    })).filter((participant) => participant.id)
    : [];
  return {
    accountId: normalized,
    chatId: id,
    ready: true,
    participants,
  };
}

/**
 * @param {{ name?: string, senderAccountId?: string, responderAccountId?: string, participantIds?: string[] | string, adminParticipantIds?: string[] | string, promoteParticipantsAsAdmins?: boolean, generatePicture?: boolean, env?: Record<string, string | undefined> }} [options]
 */
export async function createLocalWhatsAppChat({ name = "", senderAccountId = "", responderAccountId = "", participantIds = [], adminParticipantIds = [], promoteParticipantsAsAdmins = false, generatePicture = true, env = process.env } = {}) {
  const title = String(name || "").trim();
  if (!title) {
    const error = new Error("whatsapp_chat_name_required");
    error.statusCode = 400;
    throw error;
  }
  const participants = normalizeGroupParticipantIds(participantIds);
  const adminParticipants = normalizeGroupParticipantIds(adminParticipantIds);
  const responder = normalizeAccountId(responderAccountId || senderAccountId, env);
  const sender = normalizeAccountId(senderAccountId || (participants.length ? responder : ""), env);
  const responderRuntime = runtimes.get(responder);
  const responderState = accountStates.get(responder) || defaultAccountState(responder);
  if (!responderRuntime?.client || !responderState.ready) {
    const error = new Error("whatsapp_responder_account_not_ready");
    error.statusCode = 400;
    throw error;
  }
  const senderRuntime = runtimes.get(sender);
  const senderState = accountStates.get(sender) || defaultAccountState(sender);
  const responderContactId = runtimeIdentity(responderRuntime);
  let senderContactId = sender === responder ? responderContactId : runtimeIdentity(senderRuntime);
  if (participants.length) senderContactId = participants[0];
  if (!senderContactId) {
    const error = new Error(sender === responder ? "whatsapp_account_identity_unavailable" : "whatsapp_sender_account_not_ready");
    error.statusCode = 400;
    throw error;
  }

  let chatId = "";
  let createdGroup = null;
  if (participants.length) {
    createdGroup = await responderRuntime.client.createGroup(title, participants, { announce: false });
    chatId = groupIdFromCreateResult(createdGroup);
  } else if (sender === responder) {
    chatId = senderContactId;
  } else {
    if (!senderState.ready || !senderRuntime?.client) {
      const error = new Error("whatsapp_sender_account_not_ready");
      error.statusCode = 400;
      throw error;
    }
    createdGroup = await responderRuntime.client.createGroup(title, [senderContactId]);
    chatId = groupIdFromCreateResult(createdGroup);
  }
  if (!chatId) {
    const error = new Error("whatsapp_chat_create_failed");
    error.statusCode = 502;
    throw error;
  }
  const promoteIds = normalizeGroupParticipantIds([
    ...(promoteParticipantsAsAdmins ? participants : []),
    ...adminParticipants,
  ]);
  let adminPromotion = null;
  if (promoteIds.length && isGroupChatId(chatId)) {
    adminPromotion = await promoteLocalWhatsAppGroupParticipants({
      accountId: responder,
      chatId,
      participantIds: promoteIds,
      env,
    }).catch((error) => ({ ok: false, error: error?.message || String(error), participantIds: promoteIds }));
  }
  let picture = null;
  if (generatePicture && isGroupChatId(chatId)) {
    try {
      const dependencies = await loadBridgeDependencies();
      picture = await setGeneratedLocalWhatsAppGroupPicture({
        client: responderRuntime.client,
        MessageMedia: dependencies.whatsapp.MessageMedia,
        chatId,
        title,
        accountId: responder,
        env,
      });
    } catch (error) {
      picture = { updated: false, error: error?.message || String(error) };
      await appendEvent({
        type: "whatsapp_chat_picture_generate_error",
        chatId,
        name: title,
        accountId: responder,
        error: picture.error,
      }, env);
    }
  }
  await appendEvent({
    type: "whatsapp_local_chat_created",
    chatId,
    name: title,
    senderAccountId: sender,
    responderAccountId: responder,
    participantIds: participants,
    adminParticipantIds: adminParticipants,
    promotedParticipantIds: promoteIds,
  }, env);
  return {
    ok: true,
    chat: {
      id: chatId,
      name: title,
      isGroup: isGroupChatId(chatId),
      generated: true,
    },
    senderAccountId: sender,
    responderAccountId: responder,
    senderContactId,
    responderContactId,
    participantIds: participants,
    adminParticipantIds: adminParticipants,
    adminPromotion,
    picture,
    bridgeResponse: createdGroup,
  };
}

export async function generateLocalWhatsAppChatPicture({ accountId = "", chatId = "", title = "", env = process.env } = {}) {
  const normalized = normalizeAccountId(accountId, env);
  const id = String(chatId || "").trim();
  if (!id) {
    const error = new Error("whatsapp_chat_id_required");
    error.statusCode = 400;
    throw error;
  }
  if (!isGroupChatId(id)) {
    const error = new Error("whatsapp_group_chat_required");
    error.statusCode = 400;
    throw error;
  }
  const runtime = runtimes.get(normalized);
  const state = accountStates.get(normalized) || defaultAccountState(normalized);
  if (!runtime?.client || !state.ready) {
    const error = new Error("whatsapp_local_bridge_not_ready");
    error.statusCode = 400;
    throw error;
  }
  const chat = await runtime.client.getChatById(id);
  const requestedTitle = String(title || chat?.name || chat?.formattedTitle || id).trim();
  const dependencies = await loadBridgeDependencies();
  const picture = await setGeneratedLocalWhatsAppGroupPicture({
    client: runtime.client,
    MessageMedia: dependencies.whatsapp.MessageMedia,
    chatId: id,
    title: requestedTitle,
    accountId: normalized,
    env,
  });
  return { ok: Boolean(picture.updated), chatId: id, title: requestedTitle, ...picture };
}

/**
 * @param {{ accountId?: string, chatId?: string, participantIds?: string[] | string, env?: Record<string, string | undefined> }} [options]
 */
export async function promoteLocalWhatsAppGroupParticipants({ accountId = "", chatId = "", participantIds = [], env = process.env } = {}) {
  const normalized = normalizeAccountId(accountId, env);
  const id = String(chatId || "").trim();
  const participants = normalizeGroupParticipantIds(participantIds);
  if (!id) {
    const error = new Error("whatsapp_chat_id_required");
    error.statusCode = 400;
    throw error;
  }
  if (!isGroupChatId(id)) {
    const error = new Error("whatsapp_group_chat_required");
    error.statusCode = 400;
    throw error;
  }
  if (!participants.length) {
    const error = new Error("whatsapp_admin_participants_required");
    error.statusCode = 400;
    throw error;
  }
  const runtime = runtimes.get(normalized);
  const state = accountStates.get(normalized) || defaultAccountState(normalized);
  if (!runtime?.client || !state.ready) {
    const error = new Error("whatsapp_local_bridge_not_ready");
    error.statusCode = 400;
    throw error;
  }
  const chat = await runtime.client.getChatById(id);
  if (!chat?.isGroup || typeof chat.promoteParticipants !== "function") {
    const error = new Error("whatsapp_group_chat_required");
    error.statusCode = 400;
    throw error;
  }
  const result = await chat.promoteParticipants(participants);
  await appendEvent({
    type: "whatsapp_local_group_admins_promoted",
    accountId: normalized,
    chatId: id,
    participantIds: participants,
    result,
  }, env).catch(() => {});
  return { ok: true, accountId: normalized, chatId: id, participantIds: participants, result };
}

/**
 * @param {{ chatId?: string, text?: string, accountId?: string, attachments?: Array<Record<string, unknown>>, env?: Record<string, string | undefined> }} [options]
 */
export async function sendLocalWhatsAppMessage({ chatId = "", text = "", accountId = "", attachments = [], env = process.env } = {}) {
  const selectedAccountId = accountId
    ? normalizeAccountId(accountId, env)
    : localWhatsAppAccountIdsForEnv(env).find((id) => accountStates.get(id)?.ready);
  const runtime = selectedAccountId ? runtimes.get(selectedAccountId) : null;
  const state = selectedAccountId ? accountStates.get(selectedAccountId) : null;
  if (!runtime?.client || !state?.ready) {
    const error = new Error("whatsapp_local_bridge_not_ready");
    error.statusCode = 400;
    throw error;
  }
  await stopLocalWhatsAppTyping({ accountId: selectedAccountId, chatId, env }).catch(() => {});
  const sent = [];
  const cleanText = String(text || "");
  if (cleanText.trim()) {
    rememberOutboundText(selectedAccountId, chatId, cleanText);
    const message = await sendWhatsAppTextWithConfirmation({
      client: runtime.client,
      chatId,
      text: cleanText,
    });
    rememberOutboundMessageId(serializedMessageId(message));
    sent.push({
      id: serializedMessageId(message),
      kind: "text",
    });
  }
  const normalizedAttachments = Array.isArray(attachments)
    ? attachments.map((attachment) => ({
        ...attachment,
        path: String(attachment?.path || "").trim(),
      })).filter((attachment) => attachment.path)
    : [];
  if (normalizedAttachments.length) {
    const dependencies = await loadBridgeDependencies();
    const MessageMedia = dependencies.whatsapp.MessageMedia;
    for (const attachment of normalizedAttachments) {
      await fs.access(attachment.path);
      const media = MessageMedia.fromFilePath(attachment.path);
      const message = await runtime.client.sendMessage(chatId, media, {
        sendMediaAsDocument: true,
      });
      rememberOutboundMessageId(message?.id?._serialized);
      sent.push({
        id: String(message?.id?._serialized || ""),
        kind: "attachment",
        path: attachment.path,
        filename: attachment.filename || path.basename(attachment.path),
        mimetype: attachment.mimetype || "",
      });
    }
  }
  if (!sent.length) {
    const error = new Error("whatsapp_message_text_or_attachment_required");
    error.statusCode = 400;
    throw error;
  }
  return {
    ok: true,
    id: sent.map((entry) => entry.id).find(Boolean) || "",
    ids: sent.map((entry) => entry.id).filter(Boolean),
    accountId: selectedAccountId,
    sent,
  };
}

export async function sendLocalWhatsAppText(options = {}) {
  return sendLocalWhatsAppMessage(options);
}
