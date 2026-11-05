import os from "node:os";
import { dualProviderQuotaLines } from "./whatsapp-quota-footer.js";
import { threadQuotaProvider } from "../../core/src/provider-quota-snapshot.js";
import { threadRequiresTenantIsolation } from "../../core/src/tenant-policy.js";
import { codexAssistantSource, threadSuppressesWhatsAppDebugFooter } from "./whatsapp-mirror-policy.js";
import { localLayerFooter, remoteLayerFooter } from "./whatsapp-remote-footer.js";
import { footerAudienceAllowed, noticeMessage } from "./whatsapp-footer-audience.js";

const proposedPlanOpenTagPattern = /^\s*<\s*proposed[\s_-]*plan\s*>\s*/i;
const proposedPlanCloseTagPattern = /\s*<\s*\/\s*proposed[\s_-]*plan\s*>\s*$/i;
let lastProcessCpuSample = null;

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function proposedPlanEnvelopeBody(value) {
  const text = String(value || "").trim();
  if (!proposedPlanOpenTagPattern.test(text)) return null;
  return text.replace(proposedPlanOpenTagPattern, "").replace(proposedPlanCloseTagPattern, "").trim();
}

export function stripProposedPlanEnvelope(value) {
  return proposedPlanEnvelopeBody(value) ?? String(value || "");
}

function formatMarkdownLinksForWhatsApp(value) {
  return String(value || "").replace(/\[([^\]\n]{1,180})\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => {
    const cleanLabel = String(label || "").trim();
    const cleanUrl = String(url || "").trim();
    return cleanLabel && cleanLabel !== cleanUrl ? `${cleanLabel}: ${cleanUrl}` : cleanUrl;
  });
}

function formatMarkdownBoldForWhatsApp(value) {
  const text = String(value || "");
  let formatted = "";
  let index = 0;

  while (index < text.length) {
    const start = text.indexOf("**", index);
    if (start === -1) {
      formatted += text.slice(index);
      break;
    }

    const end = text.indexOf("**", start + 2);
    if (end === -1) {
      formatted += text.slice(index);
      break;
    }

    const body = text.slice(start + 2, end);
    formatted += text.slice(index, start);
    formatted += body.trim() ? `*${body}*` : `**${body}**`;
    index = end + 2;
  }

  return formatted;
}

function formatWhatsAppLine(value) {
  const heading = String(value || "").match(/^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/);
  const line = heading ? `${heading[1]}${heading[2]}` : String(value || "");
  const chunks = line.split(/(`[^`]*`)/g);
  return chunks
    .map((chunk) => {
      if (chunk.startsWith("`") && chunk.endsWith("`")) return chunk;
      return formatMarkdownBoldForWhatsApp(formatMarkdownLinksForWhatsApp(chunk));
    })
    .join("");
}

export function formatWhatsAppOutboundText(value) {
  const lines = stripProposedPlanEnvelope(value).replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  const formatted = lines.map((line) => {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    return inFence ? line : formatWhatsAppLine(line);
  });
  return formatted.join("\n").trim();
}

function debugFooterFlagEnabled(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(normalized);
}

function footerEnabled(env = process.env) {
  return [
    env.ORKESTR_WHATSAPP_DEBUG_FOOTER,
    env.WA_DEBUG_FOOTER,
    env.WA_APPEND_DEBUG_FOOTER,
  ].some(debugFooterFlagEnabled);
}

// Matches the multi-line footer ("dbg: ..." then provider quota lines and the
// queue/load line) and the older single-line "dbg: m:..." footer.
// A remote footer may start at its layer line ("⚡ Quick:", or "🧠 Deep:" /
// "🧠 Coordinator:" when Quick is unobserved) or, with no observed layer, at
// the quota lines; that form must end with the "help:/help" load line.
const WHATSAPP_DEBUG_FOOTER_PATTERN = /\s*(?:\n(?:dbg:|⚡ Quick:|🧠 (?:Deep|Coordinator):)[^\n]*(?:\n(?:codex|claude)\b[^\n]*){0,2}(?:\n(?:q|queue):[^\n]*)?|\n(?:(?:codex|claude)\b[^\n]*\n){0,2}(?:q|queue):[^\n]*help:\/help)\s*$/i;

// Repeated until none is left, so a text that already carries stacked
// footers (a re-sent or quoted message) never keeps one under the new footer.
export function stripWhatsAppDebugFooter(text) {
  let current = String(text || "");
  for (let i = 0; i < 8; i++) {
    const next = current.replace(WHATSAPP_DEBUG_FOOTER_PATTERN, "");
    if (next === current) break;
    current = next;
  }
  return current.trim();
}

function shortReasoningEffort(value) {
  const effort = pickString(value).toLowerCase();
  if (!effort) return "";
  if (effort === "xhigh" || effort === "extra-high" || effort === "extra_high") return "xh";
  if (effort === "high") return "h";
  if (effort === "medium") return "m";
  if (effort === "low") return "l";
  return effort.replace(/\s+/g, "-").slice(0, 8);
}

function claudeCodeThread(thread = {}) {
  const executor = thread?.executor && typeof thread.executor === "object" ? thread.executor : {};
  const metadata = executor.metadata && typeof executor.metadata === "object" ? executor.metadata : {};
  const runtime = thread?.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  return [
    thread.runtimeKind,
    runtime.runtimeKind,
    executor.type,
    executor.id,
    metadata.runtimeKind,
  ].some((value) => pickString(value).toLowerCase() === "claude-code");
}

function codexModelDebugLabel(message = {}, thread = {}, env = process.env) {
  const metadata = thread?.executor?.metadata && typeof thread.executor.metadata === "object" ? thread.executor.metadata : {};
  const model = pickString(
    message.codexModel,
    message.model,
    thread.codexModel,
    metadata.codexModel,
    env.ORKESTR_DEFAULT_CODEX_MODEL,
    env.OPENAI_MODEL,
  );
  const effort = shortReasoningEffort(
    pickString(
      message.codexReasoningEffort,
      message.reasoningEffort,
      thread.codexReasoningEffort,
      metadata.codexReasoningEffort,
      env.ORKESTR_DEFAULT_CODEX_REASONING,
      env.OPENAI_REASONING_EFFORT,
    ),
  );
  // An unknown model or effort is omitted, never shown as "unknown".
  return [model, effort].filter(Boolean).join("/");
}

function claudeModelDebugLabel(message = {}, thread = {}) {
  const metadata = thread?.executor?.metadata && typeof thread.executor.metadata === "object" ? thread.executor.metadata : {};
  const model = pickString(
    message.claudeModel,
    message.model,
    thread.claudeModel,
    metadata.claudeModel,
    thread.claudeModelResolved,
    metadata.claudeModelResolved,
  );
  const effort = shortReasoningEffort(
    pickString(
      message.claudeEffort,
      message.reasoningEffort,
      thread.claudeEffort,
      metadata.claudeEffort,
    ),
  );
  // An unknown model or effort is omitted, never shown as "unknown".
  return [model, effort].filter(Boolean).join("/");
}

function modelDebugLabel(message = {}, thread = {}, env = process.env) {
  return claudeCodeThread(thread)
    ? claudeModelDebugLabel(message, thread)
    : codexModelDebugLabel(message, thread, env);
}

function codexFastDebugValue(message = {}, thread = {}) {
  const metadata = thread?.executor?.metadata && typeof thread.executor.metadata === "object" ? thread.executor.metadata : {};
  return pickString(message.codexServiceTier, thread.codexServiceTier, metadata.codexServiceTier).toLowerCase() === "priority";
}

function codexModeDebugValue(message = {}, thread = {}) {
  const mode = pickString(
    message.codexModeLive,
    thread.codexModeLive,
    thread.runtime?.progress?.codexMode,
    thread.runtime?.codexMode,
    thread.codexModeSource === "runtime-pane" ? thread.codexMode : "",
  ).toLowerCase();
  return mode === "plan" ? "plan" : "";
}

function queueDebugCount(messages = [], currentMessage = null) {
  const activeMessageId = pickString(currentMessage?.id);
  const activeParentId = pickString(currentMessage?.parentMessageId);
  return messages.filter((message) => {
    if (activeMessageId && message?.id === activeMessageId) return false;
    if (activeParentId && message?.id === activeParentId) return false;
    if (String(message?.role || "").toLowerCase() !== "user") return false;
    const state = String(message?.state || "").toLowerCase();
    const deliveryState = String(message?.deliveryState || "").toLowerCase();
    return ["queued", "pending_delivery"].includes(state) ||
      ["blocked_frozen_runtime", "waiting_runtime_ready", "waiting_runtime_start", "retrying_delivery"].includes(deliveryState);
  }).length;
}

function queueNoticeDebugCount(messages = [], currentMessage = null) {
  const related = queueDebugCount(messages, currentMessage);
  const state = String(currentMessage?.state || "").toLowerCase();
  const deliveryState = String(currentMessage?.deliveryState || "").toLowerCase();
  const currentQueued = ["queued", "pending_delivery"].includes(state) ||
    [
      "awaiting_active_turn",
      "awaiting_approval",
      "awaiting_runtime_completion",
      "interrupting",
      "recovering_stale_ack",
      "retrying_delivery",
      "waiting_runtime_ready",
      "waiting_runtime_start",
      "waking",
    ].includes(deliveryState);
  return related + (currentQueued ? 1 : 0);
}

function queueNoticeDebugReason(message = {}) {
  const reason = String(message?.deliveryState || "").trim().toLowerCase();
  if (reason === "awaiting_active_turn") return "active-turn";
  if (reason === "awaiting_approval") return "awaiting-approval";
  if (reason === "awaiting_runtime_completion") return "runtime-busy";
  if (reason === "interrupting") return "interrupting";
  if (["waiting_runtime_start", "waking"].includes(reason)) return "waking";
  if (["recovering_stale_ack", "retrying_delivery"].includes(reason)) return "recovering";
  if (reason === "waiting_runtime_ready") return "handoff-delayed";
  return reason.replace(/_/g, "-").slice(0, 32) || "queued";
}

function loadDebugPercent() {
  const cpuCount = os.cpus().length || 1;
  const percent = Math.round(((os.loadavg()[0] || 0) / cpuCount) * 100);
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(999, percent));
}

function processCpuDebugPercent() {
  const current = {
    usage: process.cpuUsage(),
    sampledAtMs: Date.now(),
  };
  const previous = lastProcessCpuSample;
  lastProcessCpuSample = current;
  if (!previous) return 0;
  const elapsedMs = Math.max(1, current.sampledAtMs - previous.sampledAtMs);
  const usedMicros =
    (current.usage.user - previous.usage.user) +
    (current.usage.system - previous.usage.system);
  const percent = Math.round(usedMicros / (elapsedMs * 1000) * 100);
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(999, percent));
}

// Configured remote runtime backend ids (ORKESTR_REMOTE_*_BACKENDS_JSON keys and
// the single-backend id). Only the ids are read; tokens are never touched.
function configuredRemoteBackendIds(env = process.env) {
  const ids = new Set();
  for (const raw of [env?.ORKESTR_REMOTE_THREAD_BACKENDS_JSON, env?.ORKESTR_REMOTE_RUNTIME_BACKENDS_JSON, env?.ORKESTR_REMOTE_BACKENDS_JSON]) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) for (const id of Object.keys(parsed)) if (id.trim()) ids.add(id.trim());
    } catch { /* an unparseable backend map adds no ids */ }
    break;
  }
  const single = pickString(env?.ORKESTR_REMOTE_THREAD_BACKEND_ID, env?.ORKESTR_REMOTE_RUNTIME_BACKEND_ID, env?.ORKESTR_REMOTE_BACKEND_ID);
  if (single) ids.add(single);
  return ids;
}

// A reply mirrored from a remote runtime (for example the Rust V2 app): it
// carries the remote message identity, or its source names a configured backend.
function remoteRuntimeReply(message = {}, env = process.env) {
  if (!message || String(message.role || "").toLowerCase() === "user") return false;
  if (pickString(message.remoteMessageId)) return true;
  const source = pickString(message.source).toLowerCase();
  if (!source) return false;
  for (const id of configuredRemoteBackendIds(env)) {
    const backend = id.toLowerCase();
    if (source === backend || source.startsWith(`${backend}-`)) return true;
  }
  return false;
}

export function shouldAppendWhatsAppDebugFooter(message = {}, env = process.env, deliveryType = "", thread = null, messages = []) {
  if (!footerEnabled(env)) return false;
  if (thread && threadRequiresTenantIsolation(thread, env)) return false;
  if (thread && threadSuppressesWhatsAppDebugFooter(thread, message?.chatId, env)) return false;
  // Every chat, shared groups and replies to a member's input included; a
  // notice gets the compact quota/load footer (see whatsappDebugFooter).
  if (!footerAudienceAllowed({ message, thread, messages, deliveryType, allowNotice: true })) return false;
  if (noticeMessage(message, deliveryType)) return true;
  if (codexAssistantSource(message) || message.source === "claude-code" || message.source === "orkestr_runtime") return true;
  if (remoteRuntimeReply(message, env)) return true;
  // A scheduled timer's answer is a model reply; the other types are notices,
  // which noticeMessage has already admitted above.
  return ["timer_reply", "delivery_error", "mode_queued", "queue_notice", "router_update"].includes(String(deliveryType || "").trim());
}

// The q/load line, the same on every footer: queue depth (a queue notice
// also names why it waits), host load, this process's CPU, and the /help hint.
function queueLoadLine(message = {}, messages = [], deliveryType = "") {
  const queueNotice = String(deliveryType || "").trim() === "queue_notice";
  return [
    ...(queueNotice
      ? [`queue:${queueNoticeDebugCount(messages, message)}`, `reason:${queueNoticeDebugReason(message)}`]
      : [`q:${queueDebugCount(messages, message)}`]),
    `load:${loadDebugPercent()}%`,
    `api:${processCpuDebugPercent()}%`,
    "help:/help",
  ].join(" · ");
}

// The one footer spec, for every message type in every chat with the footer on:
//
//   model reply (Quick, Deep final, grouped/parallel Deep final, coordinator
//   post, timer answer, health-probe answer, V1-native reply):
//     ⚡ Quick: <provider model | —> · 🧠 Deep: <provider model | pending | —> · ▶ <writer>[ · update]
//     codex <5h/wk quota>      ("codex: no data" without a snapshot)
//     claude <5h/wk quota>
//     q:<n> · load:<n>% · api:<n>% · help:/help
//   notice (⚙️ System, 🚨 alert, Operator post, queue/mode/router/delivery
//   notice): the same three quota and q/load lines, no layer line.
//
// Shared groups and replies to a member's input get it too; only tenant
// isolation, the per-thread/chat footer-off switch and the global footer flag
// remove it. Commands are listed by /help.
export function whatsappDebugFooter({ message = {}, thread = {}, messages = [], deliveryType = "final", env = process.env } = {}) {
  if (noticeMessage(message, deliveryType)) return whatsappNoticeFooter({ message, thread, messages, deliveryType, env });
  // A progress update (not a final) says so after the writer.
  const progress = String(deliveryType || "").trim() === "progress" || String(message?.remoteKind || "").toLowerCase() === "progress";
  const layer = layerLine({ message, thread, messages, env }) + (progress ? " · update" : "");
  return [layer, ...quotaLines(thread, env), queueLoadLine(message, messages, deliveryType)]
    .join("\n");
}

// Always one line per provider, codex first, on every footer alike; a
// provider without quota data reads "<provider>: no data", never unknown.
function quotaLines(thread = {}, env = process.env) {
  return dualProviderQuotaLines(thread, env);
}

function layerLine({ message = {}, thread = {}, messages = [], env = process.env } = {}) {
  if (remoteRuntimeReply(message, env)) return remoteLayerFooter(message, messages);
  const isClaude = claudeCodeThread(thread);
  const provider = threadQuotaProvider(thread) || (isClaude ? "claude" : "codex");
  const model = modelDebugLabel(message, thread, env);
  const mode = codexModeDebugValue(message, thread);
  return localLayerFooter(`${provider} ${model || "?"}`, [
    ...(!isClaude && mode ? [`mode:${mode}`] : []),
    ...(!isClaude && codexFastDebugValue(message, thread) ? ["fast:on"] : []),
  ]);
}

// Notice footer: a notice has no run, so it carries only the quota lines and
// the q/load line, exactly as a model reply's footer without its layer line.
export function whatsappNoticeFooter({ message = {}, thread = {}, messages = [], deliveryType = "", env = process.env } = {}) {
  return [...quotaLines(thread, env), queueLoadLine(message, messages, deliveryType)].join("\n");
}

export function appendWhatsAppDebugFooter(text, options = {}) {
  const cleanText = stripWhatsAppDebugFooter(text);
  if (options.appendDebugFooter === false || options.debugFooter === false) return cleanText;
  if (!cleanText || !shouldAppendWhatsAppDebugFooter(options.message, options.env, options.deliveryType, options.thread, options.messages)) return cleanText;
  return `${cleanText}\n\n${whatsappDebugFooter(options)}`;
}
