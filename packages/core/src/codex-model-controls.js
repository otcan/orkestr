import { appendEvent } from "../../storage/src/store.js";
import { randomUUID } from "node:crypto";
import { withCodexSettingsLock } from "./codex-settings-lock.js";
import { withCanonicalPublicReferenceLock } from "./canonical-public-reference-lock.js";
import { getThread, updateThread } from "./threads.js";
import { codexModelCatalog, resolveCodexThreadSettingsCommand } from "./codex-thread-settings.js";
import { codexRuntimeEnvForThread, codexThreadId, runtimeHome, threadUsesCodexAppServer, threadUsesRestrictedCodexPolicy } from "./codex-app-server-common.js";
import { getCodexAppServerClient } from "./codex-app-server-client.js";
import { assertResourceAccess, policyError } from "./policy.js";
import { incrementCounter, observeHistogram } from "./observability.js";
import { classifyCodexSettingsError, updateLoadedCodexSettings } from "./codex-settings-error.js";
import { runSettingsOperation } from "./codex-settings-operations.js";

const catalogs = new WeakMap();
export const MODEL_CONTROLS_TIMEOUT_MS = 5000;
export const MODEL_CATALOG_CACHE_MS = 15000;
const uncertainMessage = "The previous model change is unconfirmed. Settings are read-only until an operator reconciles the runtime. Reloading alone cannot confirm the change.";

export function modelControlsReadOnlyReason(thread, env = process.env) {
  if (threadUsesRestrictedCodexPolicy(thread, env)) return "Codex settings for this contained thread are managed by tenant policy.";
  if (!threadUsesCodexAppServer(thread, env) || !codexThreadId(thread)) return "Model settings are read-only for this runtime. Use an active Codex API thread to change them.";
  return "";
}

async function audit(thread, operation, outcome, started, env, failure = null) {
  const durationMs = Math.max(0, Date.now() - started);
  const labels = { operation, outcome };
  incrementCounter("orkestr_model_controls_total", labels);
  observeHistogram("orkestr_model_controls_duration_seconds", durationMs / 1000, labels, [0.01, 0.1, 0.5, 1, 2, 5, 10]);
  await appendEvent({ type: "codex_model_controls", threadId: thread?.id || null, operation, outcome, durationMs,
    ...(failure ? { failureKind: failure.kind, rpcCode: failure.code } : {}),
  }, env).catch(() => {});
}

export async function withModelDeadline(operation, timeoutMs = MODEL_CONTROLS_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(policyError("Model catalog request timed out. Try again.", 504)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export async function liveCodexModelCatalog(client, { fresh = false, timeoutMs = MODEL_CONTROLS_TIMEOUT_MS } = {}) {
  const cached = catalogs.get(client);
  if (!fresh && cached?.expiresAt > Date.now()) return cached.models;
  // The deadline covers all pages, not one deadline per page.
  const deadline = Date.now() + timeoutMs;
  const models = await withModelDeadline(async () => {
    const data = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw policyError("Model catalog request timed out. Try again.", 504);
      const result = await client.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) }, { timeoutMs: remaining });
      data.push(...codexModelCatalog(result));
      cursor = String(result?.nextCursor || "").trim();
      if (!cursor) return data;
    }
    throw policyError("Model catalog is incomplete. Try again.", 503);
  }, timeoutMs);
  if (!models.length) throw policyError("Model catalog is unavailable. Try again.", 503);
  catalogs.set(client, { models, expiresAt: Date.now() + MODEL_CATALOG_CACHE_MS });
  return models;
}

async function clientFor(thread, env, timeoutMs = MODEL_CONTROLS_TIMEOUT_MS) {
  const runtimeEnv = codexRuntimeEnvForThread(thread, env);
  return withModelDeadline(() => getCodexAppServerClient({ env: runtimeEnv, home: runtimeHome(runtimeEnv) }), timeoutMs);
}

export async function readCodexModelControls(thread, principal, env = process.env, client = null) {
  const started = Date.now();
  let outcome = "failed";
  try {
    assertResourceAccess(principal, thread, "thread.model-settings", env);
    let readOnlyReason = modelControlsReadOnlyReason(thread, env);
    let models = [];
    if (!readOnlyReason) {
      const deadline = Date.now() + MODEL_CONTROLS_TIMEOUT_MS;
      client ||= await clientFor(thread, env);
      models = await liveCodexModelCatalog(client, { timeoutMs: Math.max(1, deadline - Date.now()) });
      // A timeout does not cancel a provider mutation. Notifications have no
      // operation ID, so they cannot safely confirm an uncertain operation.
      thread = await getThread(thread.id, env) || thread;
      if (thread.codexSettingsUncertain) readOnlyReason = uncertainMessage;
    }
    outcome = readOnlyReason ? "read_only" : "completed";
    return { models, readOnly: Boolean(readOnlyReason), readOnlyReason, model: thread.codexModel || thread.executor?.metadata?.codexModel || null, effort: thread.codexReasoningEffort || thread.executor?.metadata?.codexReasoningEffort || null };
  } catch (error) { if (error.statusCode === 403) outcome = "denied"; throw error; }
  finally { await audit(thread, "catalog", outcome, started, env); }
}

// Both chat commands and WebUI changes use this validation, runtime update and persistence path.
export async function changeCodexModelControls(thread, { command = "model", text = "", principal = null, authorized = false, client = null, sourceOperationKey = "", surface = "webui" } = {}, env = process.env) {
  const expectedOwner = thread.ownerUserId;
  if (sourceOperationKey) {
    // Recheck authorization even for a cached result.
    thread = await getThread(thread.id, env);
    if (!thread || thread.ownerUserId !== expectedOwner) throw policyError("Thread ownership changed.", 403);
    if (principal) assertResourceAccess(principal, thread, "thread.model-settings", env);
    else if (!authorized) throw policyError("Only a thread owner or Orkestr admin can change Codex settings.", 403);
    return runSettingsOperation({ key: sourceOperationKey, surface, command }, async () => {
      try {
        const result = await changeCodexModelControls(thread, { command, text, principal, authorized, client }, env);
        return result.ok ? result : { ok: false, outcome: "invalid", replyText: "Invalid settings command or unsupported choice. Use /model, /effort, or /fast status to see supported settings." };
      } catch (error) {
        return { ok: false, outcome: [409, 502].includes(error.statusCode) ? "unconfirmed" : "rejected",
          replyText: [409, 502].includes(error.statusCode)
            ? "Could not confirm the settings change. Settings remain read-only until an operator reconciles the runtime."
            : "Settings could not be read or changed. Check the WebUI settings before trying again." };
      }
    }, env);
  }
  const started = Date.now();
  let outcome = "failed";
  let failure = null;
  try {
    return await withCodexSettingsLock(thread.id, env, async () => {
      thread = await getThread(thread.id, env);
      if (!thread || thread.ownerUserId !== expectedOwner) throw policyError("Thread ownership changed.", 403);
      if (principal) assertResourceAccess(principal, thread, "thread.model-settings", env);
      else if (!authorized) throw policyError("Only a thread owner or Orkestr admin can change Codex settings.", 403);
      const reason = modelControlsReadOnlyReason(thread, env);
      if (reason) throw policyError(reason, 403);
      const deadline = Date.now() + MODEL_CONTROLS_TIMEOUT_MS;
      client ||= await clientFor(thread, env);
      const models = await liveCodexModelCatalog(client, { fresh: true, timeoutMs: Math.max(1, deadline - Date.now()) });
      if (principal && command === "model" && !["", "status", "default"].includes(String(text).trim().toLowerCase()) && !models.some((entry) => [entry.id, entry.model].filter(Boolean).some((value) => value.toLowerCase() === String(text).split(/\s+/)[0].toLowerCase()))) {
        outcome = "invalid";
        return { ok: false, error: "Select a model from the live catalog." };
      }
      const resolved = resolveCodexThreadSettingsCommand({ command, text, thread, models });
      if (!resolved.ok) { outcome = "invalid"; return resolved; }
      if (resolved.action === "status" && thread.codexSettingsUncertain) resolved.replyText += `\n${uncertainMessage}`;
      if (resolved.action === "update") {
        if (thread.codexSettingsUncertain) throw policyError(uncertainMessage, 409);
        // Only the correlated RPC acknowledgement confirms this operation.
        const pending = { id: randomUUID(), codexThreadId: codexThreadId(thread), expected: resolved.runtimePatch, patch: resolved.patch, startedAt: new Date().toISOString() };
        await withCanonicalPublicReferenceLock(async () => {
          const current = await getThread(thread.id, env);
          if (!current || codexThreadId(current) !== pending.codexThreadId || current.ownerUserId !== thread.ownerUserId || modelControlsReadOnlyReason(current, env)) {
            throw policyError("The thread changed while validating settings. Reload before trying again.", 409);
          }
          await updateThread(thread.id, { codexSettingsPending: pending, codexSettingsUncertain: true, codexSettingsManaged: true }, env);
        }, env);
        try {
          await updateLoadedCodexSettings(client, { threadId: pending.codexThreadId, ...resolved.runtimePatch }, {
            timeoutMs: MODEL_CONTROLS_TIMEOUT_MS,
            validate: async () => {
              const current = await getThread(thread.id, env);
              if (!current || current.ownerUserId !== thread.ownerUserId || codexThreadId(current) !== pending.codexThreadId || current.codexSettingsPending?.id !== pending.id || modelControlsReadOnlyReason(current, env)) {
                throw policyError("The thread changed while applying settings. Reload before trying again.", 409);
              }
            },
          });
        } catch (error) {
          failure = classifyCodexSettingsError(error);
          outcome = failure.definitive ? "rejected" : "uncertain";
          await withCanonicalPublicReferenceLock(async () => {
            const current = await getThread(thread.id, env);
            // Never clear a replacement generation/operation or another owner's
            // guard, even when the old runtime definitively rejected its RPC.
            if (!current || current.ownerUserId !== thread.ownerUserId || codexThreadId(current) !== pending.codexThreadId || current.codexSettingsPending?.id !== pending.id) {
              throw policyError("The thread changed while applying settings. Reload before trying again.", 409);
            }
            await updateThread(thread.id, failure.definitive
              ? { codexSettingsPending: null, codexSettingsUncertain: null }
              : { codexSettingsPending: { ...pending, failureKind: failure.kind, rpcCode: failure.code } }, env);
          }, env);
          if (failure.definitive) throw policyError(failure.message, 422);
          throw policyError("Could not confirm the model change. Settings are read-only until an operator reconciles the runtime.", 502);
        }
        thread = await withCanonicalPublicReferenceLock(async () => {
          const current = await getThread(thread.id, env);
          if (!current || current.ownerUserId !== thread.ownerUserId || modelControlsReadOnlyReason(current, env) || current.codexSettingsPending?.id !== pending.id || codexThreadId(current) !== pending.codexThreadId) {
            throw policyError("The runtime changed while applying settings. The change is unconfirmed; reload the thread before continuing.", 409);
          }
          const patch = { ...resolved.patch, codexModelUpdatedAt: new Date().toISOString() };
          return updateThread(thread.id, { ...patch, codexSettingsPending: null, codexSettingsUncertain: null, executor: { ...(current.executor || {}), metadata: { ...(current.executor?.metadata || {}), ...patch } } }, env);
        }, env);
      }
      outcome = "completed";
      return { ...resolved, thread };
    });
  } catch (error) { if (error.statusCode === 403) outcome = "denied"; throw error; }
  finally { await audit(thread, "settings", outcome, started, env, failure); }
}
