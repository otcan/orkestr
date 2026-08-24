import { appendEvent } from "../../storage/src/store.js";
import { getThread, listThreads, updateThread } from "./threads.js";
import { sleepThread } from "./runtime-leases.js";
import {
  codexAppServerStatus,
  startCodexAppServerThread,
  isCodexRuntimeThread,
  threadUsesCodexAppServer,
} from "./codex-app-server.js";
import { codexSessionId, codexThreadId, nowIso } from "./codex-app-server-common.js";
import { generationScopedRuntimePatch, staleGenerationRuntimeState } from "./codex-generation.js";

function migrationPatch(thread, codexId) {
  const sessionId = codexSessionId(thread) || codexId;
  return {
    state: "unloaded",
    runtimeKind: "codex-app-server",
    codexThreadId: codexId,
    codexSessionId: sessionId,
    activeRuntimeLeaseId: null,
    executor: {
      ...(thread.executor || {}),
      id: "codex",
      type: "codex",
      transport: "app-server",
      codexThreadId: codexId,
      codexSessionId: sessionId,
      metadata: {
        ...(thread.executor?.metadata || {}),
        transport: "app-server",
        runtimeKind: "codex-app-server",
        codexThreadId: codexId,
        codexSessionId: sessionId,
        migratedToAppServerAt: nowIso(),
      },
    },
    runtime: {
      ...(thread.runtime || {}),
      state: "unloaded",
      runtimeKind: "codex-app-server",
      codexThreadId: codexId,
      codexSessionId: sessionId,
      activeTurnId: null,
      migratedToAppServerAt: nowIso(),
      previousRuntimeKind: thread.runtimeKind || thread.runtime?.runtimeKind || "",
      previousSessionName: thread.runtime?.sessionName || thread.executor?.sessionName || "",
      previousPaneId: thread.runtime?.paneId || thread.executor?.tmuxTarget || "",
    },
  };
}

function resultFor(thread, action, extra = {}) {
  return {
    threadId: thread.id,
    name: thread.name || thread.id,
    codexThreadId: codexThreadId(thread) || null,
    action,
    ...extra,
  };
}

/**
 * Backfill generation markers without importing or starting a Codex thread.
 * This is intentionally safe to run repeatedly during an upgrade or doctor
 * repair. Conflicting durable identities are reported, never guessed.
 */
export async function migrateCodexRuntimeGenerationState(options = {}, env = process.env) {
  const dryRun = options.dryRun === true;
  const results = [];
  for (const thread of await listThreads(env)) {
    const state = staleGenerationRuntimeState(thread);
    if (state.resolution.ambiguous) {
      results.push({ threadId: thread.id, migrated: false, reason: state.resolution.reason });
      continue;
    }
    const generation = state.resolution.id;
    const runtime = thread.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
    const needsMigration = Boolean(
      generation && (
        runtime.runtimeGeneration !== generation ||
        runtime.codexThreadId !== generation ||
        (runtime.operatorRolloutPath && !runtime.operatorRolloutGeneration) ||
        state.staleRollout ||
        state.staleFinalDelivery
      )
    );
    if (!needsMigration) continue;
    if (dryRun) {
      results.push({ threadId: thread.id, migrated: false, generation, reason: "generation_state_backfill" });
      continue;
    }
    const patch = generationScopedRuntimePatch(thread, generation, { codexSessionId: codexSessionId(thread) || generation });
    const nextRuntime = {
      ...patch.runtime,
      ...(runtime.operatorRolloutPath && !state.staleRollout ? { operatorRolloutGeneration: generation } : {}),
      ...(state.staleRollout ? {
        operatorRolloutPath: null,
        operatorRolloutOffset: 0,
        operatorRolloutGeneration: null,
        operatorRolloutSyncedAt: null,
      } : {}),
      ...(state.staleFinalDelivery ? { finalDelivery: null } : {}),
    };
    await updateThread(thread.id, { ...patch, runtime: nextRuntime }, env);
    await appendEvent({
      type: "codex_runtime_generation_migrated",
      threadId: thread.id,
      runtimeGeneration: generation,
      rolloutInvalidated: state.staleRollout,
      finalDeliveryInvalidated: state.staleFinalDelivery,
    }, env).catch(() => {});
    results.push({ threadId: thread.id, migrated: true, generation });
  }
  return {
    ok: true,
    dryRun,
    migrated: results.filter((item) => item.migrated).length,
    blocked: results.filter((item) => item.reason === "durable_codex_generation_ambiguous").length,
    results,
  };
}

export async function migrateCodexThreadsToAppServer(options = {}, env = process.env) {
  const dryRun = options.dryRun === true;
  const threads = await listThreads(env);
  const candidates = threads.filter(isCodexRuntimeThread);
  const status = await codexAppServerStatus({ env });
  if (!dryRun && !status.ok) {
    const error = new Error(status.error || "codex_app_server_unavailable");
    error.statusCode = 409;
    error.status = 409;
    throw error;
  }

  const results = [];
  for (const original of candidates) {
    const thread = await getThread(original.id, env).catch(() => null) || original;
    if (threadUsesCodexAppServer(thread, env)) {
      results.push(resultFor(thread, "already_app_server"));
      continue;
    }

    const existingCodexId = codexThreadId(thread);
    if (dryRun) {
      results.push(resultFor(thread, existingCodexId ? "mark_existing_codex_thread" : "create_codex_app_server_thread", {
        hasActiveRuntime: Boolean(thread.activeRuntimeLeaseId || thread.runtime?.sessionName),
      }));
      continue;
    }

    if (thread.activeRuntimeLeaseId || thread.runtime?.sessionName) {
      await sleepThread(thread.id, { reason: "codex_app_server_migration", kill: true }, env).catch(() => null);
    }

    if (existingCodexId) {
      const current = await getThread(thread.id, env).catch(() => null) || thread;
      const updated = await updateThread(current.id, migrationPatch(current, existingCodexId), env);
      await appendEvent({
        type: "codex_app_server_thread_migrated",
        threadId: updated.id,
        codexThreadId: existingCodexId,
        method: "metadata_rewrite",
      }, env).catch(() => null);
      results.push(resultFor(updated, "migrated_existing_codex_thread", { migrated: true }));
      continue;
    }

    const prepared = await updateThread(thread.id, {
      executor: {
        ...(thread.executor || {}),
        id: "codex",
        type: "codex",
        transport: "app-server",
        metadata: {
          ...(thread.executor?.metadata || {}),
          transport: "app-server",
          runtimeKind: "codex-app-server",
          migratedToAppServerAt: nowIso(),
        },
      },
      runtimeKind: "codex-app-server",
      runtime: {
        ...(thread.runtime || {}),
        runtimeKind: "codex-app-server",
        migratedToAppServerAt: nowIso(),
      },
    }, env);
    const started = await startCodexAppServerThread(prepared, env);
    const updated = started?.thread || prepared;
    results.push(resultFor(updated, "created_codex_app_server_thread", { migrated: true }));
  }

  const counts = results.reduce((memo, item) => {
    memo[item.action] = (memo[item.action] || 0) + 1;
    return memo;
  }, {});
  return {
    ok: true,
    dryRun,
    status,
    checked: threads.length,
    candidates: candidates.length,
    migrated: results.filter((item) => item.migrated).length,
    counts,
    results,
    generatedAt: nowIso(),
  };
}
