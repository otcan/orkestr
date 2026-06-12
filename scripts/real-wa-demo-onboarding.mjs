#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requestJson } from "../apps/cli/src/api-client.js";
import { demoPublicSetupUrl, readyMessage } from "./demo-vm-ready-notify.mjs";

function clean(value = "") {
  return String(value || "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function parseBool(value, fallback = false) {
  const text = clean(value).toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function isLocalUrl(value = "") {
  try {
    const parsed = new URL(clean(value));
    return ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    execute: false,
    apiBase: clean(env.ORKESTR_REAL_WA_E2E_API_BASE || env.ORKESTR_API_BASE || "http://127.0.0.1:19812"),
    orkestrHome: clean(env.ORKESTR_REAL_WA_E2E_HOME || env.ORKESTR_HOME),
    chatId: clean(env.ORKESTR_REAL_WA_DEMO_CHAT_ID || env.ORKESTR_REAL_WA_E2E_CHAT_ID),
    responderAccountId: clean(env.ORKESTR_REAL_WA_DEMO_RESPONDER_ACCOUNT || env.ORKESTR_REAL_WA_E2E_RESPONDER_ACCOUNT || "responder"),
    setupUrl: clean(env.ORKESTR_DEMO_PUBLIC_SETUP_URL || env.ORKESTR_DEMO_SETUP_PUBLIC_URL || ""),
    timeoutMs: Number(env.ORKESTR_REAL_WA_E2E_TIMEOUT_MS || 90_000),
    pollMs: Number(env.ORKESTR_REAL_WA_E2E_POLL_MS || 2000),
    artifactPath: clean(env.ORKESTR_REAL_WA_DEMO_ARTIFACT || env.ORKESTR_REAL_WA_E2E_ARTIFACT),
    skipPreflight: parseBool(env.ORKESTR_REAL_WA_DEMO_SKIP_PREFLIGHT, false),
    allowLocalSetupUrl: parseBool(env.ORKESTR_DEMO_ALLOW_LOCAL_SETUP_URL || env.ORKESTR_REAL_WA_DEMO_ALLOW_LOCAL_SETUP_URL, false),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--api-base") options.apiBase = clean(argv[++index]);
    else if (arg === "--orkestr-home") options.orkestrHome = clean(argv[++index]);
    else if (arg === "--chat-id") options.chatId = clean(argv[++index]);
    else if (arg === "--responder-account") options.responderAccountId = clean(argv[++index]);
    else if (arg === "--setup-url") options.setupUrl = clean(argv[++index]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index] || 0);
    else if (arg === "--poll-ms") options.pollMs = Number(argv[++index] || 0);
    else if (arg === "--artifact") options.artifactPath = clean(argv[++index]);
    else if (arg === "--skip-preflight") options.skipPreflight = true;
    else if (arg === "--allow-local-setup-url") options.allowLocalSetupUrl = true;
    else throw new Error(`unknown_arg:${arg}`);
  }

  if (options.help || !options.execute) return options;
  if (!options.apiBase) throw new Error("api_base_required");
  if (!options.chatId) throw new Error("chat_id_required");
  if (!options.responderAccountId) throw new Error("responder_account_required");
  if (options.setupUrl && isLocalUrl(options.setupUrl) && !options.allowLocalSetupUrl) throw new Error("setup_url_must_not_be_local");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10_000) throw new Error("invalid_timeout_ms");
  if (!Number.isFinite(options.pollMs) || options.pollMs < 250) throw new Error("invalid_poll_ms");
  return options;
}

function usage() {
  return [
    "Usage: npm run e2e:whatsapp-demo-onboarding -- --execute [options]",
    "",
    "Runs the demo onboarding acceptance path: Orkestr sends the first WhatsApp",
    "message from the serving/responder account to the target user and asks them",
    "to complete Codex login/sign-in in setup.",
    "",
    "Required with --execute:",
    "  --chat-id ID             Responder-side direct WhatsApp chat id for the target user.",
    "",
    "Common options:",
    "  --api-base URL           Orkestr API base. Default: ORKESTR_API_BASE or localhost.",
    "  --orkestr-home DIR       Lets the API client use local CLI auth for that instance.",
    "  --responder-account ID   WA account that Orkestr uses to send. Default: responder.",
    "  --setup-url URL          Public setup/pairing URL included in the prompt after broker registration.",
    "  --allow-local-setup-url  Unsafe test-only override for localhost setup URLs.",
    "  --artifact FILE          Write JSON result details.",
    "",
    "The default run refuses to send real WhatsApp messages without --execute.",
  ].join("\n");
}

function apiEnv(options) {
  const tunnelTarget = clean(process.env.ORKESTR_DEMO_TUNNEL_TARGET_URL) || clean(options.apiBase);
  return {
    ...process.env,
    ...(options.orkestrHome ? { ORKESTR_HOME: options.orkestrHome } : {}),
    ...(tunnelTarget ? { ORKESTR_DEMO_TUNNEL_TARGET_URL: tunnelTarget } : {}),
  };
}

function sameOrigin(left = "", right = "") {
  try {
    return new URL(clean(left)).origin === new URL(clean(right)).origin;
  } catch {
    return false;
  }
}

async function api(options, route, request = {}) {
  return requestJson(route, {
    ...request,
    baseUrl: options.apiBase,
    env: apiEnv(options),
  });
}

function authenticatedFetchForApi(options) {
  return async (url, request = {}) => {
    const parsed = new URL(String(url));
    if (!sameOrigin(parsed.href, options.apiBase)) return fetch(url, request);
    try {
      const payload = await api(options, `${parsed.pathname}${parsed.search}`, {
        method: request.method || "GET",
        body: request.body ? JSON.parse(String(request.body)) : undefined,
      });
      return {
        ok: true,
        status: 200,
        async json() {
          return payload;
        },
      };
    } catch (error) {
      return {
        ok: false,
        status: Number(error?.statusCode || error?.payload?.statusCode || 500),
        async json() {
          return error?.payload || { ok: false, error: clean(error?.message || String(error)) };
        },
      };
    }
  };
}

function historyRoute(accountId, chatId, limit = 80) {
  return `/api/connectors/whatsapp/bridge/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(chatId)}/history?limit=${limit}`;
}

function messagesFromPayload(payload = {}) {
  if (Array.isArray(payload?.messages)) return payload.messages;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function textOf(message = {}) {
  return clean(message.body || message.text || message.message || message.content || "");
}

function timeMs(value = "") {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function waitUntil(label, options, fn) {
  const deadline = Date.now() + options.timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(options.pollMs);
  }
  if (lastError) lastError.message = `${label}: ${lastError.message || lastError}`;
  throw lastError || new Error(`${label}_timeout`);
}

function accountMatches(account = {}, requested = "") {
  const target = clean(requested).toLowerCase();
  if (!target) return false;
  return [
    account.accountId,
    account.runtimeAccountId,
    account.id,
    account.phoneNumber,
    account.contactId,
  ].map((value) => clean(value).toLowerCase()).includes(target);
}

async function preflight(options) {
  if (options.skipPreflight) return { skipped: true };
  const status = await api(options, "/api/connectors/whatsapp/status");
  const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
  const account = accounts.find((item) => accountMatches(item, options.responderAccountId));
  if (!account) {
    const error = new Error("responder_account_missing");
    error.details = { requested: options.responderAccountId };
    throw error;
  }
  if (account.ready !== true && clean(account.state) !== "ready") {
    const error = new Error("responder_account_not_ready");
    error.details = {
      requested: options.responderAccountId,
      accountId: clean(account.accountId || account.id),
      state: clean(account.state),
      nextAction: clean(account.nextAction),
    };
    throw error;
  }
  return {
    mode: clean(status.mode),
    state: clean(status.state),
    accountId: clean(account.accountId || account.id),
    runtimeAccountId: clean(account.runtimeAccountId),
    stateText: clean(account.state),
  };
}

async function waitForOutboundPrompt(options, text, afterMs, sentIds) {
  return waitUntil("outbound_onboarding_prompt_visible", options, async () => {
    const payload = await api(options, historyRoute(options.responderAccountId, options.chatId));
    const messages = messagesFromPayload(payload);
    return messages.find((message) => {
      const id = clean(message.id);
      return (
        (sentIds.has(id) || textOf(message) === text) &&
        message.fromMe === true &&
        timeMs(message.timestamp) >= afterMs
      );
    }) || null;
  });
}

async function writeArtifact(options, payload) {
  if (!options.artifactPath) return;
  await fs.mkdir(path.dirname(path.resolve(options.artifactPath)), { recursive: true });
  await fs.writeFile(options.artifactPath, `${JSON.stringify(payload, null, 2)}\n`);
}

export async function runRealWhatsAppDemoOnboarding(options) {
  const startedAt = Date.now();
  const setup = await demoPublicSetupUrl({
    ...apiEnv(options),
    ...(options.setupUrl ? { ORKESTR_DEMO_PUBLIC_SETUP_URL: options.setupUrl } : {}),
    ORKESTR_BROKER_FORCE_REREGISTER: "1",
  }, {
    fetchImpl: authenticatedFetchForApi(options),
  });
  if (!setup.ok || !setup.setupUrl) throw new Error(setup.reason || "public_setup_url_unavailable");
  const text = readyMessage({ setupUrl: setup.setupUrl });
  const result = {
    ok: false,
    flow: "demo-onboarding-codex-login",
    apiBase: options.apiBase,
    chatId: options.chatId,
    responderAccountId: options.responderAccountId,
    setupUrl: setup.setupUrl,
    setupUrlSource: setup.source || "",
    instanceId: setup.instanceId || "",
    tunnel: setup.tunnel ? {
      url: setup.tunnel.url || "",
      pid: setup.tunnel.pid || null,
      reused: setup.tunnel.reused === true,
    } : null,
    startedAt: new Date(startedAt).toISOString(),
  };

  try {
    result.preflight = await preflight(options);
    const sent = await api(options, "/api/connectors/whatsapp/bridge/send-text", {
      method: "POST",
      body: {
        accountId: options.responderAccountId,
        chatId: options.chatId,
        text,
        crossAccountEchoSuppression: true,
      },
    });
    const sentIds = new Set((sent?.ids || sent?.sent?.map((item) => item.id) || []).map(clean).filter(Boolean));
    const observed = await waitForOutboundPrompt(options, text, startedAt - 30_000, sentIds);
    result.sentMessageId = [...sentIds][0] || clean(sent?.id);
    result.observedMessageId = clean(observed?.id);
    result.prompt = {
      asksForCodexLogin: /Codex login\/sign-in/i.test(text),
      includesSetupUrl: text.includes(setup.setupUrl),
      challengeGated: /browser-pairing challenge/i.test(text),
    };
    result.ok = Boolean(result.observedMessageId) && result.prompt.asksForCodexLogin && result.prompt.includesSetupUrl;
    result.finishedAt = new Date().toISOString();
    return result;
  } catch (error) {
    result.error = {
      code: clean(error.code),
      message: clean(error.message || String(error)),
      details: error.details || null,
      payload: error.payload || null,
    };
    throw error;
  } finally {
    await writeArtifact(options, result);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.execute) {
    console.log(usage());
    console.log("\nRefusing to send real WhatsApp messages without --execute.");
    return;
  }
  const result = await runRealWhatsAppDemoOnboarding(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    if (error?.details) console.error(JSON.stringify(error.details, null, 2));
    if (error?.payload) console.error(JSON.stringify(error.payload, null, 2));
    process.exit(1);
  });
}
