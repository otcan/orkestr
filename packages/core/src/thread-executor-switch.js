import { appendEvent } from "../../storage/src/store.js";
import { claudeCodeEnabled } from "./claude-code-client.js";
import { assertClaudeCodeHostOwner } from "./claude-code-runtime-policy.js";
import { clearClaudeCodeSession } from "./claude-code-sessions.js";
import { nextClaudeSystemPolicyRevision } from "./claude-system-policy-revision.js";
import { normalizeCodexModel, normalizeReasoningEffort } from "./codex-app-server-common.js";
import { writeExecutorHandoff } from "./executor-handoff.js";
import { listLlmAccountProfiles, resolveLlmAccountProfile } from "./llm-account-profiles.js";
import { isAdminPrincipal } from "./policy.js";
import { threadUsesRawTerminalMode } from "./raw-terminal-mode.js";
import {
  EXECUTOR_CLAUDE,
  EXECUTOR_CODEX,
  activeThreadExecutor,
  claudeTargetPatch,
  clean,
  codexTargetPatch,
  currentExecutorSettings,
  leavingThreadFields,
  normalizeExecutorTarget,
  snapshotExecutorState,
  threadExecutorSummary,
} from "./thread-executor-state.js";
import { getThread, updateThread } from "./threads.js";

export { normalizeExecutorTarget, threadExecutorSummary } from "./thread-executor-state.js";

const claudeEfforts = ["low", "medium", "high", "max"];
const switchChains = new Map();

function switchError(code, statusCode = 400, extra = {}) {
  return Object.assign(new Error(code), { code, statusCode, ...extra });
}

function nowIso() {
  return new Date().toISOString();
}

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function selfSwitchIntervalMs(env = process.env) {
  return positiveMs(env.ORKESTR_EXECUTOR_SELF_SWITCH_INTERVAL_MS, 10 * 60 * 1000);
}

// Serialize switch application per thread so a completion hook and an
// explicit request can never apply the same pending switch twice.
function withSwitchLock(threadId, fn) {
  const previous = switchChains.get(threadId) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const settled = run.catch(() => {});
  switchChains.set(threadId, settled);
  settled.then(() => { if (switchChains.get(threadId) === settled) switchChains.delete(threadId); });
  return run;
}

async function defaultRuntime() {
  const [codex, claude, leases] = await Promise.all([
    import("./codex-app-server.js"),
    import("./runtime-claude-code-adapter.js"),
    import("./runtime-leases.js"),
  ]);
  return {
    startCodex: codex.startCodexAppServerThread,
    resumeCodex: codex.resumeCodexAppServerThread,
    interruptCodex: codex.interruptCodexAppServerThread,
    startClaude: claude.startClaudeCodeThread,
    interruptClaude: claude.interruptClaudeCodeThread,
    claudeTurnActive: (threadId) => claude.hasActiveClaudeCodeSupervisor(threadId),
    requestDelivery: (threadId, env) => leases.requestThreadInputDelivery(threadId, env, 0),
  };
}

let runtimeOverride = null;

// Test-only: replace the executor start/interrupt functions used by switches
// triggered from turn-completion hooks.
export function setExecutorSwitchRuntimeForTest(runtime = null) {
  runtimeOverride = runtime;
  return () => { if (runtimeOverride === runtime) runtimeOverride = null; };
}

async function runtimeFor(options = {}) {
  return options.runtime || runtimeOverride || await defaultRuntime();
}

function persistedTurnActive(thread = {}) {
  const states = [thread.state, thread.runtime?.state].map((value) => clean(value).toLowerCase());
  return states.includes("working") || Boolean(clean(thread.runtime?.activeTurnId));
}

function turnActive(thread, runtime) {
  return persistedTurnActive(thread) || Boolean(runtime.claudeTurnActive?.(thread.id));
}

function validateClaudeSettings({ model, effort }, env) {
  const configured = clean(env.ORKESTR_CLAUDE_CODE_MODELS).split(",").map(clean).filter(Boolean);
  if (model && (!/^[a-zA-Z0-9._:-]{1,120}$/.test(model) || (configured.length && !configured.includes(model)))) {
    throw switchError("claude_model_unsupported", 400, { allowedModels: configured });
  }
  if (effort && !claudeEfforts.includes(effort)) throw switchError("claude_effort_unsupported", 400);
}

function validateCodexSettings({ model, effort }) {
  if (model && !normalizeCodexModel(model)) throw switchError("codex_model_invalid", 400);
  if (effort && !normalizeReasoningEffort(effort)) throw switchError("codex_effort_invalid", 400);
}

async function defaultClaudeProfileId(thread, env) {
  const ready = (await listLlmAccountProfiles(thread.ownerUserId, { provider: "claude-code" }, env).catch(() => []))
    .filter((profile) => profile.state === "ready")
    .sort((a, b) => String(b.lastVerifiedAt || b.updatedAt || "").localeCompare(String(a.lastVerifiedAt || a.updatedAt || "")));
  return clean(ready[0]?.id);
}

async function resolveClaudeTarget(thread, options, env) {
  if (options.principal && !isAdminPrincipal(options.principal)) throw switchError("claude_code_admin_runtime_required", 403);
  assertClaudeCodeHostOwner(thread, env);
  if (!claudeCodeEnabled(env)) throw switchError("claude_code_disabled", 409);
  const previous = thread.executorStates?.[EXECUTOR_CLAUDE] || {};
  const profileId = clean(options.profileId) || clean(previous.accountProfileId) || await defaultClaudeProfileId(thread, env);
  const profile = await resolveLlmAccountProfile({ ownerUserId: thread.ownerUserId, profileId, provider: "claude-code", requireReady: true }, env);
  return profile.id;
}

function assertSwitchableSource(thread) {
  const from = activeThreadExecutor(thread);
  if (from === "api-agent") throw switchError("executor_switch_unsupported_runtime", 409);
  if (threadUsesRawTerminalMode(thread)) throw switchError("executor_switch_raw_terminal_unsupported", 409, { hint: "Use /switch api before switching executors." });
  return from;
}

function requestFields(target, options = {}) {
  return {
    target,
    model: clean(options.model),
    effort: clean(options.effort).toLowerCase(),
    profileId: clean(options.profileId),
    reason: clean(options.reason).slice(0, 500),
    actor: clean(options.actor) || "owner",
  };
}

async function validateRequest(thread, request, options, env) {
  if (request.target === EXECUTOR_CLAUDE) {
    validateClaudeSettings(request, env);
    request.profileId = await resolveClaudeTarget(thread, { ...options, profileId: request.profileId }, env);
  } else {
    validateCodexSettings(request);
  }
  return request;
}

async function applySameExecutorSettings(thread, request, env) {
  if (!request.model && !request.effort) return thread;
  const metadata = { ...(thread.executor?.metadata || {}) };
  const patch = {};
  if (request.target === EXECUTOR_CLAUDE) {
    if (request.model) patch.claudeModel = metadata.claudeModel = request.model;
    if (request.effort) patch.claudeEffort = metadata.claudeEffort = request.effort;
    patch.claudeModelUpdatedAt = nowIso();
  } else {
    if (request.model) patch.codexModel = metadata.codexModel = normalizeCodexModel(request.model);
    if (request.effort) patch.codexReasoningEffort = metadata.codexReasoningEffort = normalizeReasoningEffort(request.effort);
  }
  return updateThread(thread.id, { ...patch, executor: { ...(thread.executor || {}), metadata } }, env);
}

function rollbackPatch(before, patch, unset) {
  const restore = {};
  const removeAgain = [];
  for (const key of new Set([...Object.keys(patch), ...unset])) {
    if (Object.prototype.hasOwnProperty.call(before, key)) restore[key] = before[key];
    else removeAgain.push(key);
  }
  return { restore, removeAgain };
}

async function startTarget(thread, to, runtime, env) {
  if (to === EXECUTOR_CLAUDE) return runtime.startClaude(thread, env);
  if (clean(thread.codexThreadId)) {
    try {
      return await runtime.resumeCodex(thread, env);
    } catch (error) {
      await appendEvent({ type: "thread_executor_switch_codex_resume_failed", threadId: thread.id, error: clean(error?.code || error?.message) }, env).catch(() => {});
      const fresh = await updateThread(thread.id, codexTargetPatch(thread, {
        model: thread.codexModel, effort: thread.codexReasoningEffort, restore: {},
      }), env, { replaceObjects: true, unset: ["codexThreadId", "codexSessionId"] });
      return runtime.startCodex(fresh, env);
    }
  }
  return runtime.startCodex(thread, env);
}

async function performSwitch(thread, request, runtime, env) {
  const from = assertSwitchableSource(thread);
  const to = request.target;
  const now = nowIso();
  const previousTarget = thread.executorStates?.[to] || {};
  const handoff = await writeExecutorHandoff(thread, {
    from,
    to,
    reason: request.reason,
    since: to === EXECUTOR_CODEX && previousTarget.codexThreadId ? previousTarget.lastActiveAt : "",
  }, env);
  const settings = {
    model: request.model || (to === EXECUTOR_CLAUDE ? previousTarget.claudeModel : previousTarget.codexModel),
    effort: request.effort || (to === EXECUTOR_CLAUDE ? previousTarget.claudeEffort : previousTarget.codexReasoningEffort),
  };
  const targetPatch = to === EXECUTOR_CLAUDE
    ? claudeTargetPatch(thread, { profileId: request.profileId, ...settings, restore: previousTarget })
    : codexTargetPatch(thread, { ...settings, restore: previousTarget });
  const lastExecutorSwitch = { from, to, actor: request.actor, reason: request.reason || null, when: request.when, at: now };
  const patch = {
    ...targetPatch,
    executorStates: { ...(thread.executorStates || {}), [from]: snapshotExecutorState(thread, from, now) },
    claudeSystemPolicyRevision: nextClaudeSystemPolicyRevision(),
    pendingExecutorHandoff: { path: handoff.path, from, to, createdAt: now, messageCount: handoff.messageCount },
    lastExecutorSwitch,
  };
  const unset = [...leavingThreadFields(from), "pendingExecutorSwitch"].filter((key) => !Object.prototype.hasOwnProperty.call(patch, key));
  const prepared = await updateThread(thread.id, patch, env, { replaceObjects: true, unset });
  let started;
  try {
    started = await startTarget(prepared, to, runtime, env);
  } catch (error) {
    const { restore, removeAgain } = rollbackPatch(thread, patch, unset);
    await updateThread(thread.id, restore, env, { replaceObjects: true, unset: removeAgain }).catch(() => {});
    const failureCode = clean(error?.code || error?.message) || "executor_start_failed";
    await appendEvent({ type: "thread_executor_switch_failed", threadId: thread.id, from, to, actor: request.actor, reason: request.reason || null, when: request.when, error: failureCode, rolledBack: true }, env).catch(() => {});
    throw switchError("executor_switch_start_failed", Number(error?.statusCode) >= 400 ? Number(error.statusCode) : 502, { cause: failureCode, rolledBack: true });
  }
  if (from === EXECUTOR_CLAUDE) await clearClaudeCodeSession(thread, env).catch(() => false);
  await appendEvent({ type: "thread_executor_switched", threadId: thread.id, from, to, actor: request.actor, reason: request.reason || null, when: request.when, handoffPath: handoff.path }, env).catch(() => {});
  const updated = await getThread(thread.id, env) || started?.thread || prepared;
  await Promise.resolve(runtime.requestDelivery?.(thread.id, env)).catch(() => {});
  return { ok: true, changed: true, deferred: false, from, to, handoffPath: handoff.path, thread: updated, executor: threadExecutorSummary(updated) };
}

async function waitForPendingApplied(threadId, env) {
  const deadline = Date.now() + positiveMs(env.ORKESTR_EXECUTOR_SWITCH_INTERRUPT_WAIT_MS, 10_000);
  for (;;) {
    const current = await getThread(threadId, env);
    if (!current?.pendingExecutorSwitch || Date.now() >= deadline) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function switchThreadExecutor(threadId, target, options = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw switchError("thread_not_found", 404);
  const to = normalizeExecutorTarget(target);
  if (!to) throw switchError("executor_target_invalid", 400);
  const runtime = await runtimeFor(options);
  const self = clean(options.actor) === "self";
  let when = clean(options.when).toLowerCase().replace("-", "_") || "after_turn";
  if (!["now", "after_turn"].includes(when)) throw switchError("executor_switch_when_invalid", 400);
  if (self) when = "after_turn";
  const request = await validateRequest(thread, { ...requestFields(to, options), when }, options, env);
  const from = assertSwitchableSource(thread);
  if (self) {
    if (!request.reason) throw switchError("executor_self_switch_reason_required", 400);
    const last = Date.parse(clean(thread.executorSelfSwitchRequestedAt));
    const interval = selfSwitchIntervalMs(env);
    if (Number.isFinite(last) && Date.now() - last < interval) {
      throw switchError("executor_self_switch_rate_limited", 429, { retryAfterMs: interval - (Date.now() - last) });
    }
  }
  if (from === to) {
    const updated = await applySameExecutorSettings(thread, request, env);
    return { ok: true, changed: false, deferred: false, from, to, thread: updated, executor: threadExecutorSummary(updated) };
  }
  const selfPatch = self ? { executorSelfSwitchRequestedAt: nowIso() } : {};
  if (turnActive(thread, runtime)) {
    const pendingExecutorSwitch = { ...request, requestedAt: nowIso() };
    const deferred = await updateThread(thread.id, { pendingExecutorSwitch, ...selfPatch }, env);
    await appendEvent({ type: "thread_executor_switch_deferred", threadId: thread.id, from, to, actor: request.actor, reason: request.reason || null, when }, env).catch(() => {});
    if (when === "after_turn") {
      return { ok: true, changed: false, deferred: true, from, to, thread: deferred, executor: threadExecutorSummary(deferred) };
    }
    const interrupt = from === EXECUTOR_CLAUDE ? runtime.interruptClaude : runtime.interruptCodex;
    const interrupted = await Promise.resolve(interrupt?.(deferred, env)).catch(() => ({ interrupted: false }));
    const settled = interrupted?.interrupted ? await waitForPendingApplied(thread.id, env) : deferred;
    if (!settled?.pendingExecutorSwitch) {
      const applied = activeThreadExecutor(settled || {}) === to;
      if (!applied) throw switchError("executor_switch_failed", 409);
      return { ok: true, changed: true, deferred: false, from, to, thread: settled, executor: threadExecutorSummary(settled) };
    }
    if (turnActive(settled, runtime)) {
      return { ok: true, changed: false, deferred: true, from, to, thread: settled, executor: threadExecutorSummary(settled) };
    }
    return applyPendingExecutorSwitch(thread.id, { runtime }, env);
  }
  if (Object.keys(selfPatch).length) await updateThread(thread.id, selfPatch, env);
  return withSwitchLock(thread.id, async () => {
    const current = await getThread(thread.id, env);
    return performSwitch(current, request, runtime, env);
  });
}

// Called from both executors' turn-completion paths. Never throws: a failed
// deferred switch is audited and the thread stays on its current executor.
export async function applyPendingExecutorSwitch(threadId, options = {}, env = process.env) {
  const runtime = await runtimeFor(options);
  return withSwitchLock(threadId, async () => {
    const thread = await getThread(threadId, env);
    const pending = thread?.pendingExecutorSwitch;
    if (!pending || typeof pending !== "object") return null;
    if (runtime.claudeTurnActive?.(thread.id)) return null;
    const cleared = await updateThread(thread.id, {}, env, { unset: ["pendingExecutorSwitch"] });
    try {
      const request = await validateRequest(cleared, {
        ...requestFields(pending.target, pending),
        when: clean(pending.when) || "after_turn",
      }, {}, env);
      if (activeThreadExecutor(cleared) === request.target) {
        const updated = await applySameExecutorSettings(cleared, request, env);
        return { ok: true, changed: false, deferred: false, thread: updated, executor: threadExecutorSummary(updated) };
      }
      return await performSwitch(cleared, request, runtime, env);
    } catch (error) {
      await appendEvent({ type: "thread_executor_switch_failed", threadId: thread.id, to: pending.target || null, actor: pending.actor || null, when: pending.when || "after_turn", error: clean(error?.cause || error?.code || error?.message) }, env).catch(() => {});
      return { ok: false, error: clean(error?.code || error?.message), thread: await getThread(thread.id, env) };
    }
  });
}

export function executorSwitchReplyText(result = {}) {
  const summary = result.executor || {};
  const label = summary.executor === EXECUTOR_CLAUDE ? "Claude Code" : summary.executor === EXECUTOR_CODEX ? "Codex" : summary.executor || "unknown";
  const targetLabel = result.to === EXECUTOR_CLAUDE ? "Claude Code" : "Codex";
  if (result.deferred) return `Executor switch to ${targetLabel} queued; it applies when the current turn finishes.`;
  const model = summary.model ? ` (model ${summary.model}${summary.effort ? `, effort ${summary.effort}` : ""})` : "";
  if (!result.changed) return `Active executor: ${label}${model}.`;
  return `Executor switched to ${label}${model}. Same thread, same history; the next turn gets a one-time handoff.`;
}

export { currentExecutorSettings };
