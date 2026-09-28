import { getThread } from "./threads.js";

// Turn-completion hook shared by the Codex app-server and Claude Code
// executors. It is cheap when no switch is pending and never throws, so a
// deferred executor switch can never break turn completion.
export async function applyPendingExecutorSwitchAfterTurn(threadId, env = process.env) {
  try {
    const thread = await getThread(threadId, env);
    if (!thread?.pendingExecutorSwitch) return null;
    const { applyPendingExecutorSwitch } = await import("./thread-executor-switch.js");
    return await applyPendingExecutorSwitch(thread.id, {}, env);
  } catch {
    return null;
  }
}
