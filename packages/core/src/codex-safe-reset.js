import fs from "node:fs/promises";
import path from "node:path";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent } from "../../storage/src/store.js";
import { getThread, listThreadMessages, updateThread } from "./threads.js";
import { clean, codexSessionId, codexThreadId, nowIso } from "./codex-app-server-common.js";

function checkpointMessageText(message) {
  const role = clean(message?.role || "unknown");
  const phase = clean(message?.phase || "");
  const stamp = clean(message?.timestamp || message?.createdAt || "");
  const text = clean(message?.text || "");
  const header = [role, phase, stamp].filter(Boolean).join(" ");
  return [`### ${header || "message"}`, "", text || "(empty)"].join("\n");
}

export async function writeCodexSafeResetCheckpoint(thread, context = {}, env = process.env) {
  const paths = await ensureDataDirs(env);
  const messages = await listThreadMessages(thread.id, env).catch(() => []);
  const status = context.status || thread?.runtime?.codexStatus || null;
  const now = nowIso();
  const safeStamp = now.replace(/[:.]/g, "-");
  const dir = path.join(paths.home, "context-checkpoints", thread.id);
  const checkpointPath = path.join(dir, `${safeStamp}-safe-reset.md`);
  const recentMessages = messages.slice(-40);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const content = [
    `# Safe Reset Context Checkpoint: ${thread.name || thread.id}`,
    "",
    `Created: ${now}`,
    `Thread: ${thread.id}`,
    `Codex thread: ${codexThreadId(thread) || ""}`,
    `Reason: ${context.reason || "safe_reset"}`,
    `Runtime state: ${thread?.runtime?.state || thread?.state || "unknown"}`,
    `Codex status: ${status?.type || status?.state || "unknown"}`,
    "",
    "## Recent Messages",
    "",
    ...recentMessages.map(checkpointMessageText),
    "",
  ].join("\n");
  await fs.writeFile(checkpointPath, content, { mode: 0o600 });
  await appendEvent({
    type: "thread_safe_reset_context_checkpoint",
    threadId: thread.id,
    path: checkpointPath,
    messageCount: recentMessages.length,
    reason: context.reason || "safe_reset",
  }, env).catch(() => {});
  return {
    method: "manual_checkpoint",
    path: checkpointPath,
    messageCount: recentMessages.length,
  };
}

function codexSafeResetPatch(thread, checkpoint, reason) {
  const runtime = thread?.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  const metadata = thread?.executor?.metadata && typeof thread.executor.metadata === "object" ? thread.executor.metadata : {};
  const oldCodexThreadId = codexThreadId(thread);
  const oldCodexSessionId = codexSessionId(thread) || oldCodexThreadId;
  const archive = {
    codexThreadId: oldCodexThreadId || null,
    codexSessionId: oldCodexSessionId || null,
    reason,
    resetAt: nowIso(),
    checkpointPath: checkpoint?.path || null,
    previousState: thread?.state || null,
    previousRuntimeState: runtime.state || null,
  };
  return {
    state: "waking",
    lastError: null,
    runtimeKind: "codex-app-server",
    codexThreadId: null,
    codexSessionId: null,
    executor: {
      ...(thread.executor || {}),
      id: "codex",
      type: "codex",
      transport: "app-server",
      codexThreadId: null,
      codexSessionId: null,
      metadata: {
        ...metadata,
        transport: "app-server",
        runtimeKind: "codex-app-server",
        codexThreadId: null,
        codexSessionId: null,
        lastSafeReset: archive,
      },
    },
    runtime: {
      ...runtime,
      runtimeKind: "codex-app-server",
      state: "waking",
      activeTurnId: null,
      pendingRequest: null,
      codexStatus: null,
      lastTurnStatus: null,
      safeReset: archive,
    },
  };
}

export async function performNativeCodexSafeReset(threadOrId, options = {}, env = process.env) {
  const reason = options.reason || "safe_reset";
  const thread = typeof threadOrId === "string"
    ? await getThread(threadOrId, env)
    : threadOrId;
  if (!thread) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  if (typeof options.startThread !== "function") throw new Error("codex_app_server_safe_reset_start_required");
  const oldCodexThreadId = codexThreadId(thread);
  const oldCodexSessionId = codexSessionId(thread) || oldCodexThreadId;
  const checkpoint = await writeCodexSafeResetCheckpoint(thread, { reason, status: options.statusBefore || null }, env);
  const interrupted = typeof options.interruptThread === "function"
    ? await options.interruptThread(thread, env).catch(() => ({ interrupted: false }))
    : { interrupted: false };
  const prepared = await updateThread(thread.id, codexSafeResetPatch(thread, checkpoint, reason), env);
  try {
    const started = await options.startThread(prepared, env);
    if (!started?.thread) throw new Error("codex_app_server_safe_reset_start_failed");
    await appendEvent({
      type: "thread_runtime_safe_reset",
      threadId: thread.id,
      reason,
      oldCodexThreadId: oldCodexThreadId || null,
      oldCodexSessionId: oldCodexSessionId || null,
      newCodexThreadId: codexThreadId(started.thread) || null,
      newCodexSessionId: codexSessionId(started.thread) || null,
      interrupted: Boolean(interrupted?.interrupted),
      manualCheckpointPath: checkpoint.path || null,
    }, env).catch(() => {});
    return {
      ok: true,
      reset: true,
      safeReset: true,
      slept: 0,
      interrupted,
      manualCheckpoint: checkpoint,
      oldCodexThreadId: oldCodexThreadId || null,
      oldCodexSessionId: oldCodexSessionId || null,
      newCodexThreadId: codexThreadId(started.thread) || null,
      newCodexSessionId: codexSessionId(started.thread) || null,
      thread: started.thread,
      lease: null,
      status: started.status || null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateThread(thread.id, {
      state: "failed",
      lastError: message,
      runtime: {
        ...(prepared.runtime || {}),
        state: "failed",
        codexStatus: { type: "systemError", error: message },
      },
    }, env).catch(() => {});
    throw error;
  }
}

export const performCodexAppServerSafeReset = performNativeCodexSafeReset;
