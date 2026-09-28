import { appendThreadMessage, getThread, listThreadMessages } from "../../../../../packages/core/src/threads.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { runExecutorCommand } from "../../../../../packages/core/src/thread-executor-commands.js";
import { threadRuntimeSummary } from "../../thread-summary.js";

// Direct (non-queued) handling of `/agent`, `/claude` and `/codex` on the thread
// input API, used by the web UI and `orkestr send`.
export async function executorCommandInputResponse(thread: any, parsedCommand: any, body: Record<string, unknown>, principal: any) {
  const target = String(parsedCommand.text || "").trim().split(/\s+/)[0] || "";
  const claudeTarget = ["claude", "claude-code", "claude_code", "anthropic"].includes(target.toLowerCase());
  const result: any = claudeTarget && !isAdminPrincipal(principal)
    ? { ok: false, error: "claude_code_admin_runtime_required", replyText: "Claude Code is limited to the host admin's own threads." }
    : await runExecutorCommand(thread, String(parsedCommand.text || ""), {
      actor: "owner",
      principal,
      rawCommand: parsedCommand.rawCommand,
    });
  const message = await appendThreadMessage(thread.id, {
    role: "user",
    source: body.source || "executor_command",
    text: String(body.text || "").trim() || `/${parsedCommand.rawCommand || "agent"}`,
    state: result.ok ? "completed" : "failed",
    deliveryState: result.ok ? "delivered" : "failed",
    deliveredAt: new Date().toISOString(),
    observedVia: "orkestr_executor_command",
    error: result.ok ? null : result.replyText,
  });
  const current = await getThread(thread.id) || thread;
  return {
    ok: Boolean(result.ok),
    commandHandled: true,
    applied: Boolean(result.changed),
    deferred: Boolean(result.deferred),
    error: result.ok ? null : result.error || null,
    executor: result.executor || null,
    message,
    replyText: result.replyText,
    thread: await threadRuntimeSummary(current, await listThreadMessages(thread.id)),
  };
}
