#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { requestJson } from "../apps/cli/src/api-client.js";

function clean(value = "") {
  return String(value || "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function safeId(value = "") {
  return clean(value)
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseBool(value, fallback = false) {
  const text = clean(value).toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    execute: false,
    apiBase: clean(env.ORKESTR_REAL_WA_E2E_API_BASE || env.ORKESTR_API_BASE || "http://127.0.0.1:19812"),
    orkestrHome: clean(env.ORKESTR_REAL_WA_E2E_HOME || env.ORKESTR_HOME),
    threadId: clean(env.ORKESTR_REAL_WA_E2E_THREAD),
    chatId: clean(env.ORKESTR_REAL_WA_E2E_CHAT_ID),
    senderAccountId: clean(env.ORKESTR_REAL_WA_E2E_SENDER_ACCOUNT || "sender"),
    responderAccountId: clean(env.ORKESTR_REAL_WA_E2E_RESPONDER_ACCOUNT || "responder"),
    desktopSlug: clean(env.ORKESTR_REAL_WA_E2E_DESKTOP || "gmail"),
    runId: safeId(env.ORKESTR_REAL_WA_E2E_RUN_ID || new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)),
    timeoutMs: Number(env.ORKESTR_REAL_WA_E2E_TIMEOUT_MS || 180_000),
    pollMs: Number(env.ORKESTR_REAL_WA_E2E_POLL_MS || 2000),
    includeDesktop: !parseBool(env.ORKESTR_REAL_WA_E2E_NO_DESKTOP, false),
    includeTimer: !parseBool(env.ORKESTR_REAL_WA_E2E_NO_TIMER, false),
    openLinkInDesktop: parseBool(env.ORKESTR_REAL_WA_E2E_OPEN_LINK_IN_DESKTOP, false),
    requireOauthCallback: parseBool(env.ORKESTR_REAL_WA_E2E_REQUIRE_OAUTH_CALLBACK, false),
    forceDesktop: parseBool(env.ORKESTR_REAL_WA_E2E_FORCE_DESKTOP, false),
    artifactPath: clean(env.ORKESTR_REAL_WA_E2E_ARTIFACT),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--api-base") options.apiBase = clean(argv[++index]);
    else if (arg === "--orkestr-home") options.orkestrHome = clean(argv[++index]);
    else if (arg === "--thread") options.threadId = clean(argv[++index]);
    else if (arg === "--chat-id") options.chatId = clean(argv[++index]);
    else if (arg === "--sender-account") options.senderAccountId = clean(argv[++index]);
    else if (arg === "--responder-account") options.responderAccountId = clean(argv[++index]);
    else if (arg === "--desktop") options.desktopSlug = clean(argv[++index]);
    else if (arg === "--run-id") options.runId = safeId(argv[++index]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index] || 0);
    else if (arg === "--poll-ms") options.pollMs = Number(argv[++index] || 0);
    else if (arg === "--no-desktop") options.includeDesktop = false;
    else if (arg === "--no-timer") options.includeTimer = false;
    else if (arg === "--open-link-in-desktop") options.openLinkInDesktop = true;
    else if (arg === "--require-oauth-callback") options.requireOauthCallback = true;
    else if (arg === "--force-desktop") options.forceDesktop = true;
    else if (arg === "--artifact") options.artifactPath = clean(argv[++index]);
    else throw new Error(`unknown_arg:${arg}`);
  }

  if (options.help || !options.execute) return options;
  if (!options.apiBase) throw new Error("api_base_required");
  if (!options.threadId) throw new Error("thread_required");
  if (!options.chatId) throw new Error("chat_id_required");
  if (!options.senderAccountId) throw new Error("sender_account_required");
  if (!options.responderAccountId) throw new Error("responder_account_required");
  if (options.senderAccountId === options.responderAccountId) throw new Error("sender_and_responder_must_differ_for_real_transport_e2e");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10_000) throw new Error("invalid_timeout_ms");
  if (!Number.isFinite(options.pollMs) || options.pollMs < 250) throw new Error("invalid_poll_ms");
  return options;
}

function usage() {
  return [
    "Usage: npm run e2e:whatsapp-real -- --execute [options]",
    "",
    "Runs an opt-in, real transport WhatsApp E2E against an Orkestr instance.",
    "It sends through a real sender account, waits for the responder account to see it,",
    "checks the Orkestr thread/outbox path, exercises desktop lease/share APIs, and",
    "creates/runs/cleans a timer watcher.",
    "",
    "Required with --execute:",
    "  --thread ID              Existing Orkestr thread bound to the WA chat.",
    "  --chat-id ID             Real WhatsApp chat id.",
    "",
    "Common options:",
    "  --api-base URL           Orkestr API base. Default: ORKESTR_API_BASE or localhost.",
    "  --orkestr-home DIR       Lets the API client use local CLI auth for that instance.",
    "  --sender-account ID      WA account that sends the real user-visible message. Default: sender.",
    "  --responder-account ID   WA account that Orkestr uses to reply. Default: responder.",
    "  --desktop SLUG           Managed desktop to lease/share. Default: gmail.",
    "  --open-link-in-desktop   Open the generated Google connect link in the managed desktop.",
    "  --require-oauth-callback Wait for OAuth callback/success after manual approval.",
    "  --no-desktop             Skip desktop lease/share checks.",
    "  --no-timer               Skip timer watcher checks.",
    "  --artifact FILE          Write JSON result details.",
    "",
    "The default run does not consume the one-time Google OAuth link.",
  ].join("\n");
}

function apiEnv(options) {
  return {
    ...process.env,
    ...(options.orkestrHome ? { ORKESTR_HOME: options.orkestrHome } : {}),
  };
}

async function api(options, route, request = {}) {
  return requestJson(route, {
    ...request,
    baseUrl: options.apiBase,
    env: apiEnv(options),
  });
}

async function publicJson(url, request = {}) {
  const response = await fetch(url, { ...request, redirect: "manual" });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { ok: response.ok, status: response.status, headers: response.headers, payload, text };
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

async function waitForHistoryMessage(options, accountId, predicate, label) {
  return waitUntil(label, options, async () => {
    const payload = await api(options, historyRoute(accountId, options.chatId));
    const messages = messagesFromPayload(payload);
    return messages.find(predicate) || null;
  });
}

async function threadMessages(options) {
  const payload = await api(options, `/api/threads/${encodeURIComponent(options.threadId)}/messages?limit=120`);
  return messagesFromPayload(payload);
}

async function waitForThreadMessage(options, predicate, label) {
  return waitUntil(label, options, async () => {
    const messages = await threadMessages(options);
    return messages.find(predicate) || null;
  });
}

function extractConnectLink(text = "") {
  return clean(text).match(/https?:\/\/\S+\/connect\/google\?connect=[A-Za-z0-9_.~%:-]+/)?.[0]?.replace(/[).,\]]+$/g, "") || "";
}

function connectIdFromLink(link = "") {
  try {
    return new URL(link).searchParams.get("connect") || "";
  } catch {
    return "";
  }
}

async function runDesktopChecks(options, results) {
  if (!options.includeDesktop) return null;
  const threadName = `Real WA E2E ${options.runId}`;
  const before = await api(options, "/api/desktops/leases?include=released").catch((error) => ({ error: error.message || String(error) }));
  const acquired = await api(options, `/api/desktops/${encodeURIComponent(options.desktopSlug)}/acquire`, {
    method: "POST",
    body: {
      threadId: options.threadId,
      threadName,
      purpose: "real-wa-e2e",
      runId: options.runId,
      ttl: "15m",
      force: options.forceDesktop,
    },
  });
  await api(options, `/api/desktops/${encodeURIComponent(options.desktopSlug)}/heartbeat`, {
    method: "POST",
    body: { threadId: options.threadId },
  });
  const share = await api(options, `/api/desktops/${encodeURIComponent(options.desktopSlug)}/share`, {
    method: "POST",
    body: { label: threadName, start: true },
  });
  const shareId = clean(share?.share?.id || share?.shareId);
  const shareKey = clean(share?.share?.key || share?.key);
  const status = shareId && shareKey
    ? await api(options, `/api/desktop-shares/${encodeURIComponent(shareId)}/status?key=${encodeURIComponent(shareKey)}`).catch((error) => ({ error: error.message || String(error) }))
    : null;
  results.desktop = {
    slug: options.desktopSlug,
    beforeCount: Array.isArray(before?.desktopLeases) ? before.desktopLeases.length : null,
    acquired: acquired?.ok === true,
    leaseId: clean(acquired?.lease?.id),
    shareUrl: clean(share?.url),
    shareStatus: status?.ok === true ? "ok" : clean(status?.error || ""),
  };
  return acquired;
}

async function releaseDesktop(options, results) {
  if (!options.includeDesktop) return;
  try {
    const released = await api(options, `/api/desktops/${encodeURIComponent(options.desktopSlug)}/release`, {
      method: "POST",
      body: { threadId: options.threadId, reason: "real-wa-e2e-cleanup" },
    });
    results.desktop = { ...(results.desktop || {}), released: released?.ok === true };
  } catch (error) {
    results.desktop = { ...(results.desktop || {}), releaseError: error.message || String(error) };
  }
}

async function runConnectFlow(options, results, startedAt) {
  const commandText = "/connect google";
  const sent = await api(options, "/api/connectors/whatsapp/bridge/send-text", {
    method: "POST",
    body: {
      accountId: options.senderAccountId,
      chatId: options.chatId,
      text: commandText,
      crossAccountEchoSuppression: false,
    },
  });
  const sentIds = new Set((sent?.ids || sent?.sent?.map((item) => item.id) || []).map(clean).filter(Boolean));
  const after = startedAt - 30_000;
  const visibleSender = await waitForHistoryMessage(
    options,
    options.senderAccountId,
    (message) => sentIds.has(clean(message.id)) || (textOf(message) === commandText && message.fromMe === true && timeMs(message.timestamp) >= after),
    "sender_visible_message",
  );
  const visibleResponder = await waitForHistoryMessage(
    options,
    options.responderAccountId,
    (message) => textOf(message) === commandText && message.fromMe !== true && timeMs(message.timestamp) >= after,
    "responder_observed_real_message",
  );
  const userMessage = await waitForThreadMessage(
    options,
    (message) =>
      clean(message.role) === "user" &&
      textOf(message) === commandText &&
      timeMs(message.createdAt) >= after,
    "thread_user_message",
  );
  const assistant = await waitForThreadMessage(
    options,
    (message) =>
      clean(message.role) === "assistant" &&
      extractConnectLink(textOf(message)) &&
      (!userMessage.id || clean(message.parentMessageId) === clean(userMessage.id) || timeMs(message.createdAt) >= timeMs(userMessage.createdAt)),
    "thread_connect_link",
  );
  const connectLink = extractConnectLink(textOf(assistant));
  await waitForHistoryMessage(
    options,
    options.responderAccountId,
    (message) => textOf(message).includes(connectLink),
    "wa_connect_link_visible",
  );
  const page = await publicJson(connectLink);
  if (!page.ok || !page.text.includes("/connect/google/start")) {
    throw new Error(`connect_page_invalid:${page.status}`);
  }
  results.connect = {
    sentMessageId: [...sentIds][0] || clean(sent?.id),
    senderVisibleId: clean(visibleSender?.id),
    responderVisibleId: clean(visibleResponder?.id),
    threadUserMessageId: clean(userMessage.id),
    assistantMessageId: clean(assistant.id),
    connectId: connectIdFromLink(connectLink),
    connectLink,
    pageOk: true,
  };
  if (options.openLinkInDesktop && options.includeDesktop) {
    const opened = await api(options, `/api/browser-sessions/${encodeURIComponent(options.desktopSlug)}/open-url`, {
      method: "POST",
      body: { url: connectLink },
    });
    results.connect.openedInDesktop = Boolean(opened?.browser || opened?.ok);
  }
  if (options.requireOauthCallback) {
    await waitUntil("oauth_callback", options, async () => {
      const events = await api(options, "/api/events?limit=120");
      const items = Array.isArray(events?.events) ? events.events : [];
      return items.find((event) =>
        /google_workspace|gmail/.test(clean(event.type)) &&
        /callback|token|connected|stored|failed/.test(clean(event.type))
      ) || null;
    });
  }
  return results.connect;
}

async function runTimerWatcher(options, results) {
  if (!options.includeTimer) return null;
  const prompt = `Real WhatsApp E2E timer watcher ${options.runId}: report the timer watcher status for this chat.`;
  const created = await api(options, "/api/timers", {
    method: "POST",
    body: {
      label: `Real WA E2E ${options.runId}`,
      targetType: "thread",
      target: options.threadId,
      cadence: "once",
      runAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      prompt,
    },
  });
  const timerId = clean(created?.timer?.id);
  if (!timerId) throw new Error("timer_create_missing_id");
  try {
    const doctor = await api(options, "/api/timers/doctor");
    const run = await api(options, `/api/timers/${encodeURIComponent(timerId)}/run`, { method: "POST" });
    const queued = await waitForThreadMessage(
      options,
      (message) => clean(message.role) === "user" && textOf(message).includes(options.runId),
      "timer_thread_message",
    );
    results.timer = {
      timerId,
      doctorIssueCount: Array.isArray(doctor?.issues) ? doctor.issues.length : null,
      runEventId: clean(run?.event?.id || run?.eventId),
      queuedMessageId: clean(queued.id),
    };
    return results.timer;
  } finally {
    try {
      await api(options, `/api/timers/${encodeURIComponent(timerId)}`, { method: "DELETE" });
      results.timer = { ...(results.timer || { timerId }), deleted: true };
    } catch (error) {
      results.timer = { ...(results.timer || { timerId }), deleteError: error.message || String(error) };
    }
  }
}

async function writeArtifact(options, payload) {
  if (!options.artifactPath) return;
  await fs.mkdir(path.dirname(path.resolve(options.artifactPath)), { recursive: true });
  await fs.writeFile(options.artifactPath, `${JSON.stringify(payload, null, 2)}\n`);
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
  const startedAt = Date.now();
  const results = {
    ok: false,
    runId: options.runId,
    apiBase: options.apiBase,
    threadId: options.threadId,
    chatId: options.chatId,
    senderAccountId: options.senderAccountId,
    responderAccountId: options.responderAccountId,
    startedAt: new Date(startedAt).toISOString(),
  };
  try {
    results.status = await api(options, "/api/connectors/whatsapp/status").then((payload) => ({
      mode: clean(payload.mode),
      state: clean(payload.state),
      accounts: (payload.accounts || []).map((account) => ({
        accountId: clean(account.accountId || account.id),
        ready: account.ready === true,
        state: clean(account.state),
      })),
    }));
    await runDesktopChecks(options, results);
    await runConnectFlow(options, results, startedAt);
    await runTimerWatcher(options, results);
    results.ok = true;
    results.finishedAt = new Date().toISOString();
  } finally {
    await releaseDesktop(options, results);
    await writeArtifact(options, results);
  }
  console.log(JSON.stringify(results, null, 2));
  if (!results.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  if (error?.payload) console.error(JSON.stringify(error.payload, null, 2));
  process.exit(1);
});
