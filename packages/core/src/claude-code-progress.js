import { markConnectorDeliverySignal } from "./connector-delivery-signals.js";
import { appendThreadMessage, listThreadMessages } from "./threads.js";
import { replyDeliveryProjectionParent, trustedHushReplyDeliveryIntent } from "./reply-delivery-intent.js";

function clean(value = "") {
  return String(value || "").trim();
}

function redactProgressText(value = "") {
  return clean(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(authorization|token|secret|password|api[_-]?key|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/\/(?:root|home|opt|etc|var|run|tmp)\/[^\s"'`<>()[\]{}]+/g, "[redacted-path]");
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

export function claudeCodeProgressText(event = {}) {
  const blocks = eventContent(event);
  if (!blocks.some((block) => clean(block?.type).toLowerCase() === "tool_use")) return "";
  const text = blocks
    .filter((block) => ["text", "output_text"].includes(clean(block?.type).toLowerCase()))
    .map((block) => clean(block?.text || block?.content))
    .filter(Boolean)
    .join("\n")
    .trim();
  return redactProgressText(text || toolProgressText(blocks)).slice(0, 1600);
}

function progressIntervalMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CLAUDE_PROGRESS_MIN_INTERVAL_MS ?? 15_000);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 15_000;
}

function progressLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_CLAUDE_PROGRESS_MAX_MESSAGES ?? 12);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.floor(parsed))) : 12;
}

export function createClaudeCodeProgressReporter({ thread = {}, parentMessage = {}, attemptId = "", onPersisted = null } = {}, env = process.env) {
  const deliveryParent = replyDeliveryProjectionParent(parentMessage) || parentMessage;
  const enabled = whatsappOrigin(deliveryParent) && !trustedHushReplyDeliveryIntent(parentMessage);
  const seen = new Set();
  let sequence = 0;
  let persisted = 0;
  let lastPersistedAt = 0;
  let pending = Promise.resolve();

  function queue(text, key, { force = false, affectsThrottle = true } = {}) {
    text = redactProgressText(text).slice(0, 1600);
    if (!enabled || !text || seen.has(text) || persisted >= progressLimit(env)) return pending;
    const now = Date.now();
    if (!force && now - lastPersistedAt < progressIntervalMs(env)) return pending;
    seen.add(text);
    persisted += 1;
    if (affectsThrottle) lastPersistedAt = now;
    sequence += 1;
    const eventId = `claude-code:${clean(thread.id)}:${clean(attemptId)}:progress:${clean(key) || sequence}`;
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

  return {
    start() {
      return queue("Claude Code started working on your request.", "started", { force: true, affectsThrottle: false });
    },
    observe(event = {}) {
      const text = claudeCodeProgressText(event);
      if (text) void queue(text, sequence + 1);
    },
    flush() {
      return pending;
    },
  };
}
