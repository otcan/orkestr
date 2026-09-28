import { threadUsesClaudeCode } from "./claude-code-runtime-policy.js";
import { claudeCodeInstantInterruptEnabled } from "./claude-code-interrupt-resume.js";

// Which executors let an interactive input take effect on the active turn
// immediately: Codex steers it into the running turn; Claude Code interrupts
// the turn and resumes the same session with the new input.

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function isThreadObject(thread) {
  return Boolean(thread) && typeof thread === "object" && !Array.isArray(thread);
}

export function isCodexSteerCapableThread(thread = {}) {
  if (!isThreadObject(thread)) return false;
  const appServer = pickString(
    thread.runtimeKind,
    thread.runtime?.runtimeKind,
    thread.executor?.metadata?.runtimeKind,
    thread.executor?.transport,
  ).toLowerCase() === "codex-app-server" ||
    pickString(thread.executor?.transport).toLowerCase() === "app-server";
  if (appServer) return true;
  const values = [
    thread.runtimeKind,
    thread.runtime?.runtimeKind,
    thread.terminalMode,
    thread.runtime?.terminalMode,
    thread.executor?.transport,
    thread.executor?.metadata?.transport,
    thread.executor?.metadata?.runtimeKind,
  ].map((value) => pickString(value).toLowerCase());
  return values.some((value) => ["raw-terminal", "codex-tmux"].includes(value)) ||
    pickString(thread.executorId, thread.executor?.id, thread.executor?.type).toLowerCase() === "codex";
}

export function isInstantInterruptCapableThread(thread = {}, env = process.env) {
  if (!isThreadObject(thread)) return false;
  if (threadUsesClaudeCode(thread)) return claudeCodeInstantInterruptEnabled(env);
  return isCodexSteerCapableThread(thread);
}
