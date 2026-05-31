#!/usr/bin/env node
const DEFAULT_API_BASE = "http://127.0.0.1:18912";

const CASES = {
  "gmail-missing": {
    text: "Can you check my gmail?",
    require: [/gmail/i, /(not connected|not enabled|isn.t connected|can.t access|cannot access)/i],
    reject: [/safely handle/i, /private connector/i, /account identity/i, /couldn.t complete this request/i, /Orkestr UI/i],
  },
  "whatsapp-identity": {
    text: "What is the WhatsApp number that you control?",
    require: [/(connected to this chat|whatsapp chat|admin|can.t expose|cannot expose)/i],
    reject: [/couldn.t complete this request/i, /could not route/i, /Orkestr UI/i],
  },
  capabilities: {
    text: "What can you do? Reply briefly and list only connected capabilities.",
    require: [/whatsapp/i],
    reject: [/\bgmail\b/i, /\boutlook\b/i, /not connected/i, /Orkestr UI/i],
  },
};

function parseArgs(argv) {
  if (argv.length === 0 && process.env.ORKESTR_RUN_TENANT_CHAT_SMOKE !== "1") {
    return { skip: true };
  }
  const options = {
    apiBase: DEFAULT_API_BASE,
    thread: "otcantest",
    cases: Object.keys(CASES),
    source: "tenant_regression_test",
    timeoutMs: 45_000,
    pollMs: 750,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`unknown_arg:${arg}`);
    const [, key, value] = match;
    if (key === "api-base") options.apiBase = value.replace(/\/+$/, "");
    else if (key === "thread") options.thread = value;
    else if (key === "source") options.source = value;
    else if (key === "timeout-ms") options.timeoutMs = Number(value);
    else if (key === "poll-ms") options.pollMs = Number(value);
    else if (key === "case") options.cases = value === "all" ? Object.keys(CASES) : value.split(",").map((item) => item.trim()).filter(Boolean);
    else throw new Error(`unknown_arg:${arg}`);
  }
  for (const name of options.cases) {
    if (!CASES[name]) throw new Error(`unknown_case:${name}`);
  }
  if (!options.thread) throw new Error("thread_required");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) throw new Error("invalid_timeout_ms");
  if (!Number.isFinite(options.pollMs) || options.pollMs < 100) throw new Error("invalid_poll_ms");
  return options;
}

function printHelp() {
  console.log([
    "Usage: node scripts/test-tenant-chat.mjs --thread=THREAD [--api-base=http://127.0.0.1:18912] [--case=all|gmail-missing,whatsapp-identity,capabilities]",
    "",
    "Posts tenant-chat regression probes through the Orkestr thread input API and validates the assistant reply.",
    "The default source is tenant_regression_test, so the probes do not carry WhatsApp connector metadata.",
    "With no arguments, this script exits without probing live state so node --test cannot mutate a running Orkestr instance.",
  ].join("\n"));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
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
    error.payload = payload;
    throw error;
  }
  return payload;
}

function messageList(payload) {
  if (Array.isArray(payload?.messages)) return payload.messages;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

async function waitForAssistant({ apiBase, thread, parentMessageId, timeoutMs, pollMs }) {
  const expiresAt = Date.now() + timeoutMs;
  while (Date.now() < expiresAt) {
    const payload = await requestJson(`${apiBase}/api/threads/${encodeURIComponent(thread)}/messages`);
    const messages = messageList(payload);
    const assistant = messages.find((message) => message.role === "assistant" && message.parentMessageId === parentMessageId);
    if (assistant) return assistant;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`assistant_timeout:${parentMessageId}`);
}

function validateReply(name, spec, assistant) {
  const text = String(assistant?.text || "");
  for (const pattern of spec.require) {
    if (!pattern.test(text)) throw new Error(`case_failed:${name}:missing:${pattern}:${text}`);
  }
  for (const pattern of spec.reject) {
    if (pattern.test(text)) throw new Error(`case_failed:${name}:rejected:${pattern}:${text}`);
  }
  return text;
}

async function runCase(name, options) {
  const spec = CASES[name];
  const input = await requestJson(`${options.apiBase}/api/threads/${encodeURIComponent(options.thread)}/input`, {
    method: "POST",
    body: JSON.stringify({
      text: spec.text,
      source: options.source,
    }),
  });
  const messageId = input?.message?.id;
  if (!messageId) throw new Error(`missing_message_id:${name}`);
  const assistant = input.assistant || await waitForAssistant({
    apiBase: options.apiBase,
    thread: options.thread,
    parentMessageId: messageId,
    timeoutMs: options.timeoutMs,
    pollMs: options.pollMs,
  });
  const text = validateReply(name, spec, assistant);
  return { name, messageId, assistantId: assistant.id || "", text };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.skip) {
    console.log("ok tenant-chat smoke skipped: pass --thread=THREAD to probe a running Orkestr instance");
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
    apiBase: options.apiBase,
    thread: options.thread,
    cases: results.map((result) => result.name),
  }));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  if (error?.payload) console.error(JSON.stringify(error.payload, null, 2));
  process.exit(1);
});
