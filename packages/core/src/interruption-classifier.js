import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";
import { runtimeInterruptedSuperseded } from "./thread-message-visibility.js";

function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function timestampMs(value) {
  const ms = Date.parse(clean(value));
  return Number.isFinite(ms) ? ms : 0;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function messagesFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.messages)) return payload.messages;
  return [];
}

function threadsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.threads)) return payload.threads;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function threadNameMap(threads = []) {
  const map = new Map();
  for (const thread of threads) {
    const id = clean(thread?.id || thread?.threadId);
    if (!id) continue;
    map.set(id, clean(thread.name || thread.title || thread.displayName || id) || id);
  }
  return map;
}

function classifyRuntimeInterruptedMessage(message = {}, messages = []) {
  const text = clean(message.text || message.content);
  const textLower = lower(text);
  const superseded = runtimeInterruptedSuperseded(message, messages);
  if (/^orkestr restarted before codex (?:finished|replied)/i.test(text)) {
    return {
      category: "deploy_or_service_restart",
      label: "Deploy/service restart before final answer",
      severity: superseded ? "info" : "error",
      superseded,
    };
  }
  if (/^codex stopped before final answer/i.test(text)) {
    return {
      category: "codex_idle_before_final",
      label: "Codex went idle before final answer",
      severity: superseded ? "info" : "error",
      superseded,
    };
  }
  if (/^codex response missing/i.test(text)) {
    return {
      category: "codex_response_missing",
      label: "Delivered input had no assistant response",
      severity: superseded ? "info" : "error",
      superseded,
    };
  }
  if (/^codex conversation interrupted/i.test(text) || textLower.includes("conversation interrupted")) {
    return {
      category: "codex_turn_interrupted",
      label: "Codex reported an interrupted turn",
      severity: "error",
      superseded,
    };
  }
  if (/^codex pane interrupted/i.test(text)) {
    return {
      category: "legacy_pane_interrupted",
      label: "Legacy tmux pane interruption",
      severity: "error",
      superseded,
    };
  }
  return {
    category: "runtime_interrupted",
    label: "Runtime interruption notice",
    severity: superseded ? "info" : "error",
    superseded,
  };
}

export function classifyInterruptionMessage(message = {}, messages = []) {
  const role = clean(message.role);
  const source = lower(message.source);
  const phase = lower(message.phase);
  const state = lower(message.state);
  const deliveryState = lower(message.deliveryState);
  if (role === "assistant" && source === "orkestr_runtime" && phase === "runtime_interrupted") {
    return classifyRuntimeInterruptedMessage(message, messages);
  }
  if (role === "user" && (state === "failed" || deliveryState === "failed")) {
    return {
      category: "input_delivery_failed",
      label: "User input delivery failed",
      severity: "error",
      superseded: false,
    };
  }
  return null;
}

export async function collectInterruptionRecords(env = process.env, options = {}) {
  const paths = dataPaths(env);
  const threadsPayload = await readJson(paths.threads, []);
  const names = threadNameMap(threadsFromPayload(threadsPayload));
  const sinceMs = Number(options.sinceMs || 0);
  const includeSuperseded = Boolean(options.includeSuperseded);
  let entries = [];
  try {
    entries = await fs.readdir(paths.threadMessages, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const threadId = entry.name.slice(0, -".json".length);
    const filePath = path.join(paths.threadMessages, entry.name);
    const messages = messagesFromPayload(await readJson(filePath, []));
    for (const message of messages) {
      const createdMs = timestampMs(message.createdAt || message.timestamp);
      if (sinceMs && createdMs && createdMs < sinceMs) continue;
      const classification = classifyInterruptionMessage(message, messages);
      if (!classification) continue;
      if (classification.superseded && !includeSuperseded) continue;
      records.push({
        threadId,
        threadName: names.get(threadId) || threadId,
        messageId: clean(message.id),
        createdAt: clean(message.createdAt || message.timestamp),
        role: clean(message.role),
        source: clean(message.source),
        phase: clean(message.phase),
        state: clean(message.state),
        deliveryState: clean(message.deliveryState),
        category: classification.category,
        label: classification.label,
        severity: classification.severity,
        superseded: classification.superseded,
        text: clean(message.text || message.content),
      });
    }
  }
  return records.sort((a, b) => timestampMs(a.createdAt) - timestampMs(b.createdAt));
}

export function summarizeInterruptionRecords(records = []) {
  const byCategory = {};
  const byThread = {};
  let errorCount = 0;
  let supersededCount = 0;
  for (const record of records) {
    byCategory[record.category] = (byCategory[record.category] || 0) + 1;
    const threadKey = record.threadName || record.threadId || "unknown";
    byThread[threadKey] = (byThread[threadKey] || 0) + 1;
    if (record.severity === "error") errorCount += 1;
    if (record.superseded) supersededCount += 1;
  }
  return {
    total: records.length,
    errorCount,
    supersededCount,
    byCategory,
    byThread,
    latest: records.slice(-10).reverse(),
  };
}

export async function analyzeInterruptionHistory(env = process.env, options = {}) {
  const records = await collectInterruptionRecords(env, options);
  return {
    generatedAt: new Date().toISOString(),
    includeSuperseded: Boolean(options.includeSuperseded),
    sinceMs: Number(options.sinceMs || 0),
    summary: summarizeInterruptionRecords(records),
    records,
  };
}
