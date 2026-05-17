import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent } from "../../storage/src/store.js";

export const localWhatsAppAccountIds = ["account-1", "account-2"];
export const localWhatsAppBridgeBasePath = "/api/connectors/whatsapp/bridge";

const runtimes = new Map();
const accountStates = new Map();

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

async function handleInboundMessage(accountId, message, env = process.env) {
  if (message?.fromMe || message?.isStatus) return;
  const text = String(message?.body || "").trim();
  if (!text) return;
  const chatId = String(message.from || message.id?.remote || "").trim();
  const eventId = String(message.id?._serialized || `${accountId}:${chatId}:${message.timestamp || Date.now()}`).trim();
  try {
    const { routeWhatsAppInbound } = await import("./whatsapp.js");
    await routeWhatsAppInbound(
      {
        eventId,
        chatId,
        from: String(message.author || message.from || "").trim(),
        accountId,
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
  if (!runtime?.client || !state.ready) {
    return {
      accountId: normalized,
      state: state.state || "idle",
      ready: false,
      chats: [],
    };
  }
  const chats = await runtime.client.getChats();
  return {
    accountId: normalized,
    state: state.state || "ready",
    ready: true,
    chats: chats.map((chat) => ({
      id: String(chat?.id?._serialized || ""),
      name: String(chat?.name || chat?.formattedTitle || chat?.id?.user || ""),
      isGroup: Boolean(chat?.isGroup),
      unreadCount: Number(chat?.unreadCount || 0),
      timestamp: chat?.timestamp ? new Date(Number(chat.timestamp) * 1000).toISOString() : null,
    })).filter((chat) => chat.id),
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
  const message = await runtime.client.sendMessage(chatId, text);
  return {
    ok: true,
    id: String(message?.id?._serialized || ""),
    accountId: selectedAccountId,
  };
}
