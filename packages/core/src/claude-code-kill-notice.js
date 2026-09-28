// Visible final notice for a Claude Code turn that Orkestr itself stopped
// (tool deadline, turn timeout, semantic stall, output cap). User-requested
// interrupts (/stop, /now) never reach this path: they settle as interrupted
// turns, not failures.
import { appendThreadMessage, listThreadMessages } from "./threads.js";
import { markConnectorDeliverySignal } from "./connector-delivery-signals.js";
import { replyDeliveryProjectionParent } from "./reply-delivery-intent.js";
import { summarizeClaudeCodePartialWork } from "./claude-code-partial-work.js";
import { persistInterruptedClaudeCodeSession } from "./claude-code-interrupt-resume.js";

const terminationReasons = {
  claude_code_tool_timeout: "a single tool call ran past the per-tool time limit",
  claude_code_timeout: "the turn ran past the overall turn time limit",
  claude_code_semantic_stall: "Claude Code produced no output for too long",
  claude_code_output_limit: "the turn exceeded the output size limit",
};

function clean(value = "") {
  return String(value || "").trim();
}

export function formatClaudeCodeElapsed(ms) {
  const totalSecs = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSecs / 3600);
  const minutes = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hours) return `${hours}h ${minutes}m`;
  return minutes ? `${minutes}m ${secs}s` : `${secs}s`;
}

// Raw supervisor code when Orkestr terminated the turn, otherwise "".
export function claudeCodeTerminationReason(error = {}) {
  const code = clean(error?.code);
  if (!Object.hasOwn(terminationReasons, code)) return "";
  if (error?.termination?.userInterrupted) return "";
  return code;
}

export function claudeCodeKillNoticeText({ reason = "", toolName = "", toolElapsedMs = null, turnElapsedMs = null, partialWork = null } = {}) {
  const why = terminationReasons[reason] || "it hit a runtime limit";
  const tool = clean(toolName).replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80);
  const lines = [`Orkestr stopped this Claude Code turn before it finished: ${why}.`];
  const details = [];
  if (tool) details.push(`Tool: ${tool}${Number.isFinite(toolElapsedMs) ? ` (running ${formatClaudeCodeElapsed(toolElapsedMs)})` : ""}.`);
  if (Number.isFinite(turnElapsedMs)) details.push(`Turn time: ${formatClaudeCodeElapsed(turnElapsedMs)}.`);
  if (details.length) lines.push(details.join(" "));
  const repositories = Array.isArray(partialWork?.repositories) ? partialWork.repositories : [];
  const changed = repositories.filter((repo) => repo.changedFiles > 0);
  if (changed.length) {
    lines.push("", "Partial work (uncommitted changes):");
    for (const repo of changed) {
      const branch = clean(repo.branch) && clean(repo.branch) !== "HEAD" ? ` [${clean(repo.branch)}]` : "";
      lines.push(`- ${repo.path}${branch}: ${repo.changedFiles} changed file${repo.changedFiles === 1 ? "" : "s"}`);
    }
  } else if (partialWork && !partialWork.timedOut) {
    lines.push("", "No uncommitted changes were found in the touched repositories.");
  }
  if (partialWork?.timedOut) lines.push("(The partial-work check timed out; the list may be incomplete.)");
  lines.push("", "Reply \"continue\" to resume from where it stopped.");
  return lines.join("\n");
}

export function claudeCodeKillNoticeEventId(threadId, attemptId) {
  return `claude-code:${threadId}:${attemptId}:terminated`;
}

// Keeps the stopped turn's session so "continue" resumes its transcript, then
// appends the notice as the turn's visible final reply. Never throws.
export async function appendClaudeCodeKillNotice({ thread = {}, parent = {}, attemptId = "", error = {}, workspace = null, env = process.env } = {}) {
  const reason = claudeCodeTerminationReason(error);
  if (!reason) return null;
  try {
    await persistInterruptedClaudeCodeSession(thread, error.sessionId, env);
    const eventId = claudeCodeKillNoticeEventId(thread.id, attemptId);
    const existing = (await listThreadMessages(thread.id, env)).find((message) => message.eventId === eventId);
    if (existing) return existing;
    const termination = error.termination || {};
    const partialWork = await summarizeClaudeCodePartialWork({
      // Only the thread's own workspace; never the host process directory.
      cwd: clean(thread.cwd || thread.workspace || thread.repoPath || thread.worktreePath),
      paths: workspace?.paths || [],
      timeoutMs: Number(env.ORKESTR_CLAUDE_PARTIAL_WORK_TIMEOUT_MS || 8_000),
    }).catch(() => null);
    const route = replyDeliveryProjectionParent(parent) || parent;
    const message = await appendThreadMessage(thread.id, {
      role: "assistant", source: "claude-code", phase: "final_answer", state: "completed",
      text: claudeCodeKillNoticeText({ reason, ...termination, partialWork }),
      parentMessageId: parent.id, eventId,
      executorKind: "claude-code", executorTurnId: attemptId,
      connector: route.connector || "", chatId: route.chatId || "", accountId: route.accountId || "",
      sourceEventId: parent.sourceEventId || "", routerTraceId: parent.routerTraceId || "", turnId: parent.turnId || "",
    }, env);
    markConnectorDeliverySignal(message);
    return message;
  } catch {
    return null;
  }
}
