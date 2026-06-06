import os from "node:os";
import { threadRequiresTenantIsolation } from "../../core/src/tenant-policy.js";
import { codexAssistantSource } from "./whatsapp-mirror-policy.js";

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

function footerEnabled(env = process.env) {
  const value = String(env.ORKESTR_WHATSAPP_DEBUG_FOOTER ?? "0").trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(value);
}

export function stripWhatsAppDebugFooter(text) {
  return String(text || "").replace(/\s*\ndbg:\s*m:[^\n]*\s*$/i, "").trim();
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

function codexModelDebugLabel(message = {}, thread = {}, env = process.env) {
  const metadata = thread?.executor?.metadata && typeof thread.executor.metadata === "object" ? thread.executor.metadata : {};
  const model = pickString(
    message.codexModel,
    message.model,
    thread.codexModel,
    metadata.codexModel,
    env.ORKESTR_DEFAULT_CODEX_MODEL,
    env.OPENAI_MODEL,
    "unknown",
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
  return effort ? `${model}/${effort}` : model;
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

export function shouldAppendWhatsAppDebugFooter(message = {}, env = process.env, deliveryType = "", thread = null) {
  if (!footerEnabled(env)) return false;
  if (thread && threadRequiresTenantIsolation(thread, env)) return false;
  if (codexAssistantSource(message) || message.source === "orkestr_runtime") return true;
  return ["delivery_error", "mode_queued", "queue_notice", "router_update"].includes(String(deliveryType || "").trim());
}

function footerMessageType(deliveryType = "") {
  return ["progress", "queue_notice", "mode_queued", "delivery_error", "router_update"].includes(String(deliveryType || "").trim())
    ? "update"
    : "final";
}

export function whatsappDebugFooter({ message = {}, thread = {}, messages = [], deliveryType = "final", env = process.env } = {}) {
  const mode = codexModeDebugValue(message, thread);
  const parts = [
    `m:${codexModelDebugLabel(message, thread, env)}`,
    ...(mode ? [`mode:${mode}`] : []),
    `msg:${footerMessageType(deliveryType)}`,
    `q:${queueDebugCount(messages, message)}`,
    `load:${loadDebugPercent()}%`,
    `api:${processCpuDebugPercent()}%`,
    "help:/help",
    ...(mode === "plan" ? ["switch:/code"] : []),
  ];
  return `dbg: ${parts.join(" · ")}`;
}

export function appendWhatsAppDebugFooter(text, options = {}) {
  const cleanText = stripWhatsAppDebugFooter(text);
  if (!cleanText || !shouldAppendWhatsAppDebugFooter(options.message, options.env, options.deliveryType, options.thread)) return cleanText;
  return `${cleanText}\n\n${whatsappDebugFooter(options)}`;
}
