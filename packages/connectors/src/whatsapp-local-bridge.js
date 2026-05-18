import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson } from "../../storage/src/store.js";
import { listThreads } from "../../core/src/threads.js";

export const localWhatsAppAccountIds = ["account-1", "account-2"];
export const localWhatsAppBridgeBasePath = "/api/connectors/whatsapp/bridge";

const runtimes = new Map();
const accountStates = new Map();
const outboundMessageIds = new Set();
const outboundMessageTextKeys = new Set();

function nowIso() {
  return new Date().toISOString();
}

function normalizeAccountId(accountId = "account-1") {
  const normalized = String(accountId || "account-1").trim();
  if (!localWhatsAppAccountIds.includes(normalized)) {
    const error = new Error("unknown_whatsapp_account");
    error.statusCode = 404;
    throw error;
  }
  return normalized;
}

function accountLabel(accountId) {
  return accountId === "account-2" ? "WhatsApp 2" : "WhatsApp 1";
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

async function ensureBridgeDirs(env = process.env) {
  await ensureDataDirs(env);
  await fs.mkdir(path.join(bridgeRoot(env), "qrs"), { recursive: true });
  await fs.mkdir(sessionRoot(env), { recursive: true });
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
    qrAvailable,
    qrUrl: qrAvailable ? qrUrl(accountId) : "",
    started: Boolean(state.started || runtimes.has(accountId)),
  };
}

function reduceBridgeState(accounts) {
  if (accounts.some((account) => account.ready)) return "ready";
  if (accounts.some((account) => account.qrAvailable)) return "qr_needed";
  if (accounts.some((account) => account.state === "starting")) return "starting";
  if (accounts.some((account) => ["auth_failure", "dependency_missing", "failed"].includes(account.state))) return "failed";
  if (accounts.some((account) => account.state === "disconnected")) return "disconnected";
  return "idle";
}

function isGroupChatId(chatId) {
  return /@g\.us$/i.test(String(chatId || "").trim());
}

function localAccountMatches(accountId, selectedAccountId) {
  const account = String(accountId || "").trim();
  if (!account) return true;
  if (!localWhatsAppAccountIds.includes(account)) return true;
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

function serializedId(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  return String(value._serialized || value.user || value.id || "").trim();
}

function runtimeIdentity(runtime) {
  return serializedId(runtime?.client?.info?.wid || runtime?.client?.info?.me);
}

function groupIdFromCreateResult(result) {
  return serializedId(result?.gid || result?.id || result?.chatId || result?.groupId);
}

async function knownLocalWhatsAppChats(accountId, env = process.env) {
  const selectedAccountId = normalizeAccountId(accountId);
  const known = new Map();
  const threads = await listThreads(env).catch(() => []);
  for (const thread of threads) {
    const binding = thread?.binding || {};
    if (String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") continue;
    const chatId = String(binding.chatId || "").trim();
    const accountIds = [binding.senderAccountId, binding.responderAccountId, binding.outboundAccountId]
      .map((candidate) => String(candidate || "").trim())
      .filter(Boolean);
    if (!chatId || (accountIds.length && !accountIds.some((candidate) => localAccountMatches(candidate, selectedAccountId)))) continue;
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
    if (!chatId || !localAccountMatches(event.accountId, selectedAccountId)) continue;
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
    if (!chatId || !localAccountMatches(delivery.accountId, selectedAccountId)) continue;
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
  const accounts = await Promise.all(localWhatsAppAccountIds.map((accountId) => accountSnapshot(accountId, env)));
  const state = reduceBridgeState(accounts);
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
    maxAccounts: localWhatsAppAccountIds.length,
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
  if (options.ownOnly && !fromMe) return;
  if (message?.isStatus) return;
  const text = String(message?.body || "").trim();
  if (!text) return;
  const chatId = String(message.from || message.id?.remote || "").trim();
  const eventId = String(message.id?._serialized || `${accountId}:${chatId}:${message.timestamp || Date.now()}`).trim();
  if (fromMe && outboundMessageIds.has(eventId)) return;
  if (fromMe && outboundMessageTextKeys.has(textKey(accountId, chatId, text))) return;
  try {
    const { routeWhatsAppInbound } = await import("./whatsapp.js");
    await routeWhatsAppInbound(
      {
        eventId,
        chatId,
        from: String(message.author || message.from || "").trim(),
        accountId,
        fromMe,
        text,
        timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : nowIso(),
      },
      env,
    );
  } catch (error) {
    await appendEvent(
      {
        type: "whatsapp_local_inbound_failed",
        accountId,
        error: error.message || String(error),
      },
      env,
    );
  }
}

export async function startLocalWhatsAppAccount(accountId = "account-1", env = process.env) {
  const normalized = normalizeAccountId(accountId);
  if (runtimes.has(normalized)) return accountSnapshot(normalized, env);

  await ensureBridgeDirs(env);
  setAccountState(normalized, { state: "starting", started: true, ready: false, error: "" });

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
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: normalized, dataPath: sessionRoot(env) }),
    puppeteer: puppeteerOptions(env),
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
        error: "",
      });
      await appendEvent({ type: "whatsapp_local_qr_ready", accountId: normalized }, env);
    } catch (error) {
      setAccountState(normalized, { state: "failed", error: error.message || String(error) });
      await appendEvent({ type: "whatsapp_local_qr_failed", accountId: normalized, error: error.message || String(error) }, env);
    }
  });

  client.on("authenticated", async () => {
    setAccountState(normalized, { state: "authenticated", authenticated: true, started: true, error: "" });
    await appendEvent({ type: "whatsapp_local_authenticated", accountId: normalized }, env);
  });

  client.on("ready", async () => {
    await clearQr(normalized, env);
    setAccountState(normalized, {
      state: "ready",
      ready: true,
      authenticated: true,
      started: true,
      qrAvailable: false,
      error: "",
    });
    await appendEvent({ type: "whatsapp_local_ready", accountId: normalized }, env);
  });

  client.on("auth_failure", async (message) => {
    setAccountState(normalized, {
      state: "auth_failure",
      ready: false,
      authenticated: false,
      started: false,
      error: String(message || "WhatsApp authentication failed."),
    });
    runtimes.delete(normalized);
    await appendEvent({ type: "whatsapp_local_auth_failure", accountId: normalized }, env);
  });

  client.on("disconnected", async (reason) => {
    setAccountState(normalized, {
      state: "disconnected",
      ready: false,
      authenticated: false,
      started: false,
      error: String(reason || ""),
    });
    runtimes.delete(normalized);
    await appendEvent({ type: "whatsapp_local_disconnected", accountId: normalized, reason: String(reason || "") }, env);
  });

  client.on("message", (message) => {
    void handleInboundMessage(normalized, message, env);
  });

  client.on("message_create", (message) => {
    void handleInboundMessage(normalized, message, env, { ownOnly: true });
  });

  const initializePromise = client.initialize().catch(async (error) => {
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
  runtimes.set(normalized, { client, initializePromise });
  await appendEvent({ type: "whatsapp_local_start_requested", accountId: normalized }, env);
  return accountSnapshot(normalized, env);
}

export async function logoutLocalWhatsAppAccount(accountId = "account-1", env = process.env) {
  const normalized = normalizeAccountId(accountId);
  const runtime = runtimes.get(normalized);
  if (runtime?.client) {
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
    error: "",
  });
  await appendEvent({ type: "whatsapp_local_logged_out", accountId: normalized }, env);
  return accountSnapshot(normalized, env);
}

export async function getLocalWhatsAppQrSvg(accountId = "account-1", env = process.env) {
  const normalized = normalizeAccountId(accountId);
  return fs.readFile(qrPath(normalized, env), "utf8").catch(() => "");
}

export async function listLocalWhatsAppChats(accountId = "account-1", env = process.env) {
  const normalized = normalizeAccountId(accountId);
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

export async function listLocalWhatsAppChatParticipants({ accountId = "account-1", chatId = "", env = process.env } = {}) {
  const normalized = normalizeAccountId(accountId);
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

export async function createLocalWhatsAppChat({ name = "", senderAccountId = "account-1", responderAccountId = "", env = process.env } = {}) {
  const title = String(name || "").trim();
  if (!title) {
    const error = new Error("whatsapp_chat_name_required");
    error.statusCode = 400;
    throw error;
  }
  const sender = normalizeAccountId(senderAccountId);
  const responder = normalizeAccountId(responderAccountId || sender);
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
  if (!senderContactId) {
    const error = new Error(sender === responder ? "whatsapp_account_identity_unavailable" : "whatsapp_sender_account_not_ready");
    error.statusCode = 400;
    throw error;
  }

  let chatId = "";
  let createdGroup = null;
  if (sender === responder) {
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
  await appendEvent({
    type: "whatsapp_local_chat_created",
    chatId,
    name: title,
    senderAccountId: sender,
    responderAccountId: responder,
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
    bridgeResponse: createdGroup,
  };
}

export async function sendLocalWhatsAppText({ chatId = "", text = "", accountId = "", env = process.env } = {}) {
  const selectedAccountId = accountId ? normalizeAccountId(accountId) : localWhatsAppAccountIds.find((id) => accountStates.get(id)?.ready);
  const runtime = selectedAccountId ? runtimes.get(selectedAccountId) : null;
  const state = selectedAccountId ? accountStates.get(selectedAccountId) : null;
  if (!runtime?.client || !state?.ready) {
    const error = new Error("whatsapp_local_bridge_not_ready");
    error.statusCode = 400;
    throw error;
  }
  rememberOutboundText(selectedAccountId, chatId, text);
  const message = await runtime.client.sendMessage(chatId, text);
  rememberOutboundMessageId(message?.id?._serialized);
  return {
    ok: true,
    id: String(message?.id?._serialized || ""),
    accountId: selectedAccountId,
  };
}
