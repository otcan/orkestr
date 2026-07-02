import { randomUUID } from "node:crypto";
import { appendEvent } from "../../storage/src/store.js";
import {
  appendThreadMessage,
  getThread,
  listThreadMessages,
  updateThread,
  updateThreadMessage,
} from "./threads.js";
import {
  appendOrUpdateEventMessage,
  appServerStateFromStatus,
  clean,
  codexAppServerEnabled,
  codexRuntimeEnvForThread,
  codexSessionId,
  codexThreadId,
  containedCodexRuntimeIsCurrent,
  containedCodexRuntimeMetadata,
  ensureContainedCodexRuntimeHome,
  effortForThread,
  itemPhase,
  itemText,
  modelForThread,
  nowIso,
  publicError,
  runtimeHome,
  threadEventId,
  threadForCodexThreadId,
  threadStartParams,
  threadUsesRestrictedCodexPolicy,
  turnStartParams,
  userInputText,
} from "./codex-app-server-common.js";
import { getCodexAppServerClient, stopCodexAppServerClients as stopCodexAppServerRuntimeClients } from "./codex-app-server-client.js";
import { readLiveCodexThreadState } from "./codex-app-server-live-state.js";
import { codexAppServerSocket, codexAppServerTransport } from "../../connectors/src/codex-app-server-transport.js";
import {
  codexAppServerMessageFields,
  latestWhatsAppParent,
  threadWhatsAppBindingParent,
  whatsappProjectionFields,
} from "./codex-app-server-whatsapp.js";
import { ensureRuntimeAgentsFile } from "./agent-context.js";
import { containedUserDeveloperInstructions } from "./tenant-policy.js";
import { relocateLegacyUserWorkspace } from "./workspace-files.js";
import { parseThreadInputCommand } from "./thread-commands.js";
import { performCodexAppServerSafeReset } from "./codex-safe-reset.js";
import { completeThreadSecurityApproveCommand } from "./security-thread-command.js";
import { appendTurnLifecycleEvent, turnLifecycleFromRuntimeStatus } from "./turn-lifecycle.js";
import { markConnectorDeliverySignal } from "./connector-delivery-signals.js";

const appServerDeliveryTimers = new Map();
const appServerHistorySyncTimes = new Map();
const appServerDeliveryLocks = new Set();
const pendingInputStates = new Set(["queued", "pending_delivery", "awaiting_ack"]);

function withInternalClient(result, client) {
  Object.defineProperty(result, "client", {
    value: client,
    enumerable: false,
    configurable: true,
  });
  return result;
}

function codexAppServerActiveTurnRetryMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CODEX_APP_SERVER_ACTIVE_TURN_RETRY_MS || 15000);
  return Number.isFinite(parsed) ? Math.max(250, parsed) : 15000;
}

function codexAppServerActiveTurnVerifyMs(env = process.env) {
  const raw = String(env.ORKESTR_CODEX_APP_SERVER_ACTIVE_TURN_VERIFY_MS ?? "15000").trim().toLowerCase();
  if (["0", "off", "false", "disabled"].includes(raw)) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 15000;
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function markActiveTurnObserved(client, id, state = {}) {
  const activeTurnId = clean(state.activeTurnId);
  if (!client || !id || !activeTurnId || state.activeTurnObservedAt) return state;
  const next = { ...state, activeTurnObservedAt: nowIso() };
  client.threadStates.set(id, next);
  return next;
}

function activeTurnNeedsLiveVerification(state = {}, env = process.env) {
  const activeTurnId = clean(state.activeTurnId);
  if (!activeTurnId) return false;
  const verifyMs = codexAppServerActiveTurnVerifyMs(env);
  if (!verifyMs) return false;
  if (clean(state.status?.type).toLowerCase() !== "active") return false;
  const now = Date.now();
  const observedAt = timestampMs(state.activeTurnObservedAt);
  if (!observedAt || now - observedAt < verifyMs) return false;
  const checkedAt = timestampMs(state.liveStateCheckedAt);
  return !checkedAt || now - checkedAt >= verifyMs;
}

function turnHasCompletedFinalAnswer(messages = [], turnId = "") {
  const id = clean(turnId);
  if (!id) return false;
  return (Array.isArray(messages) ? messages : []).some((message) =>
    clean(message?.role).toLowerCase() === "assistant" &&
    clean(message?.state).toLowerCase() === "completed" &&
    clean(message?.phase).toLowerCase() === "final_answer" &&
    clean(message?.codexTurnId) === id
  );
}

async function activeTurnHasCompletedFinalAnswer(thread, turnId = "", env = process.env, counts = {}) {
  const id = clean(turnId);
  if (!id) return false;
  if (Array.isArray(counts.messages)) return turnHasCompletedFinalAnswer(counts.messages, id);
  const messages = await listThreadMessages(thread.id, env).catch(() => []);
  return turnHasCompletedFinalAnswer(messages, id);
}

function isoAfter(ms) {
  return new Date(Date.now() + Math.max(0, ms)).toISOString();
}

function codexAppServerInputClaimStaleMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CODEX_APP_SERVER_INPUT_CLAIM_STALE_MS || 30000);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 30000;
}

function recentDeliveryClaim(message = {}, env = process.env) {
  const state = clean(message.state).toLowerCase();
  const deliveryState = clean(message.deliveryState).toLowerCase();
  if (state !== "pending_delivery" && deliveryState !== "codex_app_server_sending") return false;
  const lastAttemptMs = timestampMs(message.deliveryLastAttemptAt || message.updatedAt || message.createdAt);
  return Boolean(lastAttemptMs && Date.now() - lastAttemptMs < codexAppServerInputClaimStaleMs(env));
}

function codexModeSetting(value) {
  const mode = clean(value).toLowerCase();
  return mode === "plan" || mode === "code" ? mode : "";
}

function codexStatusActiveFlags(status) {
  return Array.isArray(status?.activeFlags)
    ? status.activeFlags.map((flag) => clean(flag).toLowerCase()).filter(Boolean)
    : [];
}

function appServerStatusProgress({ thread, runtimeState, codexStatus, pendingRequest }) {
  const state = clean(runtimeState).toLowerCase();
  const flags = codexStatusActiveFlags(codexStatus);
  if (pendingRequest || state === "awaiting_approval") {
    return {
      stateHint: "awaiting_approval",
      summary: "Waiting for approval",
      tailLines: [],
      capturedAt: nowIso(),
    };
  }
  const mode = codexModeSetting(thread?.codexMode || thread?.executor?.metadata?.codexMode);
  const planningFlag = flags.some((flag) => /(?:^|[_-])plan(?:ning)?(?:$|[_-])|review/.test(flag));
  if ((state === "working" || state === "planning") && (mode === "plan" || planningFlag)) {
    return {
      stateHint: "planning",
      summary: "Planning",
      tailLines: [],
      capturedAt: nowIso(),
      codexMode: "plan",
    };
  }
  return null;
}

function codexAppServerModePatch(mode, reason = "app-server-local-mode") {
  const desired = codexModeSetting(mode);
  if (!desired) return {};
  return {
    codexMode: desired,
    codexModeSource: "orkestr-command",
    codexModeUpdatedAt: nowIso(),
    desiredCodexMode: null,
    desiredCodexModeUpdatedAt: null,
    codexModeLiveApplied: true,
    codexModeLiveChanged: true,
    codexModeApplyReason: reason,
  };
}

async function recordCodexAppServerModeCommand(thread, message, mode, env = process.env) {
  const desired = codexModeSetting(mode);
  if (!desired) return null;
  await updateThread(thread.id, codexAppServerModePatch(desired), env).catch(() => {});
  await appendEvent({
    type: "thread_codex_mode_command",
    threadId: thread.id,
    messageId: message.id,
    source: message.source || null,
    mode: desired,
    applied: true,
    reason: "app-server-local-mode",
    observedVia: "codex_app_server_mode_recorded",
  }, env).catch(() => {});
  return desired;
}

async function completeCodexAppServerModeCommand(thread, message, mode, env = process.env) {
  const desired = await recordCodexAppServerModeCommand(thread, message, mode, env);
  if (!desired) return null;
  const updated = await updateThreadMessage(thread.id, message.id, {
    state: "completed",
    deliveryState: "delivered",
    observedVia: "codex_app_server_mode_recorded",
    deliveredAt: nowIso(),
    error: null,
  }, env);
  return {
    messageId: updated.id,
    message: updated,
    mode: desired,
    applied: true,
    deferred: false,
    runtimeMode: { mode: desired, source: "orkestr-command", reason: "app-server-local-mode" },
  };
}

function codexAppServerHistorySyncIntervalMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CODEX_APP_SERVER_HISTORY_SYNC_INTERVAL_MS || 60000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 60000;
}

function workspaceForThread(thread = {}) {
  return clean(thread.cwd || thread.workspace || thread.repoPath || thread.worktreePath);
}

function containedRuntimeBase(runtime = {}) {
  const next = { ...(runtime || {}) };
  for (const key of [
    "operatorRolloutPath",
    "operatorRolloutOffset",
    "operatorRolloutSyncedAt",
    "operatorRolloutSyncError",
    "activeTurnId",
    "pendingRequest",
    "lastTurnId",
    "lastTurnStatus",
    "progress",
    "recoveredAt",
  ]) {
    delete next[key];
  }
  return next;
}

function runtimeBase(thread = {}, contained = false) {
  return contained ? containedRuntimeBase(thread.runtime) : { ...(thread.runtime || {}) };
}

function freshStartRuntime(thread = {}, { codexId = "", codexSessionId: sessionId = "", contained = false } = {}) {
  const runtime = runtimeBase(thread, contained);
  return {
    ...runtime,
    runtimeKind: "codex-app-server",
    state: "ready",
    codexThreadId: codexId,
    codexSessionId: sessionId,
    startedAt: nowIso(),
  };
}

function resumeRuntime(thread = {}, { codexId = "", codexSessionId: sessionId = "", contained = false } = {}) {
  const runtime = { ...(thread.runtime || {}) };
  const base = contained ? containedRuntimeBase(runtime) : runtime;
  return {
    ...base,
    runtimeKind: "codex-app-server",
    state: "ready",
    codexThreadId: codexId,
    codexSessionId: sessionId,
    activeTurnId: null,
    resumedAt: nowIso(),
  };
}

function scheduleCodexAppServerInputDelivery(threadId, env = process.env, delayMs = 0) {
  const id = clean(threadId);
  if (!id) return;
  const current = appServerDeliveryTimers.get(id);
  if (current) clearTimeout(current);
  const timer = setTimeout(async () => {
    appServerDeliveryTimers.delete(id);
    const thread = await getThread(id, env).catch(() => null);
    if (thread) await deliverCodexAppServerPendingInputs(thread, env).catch(() => null);
  }, Math.max(0, Number(delayMs) || 0));
  timer.unref?.();
  appServerDeliveryTimers.set(id, timer);
}

export {
  codexAppServerEnabled,
  codexRuntimeKind,
  isCodexRuntimeThread,
  threadNeedsCodexAppServerMigration,
  threadUsesCodexAppServer,
} from "./codex-app-server-common.js";
export {
  codexAppServerStatus,
  getCodexAppServerClient,
  setCodexAppServerMessageHandler,
} from "./codex-app-server-client.js";
export { recoverStaleCodexAppServerTurns } from "./codex-app-server-recovery.js";

export function stopCodexAppServerClients() {
  for (const timer of appServerDeliveryTimers.values()) clearTimeout(timer);
  appServerDeliveryTimers.clear();
  return stopCodexAppServerRuntimeClients();
}

export async function startCodexAppServerThread(thread, env = process.env) {
  if (!codexAppServerEnabled(env)) return null;
  if (threadUsesRestrictedCodexPolicy(thread, env)) {
    const relocation = await relocateLegacyUserWorkspace(thread, env).catch(() => null);
    if (relocation?.relocated && relocation.patch) {
      thread = await updateThread(thread.id, relocation.patch, env);
      await appendEvent({
        type: "contained_thread_workspace_relocated",
        threadId: thread.id,
        ownerUserId: thread.ownerUserId || null,
        previousWorkspace: relocation.previousWorkspace,
        workspace: relocation.workspace,
      }, env).catch(() => {});
    }
  }
  const workspace = workspaceForThread(thread);
  if (workspace) await ensureRuntimeAgentsFile(workspace, env, { thread }).catch(() => {});
  await ensureContainedCodexRuntimeHome(thread, env);
  const runtimeEnv = codexRuntimeEnvForThread(thread, env);
  const client = await getCodexAppServerClient({ env: runtimeEnv, home: runtimeHome(runtimeEnv) });
  const startParams = threadStartParams(thread, runtimeEnv);
  const containedMetadata = containedCodexRuntimeMetadata(thread, env) || {};
  const result = await client.request("thread/start", startParams);
  const codexThread = result?.thread || {};
  const codexId = clean(codexThread.id || codexThread.threadId);
  if (!codexId) throw new Error("codex_app_server_thread_missing_id");
  if (thread.name) {
    await client.request("thread/name/set", { threadId: codexId, name: thread.name }).catch(() => null);
  }
  const updated = await updateThread(thread.id, {
    state: "ready",
    runtimeKind: "codex-app-server",
    codexThreadId: codexId,
    codexSessionId: clean(codexThread.sessionId || codexId),
    executor: {
      ...(thread.executor || {}),
      id: "codex",
      type: "codex",
      transport: "app-server",
      codexThreadId: codexId,
      codexSessionId: clean(codexThread.sessionId || codexId),
      metadata: {
        ...(thread.executor?.metadata || {}),
        transport: "app-server",
        codexThreadId: codexId,
        codexSessionId: clean(codexThread.sessionId || codexId),
        codexModel: modelForThread(thread, runtimeEnv) || codexThread.model || null,
        codexReasoningEffort: effortForThread(thread, runtimeEnv) || null,
        codexModelProvider: codexThread.modelProvider || "openai",
        codexSandbox: startParams.sandbox,
        codexApprovalPolicy: startParams.approvalPolicy,
        containedUserRuntimePolicy: Boolean(startParams.developerInstructions),
        ...containedMetadata,
      },
    },
    runtime: freshStartRuntime(thread, {
      codexId,
      codexSessionId: clean(codexThread.sessionId || codexId),
      contained: containedMetadata.containedCodexIsolated === true,
    }),
  }, env);
  await appendEvent({ type: "codex_app_server_thread_started", threadId: thread.id, codexThreadId: codexId }, env).catch(() => {});
  return withInternalClient({ thread: updated, codexThread }, client);
}

export async function resumeCodexAppServerThread(thread, env = process.env) {
  if (threadUsesRestrictedCodexPolicy(thread, env)) {
    const relocation = await relocateLegacyUserWorkspace(thread, env).catch(() => null);
    if (relocation?.relocated && relocation.patch) {
      const relocated = await updateThread(thread.id, {
        ...relocation.patch,
        codexThreadId: null,
        codexSessionId: null,
        executor: {
          ...(relocation.patch.executor || thread.executor || {}),
          codexThreadId: null,
          codexSessionId: null,
          metadata: {
            ...(relocation.patch.executor?.metadata || thread.executor?.metadata || {}),
            codexThreadId: null,
            codexSessionId: null,
          },
        },
      }, env);
      await appendEvent({
        type: "contained_thread_workspace_relocated",
        threadId: relocated.id,
        ownerUserId: relocated.ownerUserId || null,
        previousWorkspace: relocation.previousWorkspace,
        workspace: relocation.workspace,
      }, env).catch(() => {});
      return startCodexAppServerThread(relocated, env);
    }
  }
  if (!containedCodexRuntimeIsCurrent(thread, env)) {
    const freshThread = {
      ...thread,
      codexThreadId: null,
      codexSessionId: null,
      executor: {
        ...(thread.executor || {}),
        codexThreadId: null,
        codexSessionId: null,
        metadata: {
          ...(thread.executor?.metadata || {}),
          codexThreadId: null,
          codexSessionId: null,
        },
      },
    };
    return startCodexAppServerThread(freshThread, env);
  }
  const id = codexThreadId(thread);
  if (!id) return startCodexAppServerThread(thread, env);
  const workspace = workspaceForThread(thread);
  if (workspace) await ensureRuntimeAgentsFile(workspace, env, { thread }).catch(() => {});
  await ensureContainedCodexRuntimeHome(thread, env);
  const runtimeEnv = codexRuntimeEnvForThread(thread, env);
  const client = await getCodexAppServerClient({ env: runtimeEnv, home: runtimeHome(runtimeEnv) });
  const developerInstructions = containedUserDeveloperInstructions(thread, runtimeEnv);
  const containedMetadata = containedCodexRuntimeMetadata(thread, env) || {};
  const result = await client.request("thread/resume", {
    threadId: id,
    ...(developerInstructions ? { developerInstructions } : {}),
  });
  const codexThread = result?.thread || {};
  const updated = await updateThread(thread.id, {
    state: "ready",
    lastError: null,
    runtimeKind: "codex-app-server",
    codexSessionId: clean(codexThread.sessionId || codexSessionId(thread) || id),
    executor: {
      ...(thread.executor || {}),
      transport: "app-server",
      codexThreadId: id,
      codexSessionId: clean(codexThread.sessionId || codexSessionId(thread) || id),
      metadata: {
        ...(thread.executor?.metadata || {}),
        transport: "app-server",
        runtimeKind: "codex-app-server",
        codexThreadId: id,
        codexSessionId: clean(codexThread.sessionId || codexSessionId(thread) || id),
        ...containedMetadata,
      },
    },
    runtime: resumeRuntime(thread, {
      codexId: id,
      codexSessionId: clean(codexThread.sessionId || codexSessionId(thread) || id),
      contained: containedMetadata.containedCodexIsolated === true,
    }),
  }, env);
  return withInternalClient({ thread: updated, codexThread, status: await codexAppServerThreadStatus(updated, env) }, client);
}

export async function answerCodexAppServerPendingRequest(thread, options = {}, env = process.env) {
  const current = thread?.id ? await getThread(thread.id, env).catch(() => null) || thread : thread;
  if (!current?.id) return { ok: false, answered: false, reason: "thread_required" };
  const id = codexThreadId(current);
  if (!id) return { ok: false, answered: false, reason: "codex_thread_id_required" };
  const status = await codexAppServerThreadStatus(current, env).catch((error) => ({
    state: "failed",
    error: publicError(error),
    pendingRequest: null,
  }));
  if (status.state !== "awaiting_approval" || !status.pendingRequest) {
    return { ok: false, answered: false, reason: "no_pending_request", status };
  }
  const refreshed = await getThread(current.id, env).catch(() => null) || current;
  await ensureContainedCodexRuntimeHome(refreshed, env);
  const runtimeEnv = codexRuntimeEnvForThread(refreshed, env);
  const client = await getCodexAppServerClient({ env: runtimeEnv, home: runtimeHome(runtimeEnv) });
  const request = client.pendingRequestForThread(refreshed, { includePersisted: true });
  if (!request) return { ok: false, answered: false, reason: "pending_request_not_actionable", status };
  const decision = clean(options.decision || "accept") || "accept";
  const text = clean(options.text || "");
  const answeredRequest = await client.answerPendingRequest(refreshed, decision, { text });
  const updated = await getThread(current.id, env).catch(() => null) || refreshed;
  return {
    ok: true,
    answered: true,
    request: answeredRequest,
    thread: updated,
    status: await codexAppServerThreadStatus(updated, env).catch(() => null),
  };
}

export async function interruptCodexAppServerThread(thread, env = process.env) {
  const id = codexThreadId(thread);
  if (!id) return { interrupted: false, reason: "codex_thread_id_required" };
  await ensureContainedCodexRuntimeHome(thread, env);
  const runtimeEnv = codexRuntimeEnvForThread(thread, env);
  const client = await getCodexAppServerClient({ env: runtimeEnv, home: runtimeHome(runtimeEnv) });
  let clientState = client.threadStates.get(id);
  let activeTurnId = clean(clientState?.activeTurnId) || clean(thread.runtime?.activeTurnId);
  if (!activeTurnId) {
    const liveState = await readLiveCodexThreadState(client, id);
    if (liveState) {
      clientState = liveState;
      activeTurnId = clean(liveState.activeTurnId);
    }
  }
  if (!activeTurnId) return { interrupted: false, reason: "no_active_turn" };
  await client.request("turn/interrupt", { threadId: id, turnId: activeTurnId });
  client.threadStates.set(id, { ...(client.threadStates.get(id) || {}), activeTurnId: "", activeTurnObservedAt: null, status: { type: "idle" }, statusObservedAt: nowIso() });
  for (const [requestKey, request] of client.pendingRequests.entries()) {
    if (request?.threadId === thread.id || request?.codexThreadId === id) client.pendingRequests.delete(requestKey);
  }
  await updateThread(thread.id, {
    state: "ready",
    runtime: { ...(thread.runtime || {}), runtimeKind: "codex-app-server", activeTurnId: null, pendingRequest: null, state: "ready" },
  }, env).catch(() => {});
  await appendTurnLifecycleEvent("interrupted", {
    threadId: thread.id,
    runtimeKind: "codex-app-server",
    turnId: activeTurnId,
    state: "interrupted",
    source: "codex-app-server",
  }, env).catch(() => {});
  return { interrupted: true, turnId: activeTurnId };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainCodexAppServerNotifications(client, { cycles = 3, until = null, delayMs = 0 } = {}) {
  for (let index = 0; index < cycles; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await client.drainNotifications?.();
    if (until?.()) return true;
    if (delayMs > 0) {
      await delay(delayMs);
      await client.drainNotifications?.();
      if (until?.()) return true;
    }
  }
  return Boolean(until?.());
}

async function startCodexAppServerTurn({ client, thread, id, pending, env, runtimeEnv = env, observedVia = "codex_app_server_turn_start" }) {
  const result = await client.request("turn/start", turnStartParams(thread, pending, runtimeEnv));
  const turnId = clean(result?.turn?.id || result?.turnId);
  const status = clean(result?.turn?.status || result?.status).toLowerCase();
  const terminalResult = ["completed", "failed", "interrupted", "aborted", "cancelled", "canceled"].includes(status);
  const completedKey = turnId && client.turnParentKey ? client.turnParentKey(id, turnId) : "";
  if (turnId) client.rememberTurnParent(id, turnId, pending);
  await drainCodexAppServerNotifications(client, {
    cycles: completedKey ? 20 : 3,
    delayMs: completedKey ? 5 : 0,
    until: completedKey ? () => Boolean(client.completedTurns?.has(completedKey)) : null,
  });
  const alreadyCompleted = Boolean(completedKey && client.completedTurns?.has(completedKey));
  if (turnId && !terminalResult && !alreadyCompleted) {
    client.threadStates.set(id, { ...(client.threadStates.get(id) || {}), activeTurnId: turnId, activeTurnObservedAt: nowIso(), status: { type: "active", activeFlags: ["running"] }, statusObservedAt: nowIso() });
    await updateThread(thread.id, {
      state: "working",
      runtime: { ...(thread.runtime || {}), runtimeKind: "codex-app-server", activeTurnId: turnId, state: "working" },
    }, env).catch(() => {});
    await appendTurnLifecycleEvent("started", {
      threadId: thread.id,
      messageId: pending.id,
      runtimeKind: "codex-app-server",
      turnId,
      state: "running",
      source: "codex-app-server",
    }, env).catch(() => {});
  }
  return { result, observedVia, turnId };
}

async function claimCodexAppServerPendingInput(thread, message, env = process.env) {
  const messages = await listThreadMessages(thread.id, env).catch(() => []);
  const current = messages.find((item) => item.id === message.id);
  if (!current || current.role !== "user" || !pendingInputStates.has(clean(current.state))) {
    await appendEvent({
      type: "codex_app_server_input_stale_claim_ignored",
      threadId: thread.id,
      messageId: message.id,
      state: clean(current?.state),
      deliveryState: clean(current?.deliveryState),
    }, env).catch(() => {});
    return null;
  }
  if (recentDeliveryClaim(current, env)) {
    await appendEvent({
      type: "codex_app_server_input_claim_busy",
      threadId: thread.id,
      messageId: current.id,
      state: clean(current.state),
      deliveryState: clean(current.deliveryState),
      deliveryLastAttemptAt: clean(current.deliveryLastAttemptAt),
    }, env).catch(() => {});
    return null;
  }
  const deliveryClaimId = randomUUID();
  await updateThreadMessage(thread.id, current.id, {
    state: "pending_delivery",
    deliveryState: "codex_app_server_sending",
    deliveryLastAttemptAt: nowIso(),
    deliveryClaimId,
  }, env);
  const claimedMessages = await listThreadMessages(thread.id, env).catch(() => []);
  const claimed = claimedMessages.find((item) => item.id === current.id);
  if (clean(claimed?.deliveryClaimId) !== deliveryClaimId || clean(claimed?.deliveryState) !== "codex_app_server_sending") {
    await appendEvent({
      type: "codex_app_server_input_claim_lost",
      threadId: thread.id,
      messageId: current.id,
      state: clean(claimed?.state),
      deliveryState: clean(claimed?.deliveryState),
    }, env).catch(() => {});
    return null;
  }
  return claimed;
}

export async function sendCodexAppServerInput(thread, message, env = process.env) {
  if (!containedCodexRuntimeIsCurrent(thread, env)) {
    const restarted = await resumeCodexAppServerThread(thread, env);
    thread = restarted.thread || thread;
  }
  const id = codexThreadId(thread);
  if (!id) throw new Error("codex_thread_id_required");
  await ensureContainedCodexRuntimeHome(thread, env);
  const runtimeEnv = codexRuntimeEnvForThread(thread, env);
  const client = await getCodexAppServerClient({ env: runtimeEnv, home: runtimeHome(runtimeEnv) });
  const pending = await claimCodexAppServerPendingInput(thread, message, env);
  if (!pending) {
    return { message, result: null, observedVia: "codex_app_server_stale_claim", skipped: true };
  }
  let clientState = client.threadStates.get(id) || {};
  let clientStatusState = appServerStateFromStatus(clientState.status);
  const persistedActiveTurnId = clean(thread.runtime?.activeTurnId);
  const stateActiveTurnId = clean(Object.prototype.hasOwnProperty.call(clientState, "activeTurnId") ? clientState.activeTurnId : "");
  const statusLooksActive = clean(clientState.status?.type || thread.runtime?.codexStatus?.type).toLowerCase() === "active";
  const persistedStatusState = appServerStateFromStatus(thread.runtime?.codexStatus || null);
  const threadLooksWorking = [thread.state, thread.runtime?.state].map((value) => clean(value).toLowerCase()).includes("working");
  if (!stateActiveTurnId && !persistedActiveTurnId && (statusLooksActive || threadLooksWorking)) {
    const liveState = await readLiveCodexThreadState(client, id);
    if (liveState) {
      clientState = liveState;
      clientStatusState = appServerStateFromStatus(clientState.status);
    }
  }
  const effectiveStatusState = clientStatusState || persistedStatusState;
  const statusClearsActiveTurn = ["ready", "failed", "unloaded", "awaiting_approval"].includes(effectiveStatusState);
  if (statusClearsActiveTurn && (clean(clientState.activeTurnId) || persistedActiveTurnId)) {
    client.threadStates.set(id, { ...clientState, activeTurnId: "", activeTurnObservedAt: null, statusObservedAt: nowIso() });
    await updateThread(thread.id, {
      state: effectiveStatusState === "ready" ? "ready" : effectiveStatusState,
      runtime: {
        ...(thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: effectiveStatusState === "ready" ? "ready" : effectiveStatusState,
        activeTurnId: null,
        pendingRequest: effectiveStatusState === "awaiting_approval" ? thread.runtime?.pendingRequest || null : null,
        codexStatus: clientState.status || thread.runtime?.codexStatus || null,
      },
    }, env).catch(() => {});
    await appendEvent({
      type: "codex_app_server_stale_active_turn_cleared_before_delivery",
      threadId: thread.id,
      codexThreadId: id,
      messageId: pending.id,
      activeTurnId: clean(clientState.activeTurnId) || persistedActiveTurnId,
      status: effectiveStatusState,
    }, env).catch(() => {});
  }
  let activeTurnId = statusClearsActiveTurn
    ? ""
    : clean(Object.prototype.hasOwnProperty.call(clientState, "activeTurnId") ? clientState.activeTurnId : thread.runtime?.activeTurnId);
  let result;
  let observedVia;
  let deliveryTurnId = activeTurnId;
  if (activeTurnId && pending.forceDeliveryAfterInterrupt === true) {
    await client.request("turn/interrupt", { threadId: id, turnId: activeTurnId }).catch(() => null);
    client.threadStates.set(id, { ...(client.threadStates.get(id) || {}), activeTurnId: "", activeTurnObservedAt: null, status: { type: "idle" }, statusObservedAt: nowIso() });
    for (const [requestKey, request] of client.pendingRequests.entries()) {
      if (request?.threadId === thread.id || request?.codexThreadId === id) client.pendingRequests.delete(requestKey);
    }
    await updateThread(thread.id, {
      state: "ready",
      runtime: { ...(thread.runtime || {}), runtimeKind: "codex-app-server", activeTurnId: null, pendingRequest: null, state: "ready" },
    }, env).catch(() => {});
    activeTurnId = "";
    deliveryTurnId = "";
  }
  if (activeTurnId) {
    const retryMs = codexAppServerActiveTurnRetryMs(env);
    const nextAttemptAt = isoAfter(retryMs);
    await updateThreadMessage(thread.id, pending.id, {
      state: "queued",
      deliveryState: "awaiting_active_turn",
      deliveryNextAttemptAt: nextAttemptAt,
      deliveryClaimId: null,
      error: null,
    }, env).catch(() => {});
    await appendEvent({
      type: "codex_app_server_input_deferred_active_turn",
      threadId: thread.id,
      codexThreadId: id,
      messageId: pending.id,
      activeTurnId,
      nextAttemptAt,
    }, env).catch(() => {});
    scheduleCodexAppServerInputDelivery(thread.id, env, retryMs);
    return { message: { ...pending, state: "queued", deliveryState: "awaiting_active_turn" }, result: null, observedVia: "codex_app_server_awaiting_active_turn", deferred: true };
  }
  const started = await startCodexAppServerTurn({ client, thread, id, pending, env, runtimeEnv });
  result = started.result;
  observedVia = started.observedVia;
  deliveryTurnId = started.turnId;
  const resultTurn = result?.turn || {};
  for (const item of Array.isArray(resultTurn.items) ? resultTurn.items : []) {
    const turnId = resultTurn.id || result?.turnId || deliveryTurnId;
    await client.projectItem(item, { threadId: id, turnId, parentMessage: client.turnParent(id, turnId) || pending }, id).catch(() => null);
  }
  const completed = await updateThreadMessage(thread.id, pending.id, {
    state: "completed",
    deliveryState: "delivered",
    deliveredAt: nowIso(),
    observedVia,
    deliveryClaimId: null,
    codexThreadId: id,
    codexTurnId: result?.turn?.id || result?.turnId || deliveryTurnId || null,
    error: null,
  }, env);
  await appendEvent({ type: "thread_input_delivered", threadId: thread.id, messageId: message.id, observedVia }, env).catch(() => {});
  return { message: completed, result, observedVia };
}

export async function deliverCodexAppServerPendingInputs(thread, env = process.env) {
  const lockKey = clean(thread?.id);
  if (!lockKey) return [];
  if (appServerDeliveryLocks.has(lockKey)) {
    await appendEvent({ type: "codex_app_server_input_delivery_in_flight", threadId: lockKey }, env).catch(() => {});
    return [];
  }
  appServerDeliveryLocks.add(lockKey);
  try {
    return await deliverCodexAppServerPendingInputsUnlocked(thread, env);
  } finally {
    appServerDeliveryLocks.delete(lockKey);
  }
}

async function deliverCodexAppServerPendingInputsUnlocked(thread, env = process.env) {
  const delivered = [];
  const messages = await listThreadMessages(thread.id, env);
  let next = messages.find((message) => message.role === "user" && pendingInputStates.has(message.state));
  if (!next) return delivered;
  thread = await getThread(thread.id, env).catch(() => null) || thread;
  const securityCommand = await completeThreadSecurityApproveCommand(thread, next, env);
  if (securityCommand?.handled) {
    delivered.push(next.id);
    return delivered;
  }
  let client;
  let runtimeEnv = env;
  try {
    await ensureContainedCodexRuntimeHome(thread, env);
    runtimeEnv = codexRuntimeEnvForThread(thread, env);
    client = await getCodexAppServerClient({ env: runtimeEnv, home: runtimeHome(runtimeEnv) });
  } catch (error) {
    const errorText = publicError(error);
    await updateThread(thread.id, { state: "failed", lastError: errorText }, env).catch(() => {});
    await appendEvent({ type: "codex_app_server_unavailable", threadId: thread.id, error: errorText }, env).catch(() => {});
    return delivered;
  }
  let id = codexThreadId(thread);
  const statusType = clean(client.threadStates.get(id)?.status?.type);
  const threadState = clean(thread.state);
  if (id && (!statusType || statusType === "notLoaded" || threadState === "sleeping" || threadState === "unloaded" || threadState === "failed")) {
    try {
      const resumed = await resumeCodexAppServerThread(thread, env);
      thread = resumed.thread || thread;
      client = resumed.client || client;
      id = codexThreadId(thread);
    } catch (error) {
      const errorText = publicError(error);
      await updateThreadMessage(thread.id, next.id, {
        state: "queued",
        deliveryState: "waiting_codex_resume",
        deliveryLastAttemptAt: nowIso(),
        error: errorText,
      }, env).catch(() => {});
      await updateThread(thread.id, { state: "unloaded", lastError: errorText }, env).catch(() => {});
      await appendEvent({ type: "codex_app_server_resume_failed", threadId: thread.id, codexThreadId: id, error: errorText }, env).catch(() => {});
      return delivered;
    }
  }
  const approvalStatusState = appServerStateFromStatus(client.threadStates.get(id)?.status || thread.runtime?.codexStatus);
  const pendingApproval = client.pendingRequestForThread(thread, { includePersisted: approvalStatusState === "awaiting_approval" });
  const text = clean(next.text);
  if (pendingApproval?.method === "item/tool/requestUserInput") {
    await client.answerPendingRequest(thread, "answer", { text });
    await updateThreadMessage(thread.id, next.id, {
      state: "completed",
      deliveryState: "delivered",
      deliveredAt: nowIso(),
      observedVia: "codex_app_server_user_input",
    }, env);
    delivered.push(next.id);
    return delivered;
  }
  if (pendingApproval && /^(\/?approve(?:d)?|yes|y|allow|go|proceed)\b/i.test(text)) {
    const decision = /\bsession\b/i.test(text) ? "acceptForSession" : "accept";
    await client.answerPendingRequest(thread, decision);
    await updateThreadMessage(thread.id, next.id, {
      state: "completed",
      deliveryState: "delivered",
      deliveredAt: nowIso(),
      observedVia: "codex_app_server_approval",
    }, env);
    delivered.push(next.id);
    return delivered;
  }
  if (pendingApproval && /^(\/?deny|no|n|reject|cancel|stop)\b/i.test(text)) {
    await client.answerPendingRequest(thread, "decline");
    await updateThreadMessage(thread.id, next.id, {
      state: "completed",
      deliveryState: "delivered",
      deliveredAt: nowIso(),
      observedVia: "codex_app_server_approval_declined",
    }, env);
    delivered.push(next.id);
    return delivered;
  }
  const parsedCommand = parseThreadInputCommand({ text });
  if (parsedCommand.command === "plan" || parsedCommand.command === "code") {
    const payloadText = clean(parsedCommand.text);
    if (!payloadText && !clean(next.promptFile)) {
      const completed = await completeCodexAppServerModeCommand(thread, next, parsedCommand.command, env);
      if (completed?.messageId) delivered.push(completed.messageId);
      return delivered;
    }
    await recordCodexAppServerModeCommand(thread, next, parsedCommand.command, env);
    next = await updateThreadMessage(thread.id, next.id, {
      text: payloadText,
      state: "queued",
      deliveryState: "mode_recorded",
      observedVia: "codex_app_server_mode_recorded",
      error: null,
    }, env).catch(() => ({ ...next, text: payloadText, state: "queued", deliveryState: "mode_recorded" }));
  }
  if (parsedCommand.command === "interrupt") {
    const interrupted = await interruptCodexAppServerThread(thread, env).catch(() => ({ interrupted: false }));
    const payloadText = clean(parsedCommand.text);
    if (!payloadText && !clean(next.promptFile)) {
      await updateThreadMessage(thread.id, next.id, {
        state: "completed",
        deliveryState: "delivered",
        deliveredAt: nowIso(),
        observedVia: "codex_app_server_interrupt",
        interruptSent: Boolean(interrupted?.interrupted),
        error: null,
      }, env);
      delivered.push(next.id);
      return delivered;
    }
    next = await updateThreadMessage(thread.id, next.id, {
      text: payloadText,
      state: "queued",
      deliveryState: "interrupting",
      observedVia: "codex_app_server_interrupt",
      interruptSent: Boolean(interrupted?.interrupted),
      forceDeliveryAfterInterrupt: true,
      error: null,
    }, env).catch(() => ({ ...next, text: payloadText, state: "queued", deliveryState: "interrupting", forceDeliveryAfterInterrupt: true }));
  }
  if (parsedCommand.command === "stop") {
    const interrupted = await interruptCodexAppServerThread(thread, env).catch(() => ({ interrupted: false }));
    await updateThreadMessage(thread.id, next.id, {
      state: "completed",
      deliveryState: "delivered",
      deliveredAt: nowIso(),
      observedVia: "codex_app_server_stop",
      interruptSent: Boolean(interrupted?.interrupted),
      error: null,
    }, env);
    delivered.push(next.id);
    return delivered;
  }
  if (parsedCommand.command === "safe_reset") {
    const whatsappCommand = clean(next.connector).toLowerCase() === "whatsapp" ||
      clean(next.source).toLowerCase().includes("whatsapp");
    const result = await performCodexAppServerSafeReset(thread, {
      reason: whatsappCommand ? "whatsapp_safe_reset_command" : "safe_reset_command",
      interruptThread: interruptCodexAppServerThread,
      startThread: startCodexAppServerThread,
    }, env);
    await updateThreadMessage(thread.id, next.id, {
      state: "completed",
      deliveryState: "delivered",
      deliveredAt: nowIso(),
      observedVia: "orkestr_safe_reset_command",
      error: null,
      resetSlept: result.slept,
      manualCheckpointPath: result.manualCheckpoint?.path || null,
      oldCodexThreadId: result.oldCodexThreadId || null,
      newCodexThreadId: result.newCodexThreadId || null,
    }, env);
    await appendEvent({
      type: "thread_safe_reset_command",
      threadId: thread.id,
      messageId: next.id,
      source: next.source || null,
      oldCodexThreadId: result.oldCodexThreadId || null,
      newCodexThreadId: result.newCodexThreadId || null,
      manualCheckpointPath: result.manualCheckpoint?.path || null,
    }, env).catch(() => {});
    delivered.push(next.id);
    return delivered;
  }
  try {
    thread = await getThread(thread.id, env).catch(() => null) || thread;
    const result = await sendCodexAppServerInput(thread, next, env);
    if (result.skipped) return delivered;
    if (!result.deferred) delivered.push(result.message.id);
  } catch (error) {
    const errorText = publicError(error);
    await updateThreadMessage(thread.id, next.id, {
      state: "failed",
      deliveryState: "failed",
      deliveryClaimId: null,
      error: errorText,
    }, env).catch(() => {});
    await updateThread(thread.id, { state: "failed", lastError: errorText }, env).catch(() => {});
    await appendEvent({ type: "thread_input_delivery_failed", threadId: thread.id, messageId: next.id, error: errorText }, env).catch(() => {});
  }
  return delivered;
}

export async function codexAppServerThreadStatus(thread, env = process.env, counts = {}) {
  const id = codexThreadId(thread);
  await ensureContainedCodexRuntimeHome(thread, env);
  const runtimeEnv = codexRuntimeEnvForThread(thread, env);
  const client = id ? await getCodexAppServerClient({ env: runtimeEnv, home: runtimeHome(runtimeEnv) }).catch(() => null) : null;
  let hasClientState = Boolean(id && client?.threadStates.has(id));
  let state = hasClientState ? client.threadStates.get(id) || {} : {};
  const stateActiveTurnIdBeforeRead = hasClientState && Object.prototype.hasOwnProperty.call(state, "activeTurnId")
    ? clean(state.activeTurnId)
    : "";
  const statusLooksActive = clean(state.status?.type || thread.runtime?.codexStatus?.type).toLowerCase() === "active";
  const threadLooksWorking = [thread.state, thread.runtime?.state].map((value) => clean(value).toLowerCase()).includes("working");
  if (id && client && !stateActiveTurnIdBeforeRead && (statusLooksActive || threadLooksWorking)) {
    const liveState = await readLiveCodexThreadState(client, id);
    if (liveState) {
      hasClientState = true;
      state = liveState;
    }
  }
  if (id && client && hasClientState) {
    state = markActiveTurnObserved(client, id, state);
    if (activeTurnNeedsLiveVerification(state, runtimeEnv)) {
      const liveState = await readLiveCodexThreadState(client, id);
      if (liveState) {
        hasClientState = true;
        state = liveState;
      }
    }
  }
  const livePendingRequest = client?.pendingRequestForThread(thread, { includePersisted: false }) || null;
  const persistedPendingRequest = thread.runtime?.pendingRequest || null;
  const rawCodexStatus = hasClientState ? state.status || null : thread.runtime?.codexStatus || null;
  const stateActiveTurnId = hasClientState && Object.prototype.hasOwnProperty.call(state, "activeTurnId")
    ? clean(state.activeTurnId)
    : "";
  const knownActiveTurnWithIdleStatus = Boolean(stateActiveTurnId && appServerStateFromStatus(rawCodexStatus) === "ready" && clean(rawCodexStatus?.type).toLowerCase() === "idle");
  const rawStatusState = knownActiveTurnWithIdleStatus ? "working" : appServerStateFromStatus(rawCodexStatus);
  const statusState = hasClientState || rawStatusState !== "working" ? rawStatusState : "";
  const pendingRequest = livePendingRequest || (persistedPendingRequest && rawStatusState === "awaiting_approval" ? persistedPendingRequest : null);
  if (persistedPendingRequest && !pendingRequest && ["ready", "failed", "unloaded"].includes(rawStatusState)) {
    await updateThread(thread.id, {
      state: rawStatusState === "ready" ? "ready" : rawStatusState,
      runtime: {
        ...(thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: rawStatusState === "ready" ? "ready" : rawStatusState,
        pendingRequest: null,
        activeTurnId: rawStatusState === "ready" ? null : thread.runtime?.activeTurnId || null,
        codexStatus: rawCodexStatus || null,
        updatedAt: nowIso(),
      },
    }, env).catch(() => {});
    await appendEvent({
      type: "codex_app_server_stale_pending_request_cleared",
      threadId: thread.id,
      codexThreadId: id || null,
      status: rawStatusState,
      requestId: clean(persistedPendingRequest.requestId || persistedPendingRequest.id),
    }, env).catch(() => {});
  }
  let activeTurnId = statusState && ["ready", "failed", "unloaded", "awaiting_approval"].includes(statusState)
    ? ""
    : stateActiveTurnId;
  const finalAnswerCompletedActiveTurn = await activeTurnHasCompletedFinalAnswer(thread, activeTurnId, env, counts);
  if (finalAnswerCompletedActiveTurn) {
    activeTurnId = "";
    if (id && client) {
      client.threadStates.set(id, {
        ...(client.threadStates.get(id) || state),
        activeTurnId: "",
        activeTurnObservedAt: null,
        status: { type: "idle" },
        statusObservedAt: nowIso(),
      });
    }
  }
  const threadState = clean(thread.state);
  const fallbackState = threadState === "sleeping" || threadState === "unloaded"
    ? "unloaded"
    : threadState === "failed"
      ? "failed"
      : "ready";
  const runtimeState = pendingRequest ? "awaiting_approval" : activeTurnId ? "working" : finalAnswerCompletedActiveTurn ? "ready" : statusState || fallbackState;
  const codexStatus = finalAnswerCompletedActiveTurn
    ? { type: "idle" }
    : activeTurnId && clean(rawCodexStatus?.type).toLowerCase() === "idle"
    ? { ...rawCodexStatus, type: "active", activeFlags: ["running"] }
    : rawCodexStatus;
  const clearedActiveTurnId = stateActiveTurnIdBeforeRead || clean(thread.runtime?.activeTurnId);
  if (clearedActiveTurnId && runtimeState !== "working" && !activeTurnId) {
    await updateThread(thread.id, {
      state: runtimeState === "ready" ? "ready" : runtimeState,
      runtime: {
        ...(thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: runtimeState === "ready" ? "ready" : runtimeState,
        activeTurnId: null,
        pendingRequest: runtimeState === "awaiting_approval" ? pendingRequest : null,
        codexStatus: codexStatus || null,
        updatedAt: nowIso(),
      },
    }, env).catch(() => {});
    await appendEvent({
      type: "codex_app_server_stale_active_turn_cleared_by_status",
      threadId: thread.id,
      codexThreadId: id || null,
      activeTurnId: clearedActiveTurnId,
      status: runtimeState,
      reason: finalAnswerCompletedActiveTurn ? "completed_final_answer" : "live_status",
    }, env).catch(() => {});
  }
  const progress = appServerStatusProgress({ thread, runtimeState, codexStatus, pendingRequest });
  const status = {
    state: runtimeState,
    status: runtimeState,
    runtimeState: "codex-app-server",
    runtimeKind: "codex-app-server",
    codexAppServerTransport: client?.transport || codexAppServerTransport(runtimeEnv),
    codexAppServerSocket: client?.socket || codexAppServerSocket(runtimeEnv) || null,
    codexThreadId: id || null,
    codexSessionId: codexSessionId(thread) || id || null,
    codexStatus,
    activeTurnId: activeTurnId || null,
    pendingRequest,
    lease: null,
    sessionName: null,
    paneId: null,
    windowName: null,
    promptReady: runtimeState === "ready",
    promptReadyStable: runtimeState === "ready",
    working: runtimeState === "working",
    foregroundWorking: runtimeState === "working",
    typingActive: runtimeState === "working",
    backgroundWork: false,
    pendingCount: counts.pendingCount || 0,
    awaitingAckCount: counts.awaitingAckCount || 0,
    nextDeliveryAttemptAt: counts.nextDeliveryAttemptAt || null,
    runningCount: counts.runningCount || 0,
    wakePolicy: thread.wakePolicy || "wake-on-message",
    hibernated: false,
    codexMode: thread.codexMode || null,
    codexModeSource: thread.codexModeSource || null,
    planImplementationReady: false,
    planImplementationMenuVisible: false,
    planImplementationSelectedChoice: null,
    progress,
  };
  return {
    ...status,
    turnLifecycle: turnLifecycleFromRuntimeStatus(status),
  };
}

export async function listCodexAppServerThreads(options = {}, env = process.env) {
  const client = await getCodexAppServerClient({ env, home: runtimeHome(env) });
  const params = {
    cursor: options.cursor || null,
    limit: Math.max(1, Math.min(100, Number(options.limit || 25) || 25)),
    sortKey: options.sortKey || "updated_at",
    sortDirection: options.sortDirection || "desc",
    sourceKinds: options.sourceKinds || ["cli", "vscode", "appServer"],
    archived: options.archived === true,
    searchTerm: clean(options.searchTerm || options.search || ""),
  };
  if (!params.searchTerm) delete params.searchTerm;
  return client.request("thread/list", params);
}

export async function readCodexAppServerThread(codexThreadId, env = process.env, includeTurns = true) {
  const client = await getCodexAppServerClient({ env, home: runtimeHome(env) });
  return client.request("thread/read", { threadId: clean(codexThreadId), includeTurns });
}

export async function syncCodexAppServerThreadMessages(thread, env = process.env, options = {}) {
  const id = codexThreadId(thread);
  if (!id) return { synced: false, reason: "codex_thread_id_required", count: 0 };
  if (String(env.ORKESTR_CODEX_APP_SERVER_HISTORY_SYNC || "").trim() === "0") {
    return { synced: false, reason: "disabled", count: 0 };
  }
  const syncKey = `${thread.id || ""}:${id}`;
  const intervalMs = codexAppServerHistorySyncIntervalMs(env);
  const nowMs = Date.now();
  const previousMs = appServerHistorySyncTimes.get(syncKey) || 0;
  if (!options.force && intervalMs > 0 && previousMs && nowMs - previousMs < intervalMs) {
    return { synced: false, reason: "throttled", count: 0 };
  }
  appServerHistorySyncTimes.set(syncKey, nowMs);
  await ensureContainedCodexRuntimeHome(thread, env);
  const runtimeEnv = codexRuntimeEnvForThread(thread, env);
  const read = await readCodexAppServerThread(id, runtimeEnv, true);
  const codexThread = read?.thread || {};
  const result = await hydrateCodexAppServerThreadMessages(thread, codexThread, env);
  await appendEvent({
    type: "codex_app_server_thread_history_synced",
    threadId: thread.id,
    codexThreadId: id,
    count: result.count,
    created: result.created,
    updated: result.updated,
  }, env).catch(() => {});
  return { synced: true, ...result, codexThread };
}

export async function importCodexAppServerThread(codexThreadIdValue, input = {}, env = process.env) {
  const id = clean(codexThreadIdValue || input.codexThreadId || input.threadId);
  if (!id) {
    const error = new Error("codex_thread_id_required");
    error.statusCode = 400;
    throw error;
  }
  const existing = await threadForCodexThreadId(id, env);
  if (existing) return { thread: existing, imported: false };
  const read = await readCodexAppServerThread(id, env, true);
  const codexThread = read?.thread || {};
  const name = clean(input.name || codexThread.name || codexThread.preview || `Codex ${id.slice(0, 8)}`);
  const { createThread } = await import("./threads.js");
  const thread = await createThread({
    id: clean(input.id) || `codex-${id.replace(/[^a-zA-Z0-9_.-]/g, "_")}`,
    name,
    title: name,
    state: "unloaded",
    cwd: codexThread.cwd || input.cwd || "",
    workspace: codexThread.cwd || input.workspace || "",
    executorId: "codex",
    executor: {
      id: "codex",
      type: "codex",
      transport: "app-server",
      codexThreadId: id,
      codexSessionId: clean(codexThread.sessionId || id),
      metadata: {
        transport: "app-server",
        codexThreadId: id,
        codexSessionId: clean(codexThread.sessionId || id),
        importedFromCodex: true,
      },
    },
    runtimeKind: "codex-app-server",
    runtime: {
      runtimeKind: "codex-app-server",
      state: "unloaded",
      codexThreadId: id,
      codexSessionId: clean(codexThread.sessionId || id),
    },
    codexThreadId: id,
    codexSessionId: clean(codexThread.sessionId || id),
    importedFromCodex: true,
  }, env);
  await hydrateCodexAppServerThreadMessages(thread, codexThread, env);
  await appendEvent({ type: "codex_app_server_thread_imported", threadId: thread.id, codexThreadId: id }, env).catch(() => {});
  return { thread: await getThread(thread.id, env) || thread, imported: true, codexThread };
}

function compactHistoryText(value) {
  return clean(value).replace(/\s+/g, " ");
}

const codexHistoryMinMs = Date.UTC(2020, 0, 1);
const codexHistoryMaxFutureMs = 366 * 24 * 60 * 60 * 1000;

function plausibleCodexHistoryMs(ms) {
  return Number.isFinite(ms) &&
    ms >= codexHistoryMinMs &&
    ms <= Date.now() + codexHistoryMaxFutureMs;
}

function isoTimestamp(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return plausibleCodexHistoryMs(ms) ? new Date(ms).toISOString() : "";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    return plausibleCodexHistoryMs(ms) ? new Date(ms).toISOString() : "";
  }
  const text = clean(value);
  if (!text) return "";
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return plausibleCodexHistoryMs(ms) ? new Date(ms).toISOString() : "";
  }
  const ms = Date.parse(text);
  return plausibleCodexHistoryMs(ms) ? new Date(ms).toISOString() : "";
}

function uuidV7Timestamp(value) {
  const hex = clean(value).replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex) || hex[12] !== "7") return "";
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  return plausibleCodexHistoryMs(ms) ? new Date(ms).toISOString() : "";
}

function offsetCodexHistoryTimestamp(timestamp, offsetMs = 0) {
  const base = Date.parse(clean(timestamp));
  if (!Number.isFinite(base)) return "";
  const offset = Math.max(0, Number(offsetMs) || 0);
  return new Date(base + offset).toISOString();
}

function codexHistoryTimestamp(turn = {}, item = {}, itemIndex = 0) {
  const itemCandidates = [
    item.timestamp,
    item.createdAt,
    item.created_at,
    item.completedAt,
    item.completed_at,
    item.startedAt,
    item.started_at,
  ];
  for (const candidate of itemCandidates) {
    const timestamp = isoTimestamp(candidate);
    if (timestamp) return timestamp;
  }
  const itemUuidTimestamp = uuidV7Timestamp(item.id);
  if (itemUuidTimestamp) return itemUuidTimestamp;

  const turnCandidates = [
    turn.timestamp,
    turn.createdAt,
    turn.created_at,
    turn.completedAt,
    turn.completed_at,
    turn.startedAt,
    turn.started_at,
  ];
  for (const candidate of turnCandidates) {
    const timestamp = isoTimestamp(candidate);
    if (timestamp) return offsetCodexHistoryTimestamp(timestamp, itemIndex);
  }
  const turnUuidTimestamp = uuidV7Timestamp(turn.id);
  return turnUuidTimestamp ? offsetCodexHistoryTimestamp(turnUuidTimestamp, itemIndex) : "";
}

function codexAppServerHistorySource(value) {
  return ["codex-rollout", "codex-app-server", "codex-app-server-import"].includes(clean(value));
}

function completedCodexTurnStatus(value) {
  return clean(value).toLowerCase() === "completed";
}

function finalAnswerHistoryItem(item = {}) {
  const type = clean(item.type);
  if (!["agentMessage", "plan", "exitedReviewMode", "contextCompaction"].includes(type)) return false;
  return clean(itemPhase(item) || "final_answer").toLowerCase() === "final_answer";
}

function latestCompletedHistoryTurnId(turns = []) {
  for (const turn of [...turns].reverse()) {
    const turnId = clean(turn?.id);
    if (!turnId) continue;
    if (completedCodexTurnStatus(turn?.status)) return turnId;
    if ((Array.isArray(turn?.items) ? turn.items : []).some(finalAnswerHistoryItem)) return turnId;
  }
  return "";
}

async function reconcileHydratedCodexTurnCompletion(thread, completedTurnId, env = process.env) {
  const turnId = clean(completedTurnId);
  if (!turnId) return false;
  const activeTurnId = clean(thread?.runtime?.activeTurnId);
  const threadLooksWorking =
    clean(thread?.state).toLowerCase() === "working" ||
    clean(thread?.runtime?.state).toLowerCase() === "working";
  if (activeTurnId && activeTurnId !== turnId) return false;
  if (!activeTurnId && !threadLooksWorking) return false;
  await updateThread(thread.id, {
    state: "ready",
    lastError: null,
    runtime: {
      ...(thread.runtime || {}),
      runtimeKind: "codex-app-server",
      activeTurnId: null,
      lastTurnId: turnId,
      lastTurnStatus: "completed",
      state: "ready",
      codexStatus: { type: "idle" },
      updatedAt: nowIso(),
    },
  }, env).catch(() => {});
  await appendTurnLifecycleEvent("completed", {
    threadId: thread.id,
    runtimeKind: "codex-app-server",
    turnId,
    state: "completed",
    source: "codex-app-server-history",
  }, env).catch(() => {});
  return true;
}

function duplicateHistoryMatch(existing = {}, input = {}) {
  const existingItemId = clean(existing.codexItemId);
  const inputItemId = clean(input.codexItemId);
  const role = clean(input.role);
  const phase = clean(input.phase);
  return role &&
    clean(existing.role) === role &&
    existingItemId &&
    inputItemId &&
    existingItemId !== inputItemId &&
    (role === "user" || codexAppServerHistorySource(existing.source)) &&
    clean(existing.codexThreadId) === clean(input.codexThreadId) &&
    clean(existing.codexTurnId) === clean(input.codexTurnId) &&
    (role === "user" || clean(existing.phase || "final_answer") === clean(phase || "final_answer")) &&
    compactHistoryText(existing.text) === compactHistoryText(input.text);
}

function matchingHydratedMessage(messages = [], input = {}) {
  const eventId = clean(input.eventId);
  if (eventId) {
    const existing = messages.find((message) => clean(message.eventId) === eventId);
    if (existing) return existing;
  }
  const role = clean(input.role);
  const codexId = clean(input.codexThreadId);
  const turnId = clean(input.codexTurnId);
  const itemId = clean(input.codexItemId);
  if (!role || !codexId || !turnId) return null;
  if (itemId) {
    const existing = messages.find((message) =>
      clean(message.role) === role &&
      clean(message.codexThreadId) === codexId &&
      clean(message.codexTurnId) === turnId &&
      clean(message.codexItemId) === itemId
    );
    if (existing) return existing;
  }
  const text = compactHistoryText(input.text);
  if (!text) return null;
  return messages.find((message) =>
    clean(message.role) === role &&
    (role === "user" || codexAppServerHistorySource(message.source)) &&
    clean(message.codexThreadId) === codexId &&
    clean(message.codexTurnId) === turnId &&
    (role === "user" || clean(message.phase || "final_answer") === clean(input.phase || "final_answer")) &&
    compactHistoryText(message.text) === text
  ) || null;
}

function hydrationPatchChanged(existing, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const left = existing?.[key] === undefined || existing?.[key] === null ? "" : String(existing[key]);
    const right = value === undefined || value === null ? "" : String(value);
    if (left !== right) return true;
  }
  return false;
}

async function upsertHydratedCodexMessage(thread, input, messages, env = process.env) {
  const existing = matchingHydratedMessage(messages, input);
  if (!existing) {
    const message = await appendThreadMessage(thread.id, input, env);
    messages.push(message);
    return { message, created: true, updated: false, changed: true };
  }
  const { timestamp, createdAt, ...patchInput } = input;
  const patch = {
    ...patchInput,
    state: input.state || existing.state || "completed",
  };
  const historyCreatedAt = isoTimestamp(createdAt) || isoTimestamp(timestamp);
  if (historyCreatedAt && (existing.source === "codex-app-server-import" || !clean(existing.createdAt))) {
    patch.createdAt = historyCreatedAt;
  }
  if (duplicateHistoryMatch(existing, input)) {
    delete patch.eventId;
    delete patch.createdAt;
    delete patch.codexItemId;
    delete patch.executorItemId;
  }
  if (existing.source && existing.source !== "codex-app-server-import") patch.source = existing.source;
  if (!hydrationPatchChanged(existing, patch)) {
    return { message: existing, created: false, updated: false, changed: false };
  }
  const message = await updateThreadMessage(thread.id, existing.id, patch, env);
  const index = messages.findIndex((item) => item.id === existing.id);
  if (index >= 0) messages[index] = message;
  return { message, created: false, updated: true, changed: true };
}

export async function hydrateCodexAppServerThreadMessages(thread, codexThread, env = process.env) {
  const turns = Array.isArray(codexThread?.turns) ? codexThread.turns : [];
  const messages = await listThreadMessages(thread.id, env).catch(() => []);
  let count = 0;
  let created = 0;
  let updated = 0;
  const completedTurnId = latestCompletedHistoryTurnId(turns);
  for (const turn of turns) {
    const turnId = clean(turn.id);
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const [itemIndex, item] of items.entries()) {
      const type = clean(item.type);
      const timestamp = codexHistoryTimestamp(turn, item, itemIndex);
      if (type === "userMessage") {
        const text = itemText(item) || userInputText(item.input);
        if (!text) continue;
        const result = await upsertHydratedCodexMessage(thread, {
          role: "user",
          source: "codex-app-server-import",
          text,
          state: "completed",
          eventId: threadEventId({ codexThreadId: codexThread.id, turnId, itemId: item.id, type, role: "user", text }),
          codexThreadId: codexThread.id,
          codexTurnId: turnId,
          codexItemId: item.id || null,
          ...(timestamp ? { timestamp, createdAt: timestamp } : {}),
          ...codexAppServerMessageFields(codexThread.id, { turnId, itemId: item.id }),
        }, messages, env).catch(() => null);
        if (result) {
          if (result.created) created += 1;
          if (result.updated) updated += 1;
          if (result.changed) count += 1;
        }
      } else if (["agentMessage", "plan", "exitedReviewMode", "contextCompaction"].includes(type)) {
        const text = type === "contextCompaction" ? "Codex compacted the conversation context." : itemText(item);
        if (!text) continue;
        const whatsappParent =
          await latestWhatsAppParent(thread, timestamp, env) ||
          threadWhatsAppBindingParent(thread);
        const result = await upsertHydratedCodexMessage(thread, {
          role: "assistant",
          source: "codex-app-server-import",
          phase: itemPhase(item) || "final_answer",
          text,
          state: "completed",
          eventId: threadEventId({ codexThreadId: codexThread.id, turnId, itemId: item.id, type, role: "assistant", text }),
          codexThreadId: codexThread.id,
          codexTurnId: turnId,
          codexItemId: item.id || null,
          ...(timestamp ? { timestamp, createdAt: timestamp } : {}),
          ...codexAppServerMessageFields(codexThread.id, { turnId, itemId: item.id }),
          ...whatsappProjectionFields(whatsappParent, thread),
        }, messages, env).catch(() => null);
        if (result) {
          if (result.created) created += 1;
          if (result.updated) updated += 1;
          if (result.changed) count += 1;
          if (result.changed && clean(result.message?.phase || "final_answer").toLowerCase() === "final_answer") {
            markConnectorDeliverySignal(result.message);
          }
        }
      }
    }
  }
  const completed = await reconcileHydratedCodexTurnCompletion(thread, completedTurnId, env);
  return { count, created, updated, completedTurnId: completed ? completedTurnId : null };
}

export async function compactCodexAppServerThread(thread, env = process.env) {
  const id = codexThreadId(thread);
  if (!id) throw new Error("codex_thread_id_required");
  const client = await getCodexAppServerClient({ env, home: runtimeHome(env) });
  await client.request("thread/compact/start", { threadId: id });
  await appendEvent({ type: "thread_context_compacted", threadId: thread.id, codexThreadId: id, method: "codex_app_server_compact" }, env).catch(() => {});
  return { method: "codex_app_server_compact", attempted: true, compacted: true };
}

export async function rollbackCodexAppServerThread(thread, numTurns = 1, env = process.env) {
  const id = codexThreadId(thread);
  if (!id) throw new Error("codex_thread_id_required");
  const client = await getCodexAppServerClient({ env, home: runtimeHome(env) });
  return client.request("thread/rollback", { threadId: id, numTurns: Math.max(1, Number(numTurns) || 1) });
}

export async function archiveCodexAppServerThread(thread, env = process.env) {
  const id = codexThreadId(thread);
  if (!id) return null;
  const client = await getCodexAppServerClient({ env, home: runtimeHome(env) }).catch(() => null);
  if (!client) return null;
  return client.request("thread/archive", { threadId: id }).catch(() => null);
}
