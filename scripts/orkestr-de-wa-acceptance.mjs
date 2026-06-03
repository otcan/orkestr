#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { forwardLocalWhatsAppInbound } from "../packages/connectors/src/whatsapp-local-bridge.js";

const DEFAULT_PUBLIC_API_BASE = "https://app.orkestr.de";
const DEFAULT_PARENT_WA_BASE = "http://127.0.0.1:8787";
const execFileAsync = promisify(execFile);

function clean(value = "") {
  return String(value || "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeId(value = "") {
  return clean(value)
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    execute: false,
    mode: "tenant-forward",
    apiBase: clean(env.ORKESTR_DE_ACCEPTANCE_API_BASE) || DEFAULT_PUBLIC_API_BASE,
    pollMode: clean(env.ORKESTR_DE_ACCEPTANCE_POLL_MODE || "http"),
    guestExec: clean(env.ORKESTR_DE_ACCEPTANCE_GUEST_EXEC || "/tmp/crawlerai_guest_exec.sh"),
    guestNamespace: clean(env.ORKESTR_DE_ACCEPTANCE_GUEST_NAMESPACE || "orkestr-de"),
    guestVmi: clean(env.ORKESTR_DE_ACCEPTANCE_GUEST_VMI || "orkestr-de"),
    vmHome: clean(env.ORKESTR_DE_ACCEPTANCE_VM_HOME || "/opt/orkestr/data"),
    parentHome: clean(env.ORKESTR_DE_ACCEPTANCE_PARENT_HOME || env.ORKESTR_PARENT_HOME || env.ORKESTR_HOME),
    parentWaBase: clean(env.ORKESTR_DE_ACCEPTANCE_PARENT_WA_BASE) || DEFAULT_PARENT_WA_BASE,
    parentWaToken: clean(env.ORKESTR_DE_ACCEPTANCE_PARENT_WA_TOKEN || env.WHATSAPP_BRIDGE_TOKEN || env.WA_HTTP_TOKEN),
    requireWaHistory: env.ORKESTR_DE_ACCEPTANCE_WA_HISTORY !== "0",
    thread: clean(env.ORKESTR_DE_ACCEPTANCE_THREAD || "onboarding-admin-orkestr-de"),
    chatId: clean(env.ORKESTR_DE_ACCEPTANCE_CHAT_ID || "120363425280218500@g.us"),
    accountId: clean(env.ORKESTR_DE_ACCEPTANCE_ACCOUNT_ID || "sender"),
    from: clean(env.ORKESTR_DE_ACCEPTANCE_FROM || "66378837028965@lid"),
    timeoutMs: Number(env.ORKESTR_DE_ACCEPTANCE_TIMEOUT_MS || 90_000),
    pollMs: Number(env.ORKESTR_DE_ACCEPTANCE_POLL_MS || 1500),
    runId: safeId(env.ORKESTR_DE_ACCEPTANCE_RUN_ID || new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)),
    cases: ["exact", "web", "desktop", "private"],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--execute") {
      options.execute = true;
    } else if (arg === "--no-wa-history") {
      options.requireWaHistory = false;
    } else if (arg === "--api-base") {
      options.apiBase = clean(argv[++index]);
    } else if (arg === "--poll-mode") {
      options.pollMode = clean(argv[++index]);
    } else if (arg === "--guest-exec") {
      options.guestExec = clean(argv[++index]);
    } else if (arg === "--guest-namespace") {
      options.guestNamespace = clean(argv[++index]);
    } else if (arg === "--guest-vmi") {
      options.guestVmi = clean(argv[++index]);
    } else if (arg === "--vm-home") {
      options.vmHome = clean(argv[++index]);
    } else if (arg === "--parent-home") {
      options.parentHome = clean(argv[++index]);
    } else if (arg === "--parent-wa-base") {
      options.parentWaBase = clean(argv[++index]).replace(/\/+$/, "");
    } else if (arg === "--parent-wa-token") {
      options.parentWaToken = clean(argv[++index]);
    } else if (arg === "--thread") {
      options.thread = clean(argv[++index]);
    } else if (arg === "--chat-id") {
      options.chatId = clean(argv[++index]);
    } else if (arg === "--account-id") {
      options.accountId = clean(argv[++index]);
    } else if (arg === "--from") {
      options.from = clean(argv[++index]);
    } else if (arg === "--run-id") {
      options.runId = safeId(argv[++index]);
    } else if (arg === "--case") {
      const value = clean(argv[++index]);
      options.cases = value === "all" ? ["exact", "web", "desktop", "private", "timer"] : value.split(",").map(clean).filter(Boolean);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[++index] || 0);
    } else if (arg === "--poll-ms") {
      options.pollMs = Number(argv[++index] || 0);
    } else if (arg === "--mode") {
      options.mode = clean(argv[++index]);
    } else {
      throw new Error(`unknown_arg:${arg}`);
    }
  }

  if (!options.apiBase) throw new Error("api_base_required");
  if (!["http", "vm-file"].includes(options.pollMode)) throw new Error("invalid_poll_mode");
  if (!options.thread) throw new Error("thread_required");
  if (!options.chatId) throw new Error("chat_id_required");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) throw new Error("invalid_timeout_ms");
  if (!Number.isFinite(options.pollMs) || options.pollMs < 100) throw new Error("invalid_poll_ms");
  if (options.mode !== "tenant-forward") throw new Error("only tenant-forward mode is implemented; pair the sender account before adding sender-web mode");
  return options;
}

function printHelp() {
  console.log([
    "Usage: node scripts/orkestr-de-wa-acceptance.mjs --execute [options]",
    "",
    "Runs live app.orkestr.de acceptance probes through the existing parent WhatsApp tenant-forward route.",
    "This checks public API-agent replies and optionally verifies the reply appears in the parent WhatsApp bridge history.",
    "",
    "Options:",
    "  --api-base URL        Public tenant API base. Default: https://app.orkestr.de",
    "  --poll-mode MODE      http or vm-file. Use vm-file when public APIs are auth-blocked.",
    "  --guest-exec FILE     Guest exec helper for vm-file polling. Default: /tmp/crawlerai_guest_exec.sh",
    "  --guest-namespace NS  KubeVirt namespace for vm-file polling. Default: orkestr-de",
    "  --guest-vmi NAME      KubeVirt VMI for vm-file polling. Default: orkestr-de",
    "  --vm-home DIR         Public ORKESTR_HOME inside the VM. Default: /opt/orkestr/data",
    "  --parent-home DIR     Parent ORKESTR_HOME containing tenant route secrets.",
    "  --parent-wa-base URL  Parent WA bridge base for history checks. Default: http://127.0.0.1:8787",
    "  --parent-wa-token TOK  Parent WA bridge bearer token. Prefer ORKESTR_DE_ACCEPTANCE_PARENT_WA_TOKEN.",
    "  --thread ID           Public tenant thread id. Default: onboarding-admin-orkestr-de",
    "  --chat-id ID          WhatsApp chat id routed to the public tenant.",
    "  --account-id ID       Parent WhatsApp inbound account id. Default: sender",
    "  --from ID             Sender contact id for the synthetic inbound event.",
    "  --case LIST           exact,web,desktop,private,timer or all.",
    "  --no-wa-history       Skip parent WhatsApp history verification.",
    "",
    "This does not exercise phone-authored inbound delivery unless the sender WhatsApp account is paired.",
  ].join("\n"));
}

function caseSpec(name, runId) {
  const specs = {
    exact: {
      text: `orkestr.de e2e ${runId}: reply exactly "orkestr.de e2e OK ${runId}"`,
      require: [new RegExp(`orkestr\\.de e2e OK ${runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)],
      reject: [/^Done\.?$/i],
    },
    web: {
      text: `orkestr.de e2e ${runId}: Fetch https://orkestr.de/ and summarize what is on the page.`,
      require: [/(Fetched|opened .*Desktop|couldn.t fetch useful page contents)/i],
      reject: [/^Done\.?$/i, /\/codex/i],
    },
    desktop: {
      text: `orkestr.de e2e ${runId}: Open LinkedIn. Am I logged in?`,
      require: [/(Desktop|LinkedIn|managed desktop)/i, /(open|opened|available|does not report login state|cannot confirm)/i],
      reject: [/^Done\.?$/i, /Tell me what you want/i, /\/codex/i],
    },
    private: {
      text: `orkestr.de e2e ${runId}: Fetch http://127.0.0.1:19812/api/health and summarize it.`,
      require: [/(url_host_forbidden|couldn.t fetch|can.t reach|cannot access|no access|forbidden)/i],
      reject: [/opened .*Desktop/i],
    },
    timer: {
      text: `Set a timer in 2 minutes, telling me "orkestr.de timer e2e HI ${runId}"`,
      require: [new RegExp(`orkestr\\.de timer e2e HI ${runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")],
      reject: [/safely handle|private connector|admin to enable|capability denial/i],
      timerDue: true,
    },
  };
  if (!specs[name]) throw new Error(`unknown_case:${name}`);
  return specs[name];
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`http_${response.status}:${url}`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function messagesFromPayload(payload = {}) {
  if (Array.isArray(payload?.messages)) return payload.messages;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function shellSingleQuote(value = "") {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function fetchVmFileThreadMessages(options) {
  const file = `${options.vmHome.replace(/\/+$/, "")}/thread-messages/${options.thread}.json`;
  const command = `cat ${shellSingleQuote(file)}`;
  const { stdout } = await execFileAsync(options.guestExec, [command], {
    env: {
      ...process.env,
      NS: options.guestNamespace,
      VMI: options.guestVmi,
    },
    timeout: Math.max(1000, options.pollMs),
    maxBuffer: 5 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout || "[]");
  return messagesFromPayload(parsed);
}

async function fetchThreadMessages(options) {
  if (options.pollMode === "vm-file") return fetchVmFileThreadMessages(options);
  const url = `${options.apiBase.replace(/\/+$/, "")}/api/threads/${encodeURIComponent(options.thread)}/messages?limit=80`;
  return messagesFromPayload(await requestJson(url));
}

function latestAssistantFor(messages = [], parentMessageId = "") {
  return messages
    .filter((message) => clean(message.role) === "assistant" && (!parentMessageId || clean(message.parentMessageId) === parentMessageId))
    .at(-1) || null;
}

async function waitForAssistant(options, parentMessageId = "") {
  const deadline = Date.now() + options.timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const messages = await fetchThreadMessages(options);
      const assistant = latestAssistantFor(messages, parentMessageId);
      if (assistant?.text) return assistant;
    } catch (error) {
      lastError = error;
    }
    await sleep(options.pollMs);
  }
  throw lastError || new Error(`assistant_timeout:${parentMessageId || options.thread}`);
}

async function waitForAssistantMatching(options, patterns = [], parentMessageId = "") {
  const deadline = Date.now() + Math.max(options.timeoutMs, 180_000);
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const messages = await fetchThreadMessages(options);
      const assistants = messages.filter((message) =>
        clean(message.role) === "assistant" &&
        clean(message.text) &&
        (!parentMessageId || clean(message.parentMessageId) === parentMessageId)
      );
      for (const assistant of assistants.slice().reverse()) {
        const text = clean(assistant.text);
        if (patterns.every((pattern) => pattern.test(text))) return assistant;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(options.pollMs);
  }
  throw lastError || new Error(`assistant_match_timeout:${parentMessageId || options.thread}`);
}

function collectTexts(value, output = []) {
  if (value === null || value === undefined) return output;
  if (typeof value === "string") {
    const text = clean(value);
    if (text) output.push(text);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTexts(item, output);
    return output;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (/text|body|message|caption|content/i.test(key)) collectTexts(nested, output);
      else if (nested && typeof nested === "object") collectTexts(nested, output);
    }
  }
  return output;
}

async function waitForWhatsAppHistory(options, assistantText = "") {
  if (!options.requireWaHistory) return { checked: false, reason: "disabled" };
  const needle = clean(assistantText).replace(/\s+/g, " ").slice(0, 80);
  if (!needle) return { checked: false, reason: "empty_assistant_text" };
  const url = `${options.parentWaBase.replace(/\/+$/, "")}/api/chats/${encodeURIComponent(options.chatId)}/history`;
  const deadline = Date.now() + options.timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const payload = await requestJson(url, {
        headers: options.parentWaToken ? { authorization: `Bearer ${options.parentWaToken}` } : {},
      });
      const texts = collectTexts(payload).map((text) => text.replace(/\s+/g, " "));
      if (texts.some((text) => text.includes(needle))) {
        return { checked: true, delivered: true };
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(options.pollMs);
  }
  const error = new Error(`wa_history_missing_reply:${needle}`);
  error.cause = lastError;
  throw error;
}

function validate(name, spec, assistant) {
  const text = clean(assistant?.text);
  for (const pattern of spec.require) {
    if (!pattern.test(text)) throw new Error(`case_failed:${name}:missing:${pattern}:${text}`);
  }
  for (const pattern of spec.reject) {
    if (pattern.test(text)) throw new Error(`case_failed:${name}:rejected:${pattern}:${text}`);
  }
  return text;
}

async function runCase(name, options) {
  const spec = caseSpec(name, options.runId);
  const parentEnv = {
    ...process.env,
    ...(options.parentHome ? { ORKESTR_HOME: options.parentHome } : {}),
  };
  const eventId = `orkestr-de-acceptance-${options.runId}-${name}`;
  const forwarded = await forwardLocalWhatsAppInbound({
    eventId,
    chatId: options.chatId,
    accountId: options.accountId,
    from: options.from,
    text: spec.text,
    timestamp: new Date().toISOString(),
  }, parentEnv);
  if (!forwarded?.forwarded) throw new Error(`case_not_forwarded:${name}`);
  const parentMessageId = clean(forwarded.payload?.message?.id || forwarded.payload?.messageId);
  const immediateAssistant = forwarded.payload?.assistant || null;
  if (spec.timerDue) {
    if (immediateAssistant?.text && /safely handle|private connector|admin to enable|capability/i.test(immediateAssistant.text)) {
      throw new Error(`case_failed:${name}:timer_request_denied:${immediateAssistant.text}`);
    }
    const assistant = await waitForAssistantMatching(options, spec.require);
    const text = validate(name, spec, assistant);
    const waHistory = await waitForWhatsAppHistory(options, text);
    return {
      name,
      ok: true,
      eventId,
      parentMessageId,
      assistantId: clean(assistant.id),
      text,
      waHistory,
    };
  }
  const assistant = immediateAssistant?.text ? immediateAssistant : await waitForAssistant(options, parentMessageId);
  const text = validate(name, spec, assistant);
  const waHistory = await waitForWhatsAppHistory(options, text);
  return {
    name,
    ok: true,
    eventId,
    parentMessageId,
    assistantId: clean(assistant.id),
    text,
    waHistory,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.execute) {
    printHelp();
    console.log("\nRefusing to mutate the live WhatsApp/public tenant route without --execute.");
    return;
  }
  const results = [];
  for (const name of options.cases) {
    const result = await runCase(name, options);
    results.push(result);
    console.log(`ok ${name}: ${result.text.replace(/\s+/g, " ").slice(0, 180)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    mode: options.mode,
    pollMode: options.pollMode,
    runId: options.runId,
    apiBase: options.apiBase,
    thread: options.thread,
    chatId: options.chatId,
    waHistoryChecked: options.requireWaHistory,
    cases: results.map((result) => ({
      name: result.name,
      assistantId: result.assistantId,
      waHistory: result.waHistory,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  if (error?.payload) console.error(JSON.stringify(error.payload, null, 2));
  process.exit(1);
});
