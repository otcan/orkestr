import { markConnectorDeliverySignal } from "./connector-delivery-signals.js";
import { appendThreadMessage, listThreadMessages } from "./threads.js";
import { replyDeliveryProjectionParent, trustedHushReplyDeliveryIntent } from "./reply-delivery-intent.js";
import { createClaudeCodeInterimTextMirror, redactClaudeCodeProgressText as redactProgressText } from "./claude-code-interim-text.js";

function clean(value = "") {
  return String(value || "").trim();
}

function whatsappOrigin(message = {}) {
  return clean(message.connector).toLowerCase() === "whatsapp" ||
    ["whatsapp", "whatsapp_inbound", "whatsapp_client"].includes(clean(message.source).toLowerCase());
}

function eventContent(event = {}) {
  if (clean(event.type).toLowerCase() !== "assistant") return [];
  if (Array.isArray(event.message?.content)) return event.message.content;
  return Array.isArray(event.content) ? event.content : [];
}

function toolProgressText(blocks = []) {
  const names = blocks
    .filter((block) => clean(block?.type).toLowerCase() === "tool_use")
    .map((block) => clean(block?.name).toLowerCase())
    .filter(Boolean);
  if (names.some((name) => /edit|write|notebook/.test(name))) return "Claude Code is applying changes.";
  if (names.some((name) => /test|bash|shell|command/.test(name))) return "Claude Code is running a repository command or check.";
  if (names.some((name) => /read|glob|grep|search|list/.test(name))) return "Claude Code is inspecting the relevant code.";
  return "Claude Code is continuing with repository tools.";
}

// Generic label for a tool-backed event. It never includes tool input and is
// only used as a fallback while Claude itself has not narrated for a while.
export function claudeCodeToolProgressLabel(event = {}) {
  const blocks = eventContent(event);
  if (!blocks.some((block) => clean(block?.type).toLowerCase() === "tool_use")) return "";
  return toolProgressText(blocks);
}

function progressIntervalMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CLAUDE_PROGRESS_MIN_INTERVAL_MS ?? 15_000);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 15_000;
}

function labelFallbackMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CLAUDE_PROGRESS_LABEL_FALLBACK_MS ?? 60_000);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 60_000;
}

function progressLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_CLAUDE_PROGRESS_MAX_MESSAGES ?? 12);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.floor(parsed))) : 12;
}

// Format elapsed milliseconds as "Xm Ys" or "Zs".
function formatElapsed(ms) {
  const totalSecs = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const minutes = Math.floor(totalSecs / 60);
  const secs = Math.floor(totalSecs % 60);
  return minutes > 0 ? `${minutes}m ${secs}s` : `${secs}s`;
}

// Progress is persisted as thread commentary (and so delivered) only for
// WhatsApp-origin inputs. `onProgress({ kind, text })` receives the same
// throttled, redacted progress for every origin (API, timer, job callers).
export function createClaudeCodeProgressReporter({ thread = {}, parentMessage = {}, attemptId = "", onPersisted = null, onProgress = null, eventKeyPrefix = "" } = {}, env = process.env) {
  const deliveryParent = replyDeliveryProjectionParent(parentMessage) || parentMessage;
  const persistEnabled = whatsappOrigin(deliveryParent) && !trustedHushReplyDeliveryIntent(parentMessage);
  const enabled = persistEnabled || typeof onProgress === "function";
  const seen = new Set();
  let sequence = 0;
  let persisted = 0;
  let lastPersistedAt = 0;
  let lastHeartbeatAt = 0;
  let lastClaudeTextAt = Date.now();
  let pending = Promise.resolve();

  function persist(text, kind, key) {
    try { onProgress?.({ kind, text }); } catch {}
    if (!persistEnabled) return pending;
    const eventId = `claude-code:${clean(thread.id)}:${clean(attemptId)}:${kind}:${clean(eventKeyPrefix)}${clean(key) || sequence}`;
    pending = pending.then(async () => {
      const existing = (await listThreadMessages(thread.id, env)).find((message) => message.eventId === eventId);
      if (existing) return existing;
      const message = await appendThreadMessage(thread.id, {
        role: "assistant",
        source: "claude-code",
        phase: "commentary",
        state: "completed",
        text,
        parentMessageId: parentMessage.id,
        eventId,
        executorKind: "claude-code",
        executorTurnId: attemptId,
        connector: deliveryParent.connector || "",
        chatId: deliveryParent.chatId || "",
        accountId: deliveryParent.accountId || "",
        sourceEventId: parentMessage.sourceEventId || "",
        routerTraceId: parentMessage.routerTraceId || "",
        turnId: parentMessage.turnId || "",
      }, env);
      markConnectorDeliverySignal(message);
      await onPersisted?.(message);
      return message;
    }).catch(() => null);
    return pending;
  }

  function queue(text, key, { force = false, affectsThrottle = true } = {}) {
    text = redactProgressText(text).slice(0, 1600);
    if (!enabled || !text || seen.has(text) || persisted >= progressLimit(env)) return pending;
    const now = Date.now();
    if (!force && now - lastPersistedAt < progressIntervalMs(env)) return pending;
    seen.add(text);
    persisted += 1;
    if (affectsThrottle) lastPersistedAt = now;
    sequence += 1;
    return persist(text, "progress", key);
  }

  // Claude's own narration has its own dedupe/throttle/cap budget.
  const interim = createClaudeCodeInterimTextMirror({
    env,
    publish(text) {
      if (!enabled) return;
      lastClaudeTextAt = Date.now();
      sequence += 1;
      void persist(text, "text", sequence);
    },
  });

  return {
    start() {
      return queue("Claude Code started working on your request.", "started", { force: true, affectsThrottle: false });
    },
    observe(event = {}) {
      if (interim.observe(event)) lastClaudeTextAt = Date.now();
      if (Date.now() - lastClaudeTextAt < labelFallbackMs(env)) return;
      const label = claudeCodeToolProgressLabel(event);
      if (label) void queue(label, sequence + 1);
    },
    // Rate-limited heartbeat for long-running tool calls.
    // Emits a safe "still working" message with elapsed duration — no tool
    // input, paths, or secrets are included.
    heartbeat(toolElapsedMs) {
      if (!enabled) return pending;
      const now = Date.now();
      if (now - lastHeartbeatAt < progressIntervalMs(env)) return pending;
      lastHeartbeatAt = now;
      sequence += 1;
      return persist(`Claude Code is still working (${formatElapsed(toolElapsedMs)} elapsed).`, "heartbeat", sequence);
    },
    // Ends interim mirroring (held or throttled text may be the final answer).
    flush() {
      interim.finish();
      return pending;
    },
  };
}
