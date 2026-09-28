// Mirrors Claude Code's own interim assistant text (the short narration it
// writes between tool calls) as commentary, the way Codex commentary is
// mirrored. Text is only released once a later tool call proves it was not
// the final answer; text still held when the turn ends is dropped, so the
// final answer is never duplicated as commentary.

function clean(value = "") {
  return String(value || "").trim();
}

export function redactClaudeCodeProgressText(value = "") {
  return clean(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(authorization|token|secret|password|api[_-]?key|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/\/(?:root|home|opt|etc|var|run|tmp)\/[^\s"'`<>()[\]{}]+/g, "[redacted-path]");
}

function envInt(env, key, fallback, min, max) {
  const parsed = Number(env?.[key] ?? fallback);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

export function claudeCodeInterimTextSettings(env = process.env) {
  return {
    minIntervalMs: envInt(env, "ORKESTR_CLAUDE_INTERIM_TEXT_MIN_INTERVAL_MS", 20_000, 0, 60 * 60_000),
    maxChars: envInt(env, "ORKESTR_CLAUDE_INTERIM_TEXT_MAX_CHARS", 600, 80, 4_000),
    maxMessages: envInt(env, "ORKESTR_CLAUDE_INTERIM_TEXT_MAX_MESSAGES", 40, 1, 200),
  };
}

export function normalizeClaudeCodeInterimText(value = "", maxChars = 600) {
  const text = redactClaudeCodeProgressText(String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n"));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function topLevelAssistantBlocks(event = {}) {
  if (clean(event.type).toLowerCase() !== "assistant") return null;
  // Sub-agent transcripts are internal; only the main conversation narrates.
  if (clean(event.parent_tool_use_id || event.parentToolUseId)) return null;
  if (Array.isArray(event.message?.content)) return event.message.content;
  return Array.isArray(event.content) ? event.content : [];
}

// publish(text) persists one commentary message. Returns an observer whose
// observe(event) reports whether the event carried top-level assistant text.
export function createClaudeCodeInterimTextMirror({ publish, env = process.env, now = () => Date.now() } = {}) {
  const settings = claudeCodeInterimTextSettings(env);
  const seen = new Set();
  let held = [];
  let pending = [];
  let published = 0;
  let lastPublishedAt = -Infinity;
  let timer = null;
  let finished = false;

  function emit(parts) {
    const text = normalizeClaudeCodeInterimText(parts.join("\n\n"), settings.maxChars);
    if (!text || published >= settings.maxMessages) return;
    published += 1;
    lastPublishedAt = now();
    publish?.(text);
  }

  function flushPending() {
    timer = null;
    if (finished || !pending.length) return;
    const parts = pending;
    pending = [];
    emit(parts);
  }

  function release(parts) {
    for (const part of parts) {
      const key = normalizeClaudeCodeInterimText(part, settings.maxChars);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      pending.push(part);
    }
    if (!pending.length || timer) return;
    const waitMs = lastPublishedAt + settings.minIntervalMs - now();
    if (waitMs <= 0) return flushPending();
    // Coalesce everything confirmed during the throttle window into one message.
    timer = setTimeout(flushPending, waitMs);
    timer.unref?.();
  }

  return {
    observe(event = {}) {
      if (finished) return false;
      const blocks = topLevelAssistantBlocks(event);
      if (!blocks) return false;
      let sawText = false;
      for (const block of blocks) {
        const type = clean(block?.type).toLowerCase();
        if (type === "text" || type === "output_text") {
          const text = clean(block?.text || block?.content);
          if (text) { held.push(text); sawText = true; }
        } else if (type === "tool_use" && held.length) {
          const parts = held;
          held = [];
          release(parts);
        }
      }
      return sawText;
    },
    // Drops held (possibly final) and still-throttled text at turn end.
    finish() {
      finished = true;
      held = [];
      pending = [];
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
