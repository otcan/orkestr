// Leaves the attached-terminal (raw-terminal) Codex surface so a thread can be
// switched to another executor in place. Mirrors the terminal -> Codex API
// runtime-type switch, without starting the Codex app-server: the executor
// switch starts whichever executor comes next.
import { getThread, updateThread } from "./threads.js";

export function rawTerminalExitPatch(thread = {}) {
  return {
    state: "ready",
    runtimeKind: "codex-app-server",
    terminalMode: null,
    executorId: "codex",
    executor: {
      ...(thread.executor || {}),
      id: "codex",
      type: "codex",
      transport: "app-server",
      metadata: {
        ...(thread.executor?.metadata || {}),
        transport: "app-server",
        runtimeKind: "codex-app-server",
        terminalMode: null,
      },
    },
    runtime: {
      ...(thread.runtime || {}),
      state: "ready",
      runtimeKind: "codex-app-server",
      terminalMode: null,
      activeTurnId: null,
      pendingRequest: null,
    },
  };
}

export async function leaveRawTerminalForExecutorSwitch(thread, env = process.env, { sleepThread } = {}) {
  const sleep = sleepThread || (await import("./runtime-leases.js")).sleepThread;
  await sleep(thread.id, { reason: "executor_switch_leave_terminal", kill: true }, env).catch(() => null);
  const current = await getThread(thread.id, env) || thread;
  // Build the patch from the latest record under the store lock.
  return updateThread(current.id, (latest) => rawTerminalExitPatch(latest), env);
}
