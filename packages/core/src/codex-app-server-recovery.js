import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent } from "../../storage/src/store.js";
import { listThreadMessages, listThreads, updateThread } from "./threads.js";
import { getCodexAppServerClient } from "./codex-app-server-client.js";
import {
  appendOrUpdateEventMessage,
  appServerStateFromStatus,
  clean,
  codexThreadId,
  nowIso,
  publicError,
  runtimeHome,
  threadEventId,
  threadUsesCodexAppServer,
} from "./codex-app-server-common.js";
import {
  codexAppServerMessageFields,
  threadWhatsAppBindingParent,
  whatsappOrigin,
  whatsappProjectionFields,
} from "./codex-app-server-whatsapp.js";
import {
  assistantMessagesForDeliveredTurn,
  messageTurnId,
  terminalAssistantMessage,
} from "./thread-message-visibility.js";
import { readLiveCodexThreadState } from "./codex-app-server-live-state.js";

const recoveryScanCache = new Map();

function safeThreadId(threadId) {
  return String(threadId || "").replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

function runtimeStatusState(thread) {
  return appServerStateFromStatus(thread?.runtime?.codexStatus || null);
}

function staleAppServerRuntime(thread, clientState = null) {
  const activeTurnId = clean(thread?.runtime?.activeTurnId);
  const threadState = clean(thread?.state).toLowerCase();
  const persistedRuntimeState = clean(thread?.runtime?.state).toLowerCase();
  const persistedStatusState = runtimeStatusState(thread);
  const liveStatusState = appServerStateFromStatus(clientState?.status || null);
  const liveActiveTurnId = clean(clientState?.activeTurnId);
  if (liveActiveTurnId || liveStatusState === "working") return false;
  if (activeTurnId) return true;
  if (threadState === "working" || persistedRuntimeState === "working" || persistedStatusState === "working") return true;
  return threadState === "failed" &&
    !clean(thread?.lastError) &&
    (persistedStatusState === "failed" || clean(thread?.runtime?.lastTurnStatus).toLowerCase() === "failed");
}

function staleFinalGraceMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS || 30000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 30000;
}

function staleActiveTurnMs(env = process.env) {
  const raw = String(env.ORKESTR_CODEX_APP_SERVER_STALE_ACTIVE_TURN_MS ?? "180000").trim().toLowerCase();
  if (["0", "off", "false", "disabled"].includes(raw)) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 180000;
}

function staleRecoveryLookbackMs(env = process.env) {
  const fallback = 24 * 60 * 60 * 1000;
  const parsed = Number(env.ORKESTR_CODEX_APP_SERVER_STALE_RECOVERY_LOOKBACK_MS || fallback);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function staleRecoveryScanCacheMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CODEX_APP_SERVER_STALE_RECOVERY_SCAN_CACHE_MS || 120000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 120000;
}

function staleRecoveryMessageScanLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_CODEX_APP_SERVER_STALE_RECOVERY_MESSAGE_SCAN_LIMIT || 2000);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 2000;
}

function timestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function messageActivityMs(message = {}) {
  const item = message || {};
  return Math.max(
    timestampMs(item.timestamp),
    timestampMs(item.deliveredAt),
    timestampMs(item.deliveryLastAttemptAt),
    timestampMs(item.createdAt),
  );
}

function deliveredUserMessage(message = {}) {
  if (message?.role !== "user") return false;
  const state = clean(message.state).toLowerCase();
  if (state && state !== "completed") return false;
  const deliveryState = clean(message.deliveryState).toLowerCase();
  const observedVia = clean(message.observedVia).toLowerCase();
  return deliveryState === "delivered" ||
    observedVia.startsWith("codex_app_server");
}

function latestByStorageOrder(messages = []) {
  return messages.at(-1) || null;
}

function sameTurnMessage(message = {}, userMessage = {}) {
  const turnId = messageTurnId(userMessage);
  if (turnId && messageTurnId(message) === turnId) return true;
  return Boolean(userMessage?.id && message?.parentMessageId === userMessage.id);
}

function runtimeRecoveryMessage(message = {}) {
  return clean(message?.source).toLowerCase() === "orkestr_runtime" ||
    clean(message?.phase).toLowerCase() === "runtime_interrupted";
}

function newerTerminalAssistantAfterTurn(messages = [], latestUser = {}, latestUserIndex = -1, lastActivityMs = 0) {
  const baselineMs = Number(lastActivityMs || messageActivityMs(latestUser) || 0);
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!terminalAssistantMessage(message)) continue;
    if (runtimeRecoveryMessage(message)) continue;
    if (sameTurnMessage(message, latestUser)) continue;
    const candidateMs = messageActivityMs(message);
    if (baselineMs && candidateMs) {
      if (candidateMs > baselineMs) return true;
      continue;
    }
    if (index > latestUserIndex) return true;
  }
  return false;
}

function deliveredTurnState(messages = [], latestUser = {}, latestUserIndex = -1) {
  const assistants = assistantMessagesForDeliveredTurn(messages, latestUser, latestUserIndex);
  if (assistants.some((message) => terminalAssistantMessage(message))) return null;
  const latestAssistant = latestByStorageOrder(assistants);
  const lastActivityMs = Math.max(messageActivityMs(latestAssistant), messageActivityMs(latestUser));
  if (newerTerminalAssistantAfterTurn(messages, latestUser, latestUserIndex, lastActivityMs)) return null;
  return {
    latestUser,
    latestAssistant,
    reason: latestAssistant ? "no_final_answer" : "no_assistant_response",
    lastActivityMs,
  };
}

function latestIncompleteDeliveredTurn(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const latestUser = messages[index];
    if (!deliveredUserMessage(latestUser)) continue;
    const turn = deliveredTurnState(messages, latestUser, index);
    if (turn) return turn;
  }
  return null;
}

function refreshedTurnState(messages = [], originalTurn = null) {
  const latestUserId = clean(originalTurn?.latestUser?.id);
  if (!latestUserId) return null;
  const latestUserIndex = messages.findIndex((message) => message.id === latestUserId);
  if (latestUserIndex < 0) return null;
  const latestUser = messages[latestUserIndex];
  if (!deliveredUserMessage(latestUser)) return null;
  return deliveredTurnState(messages, latestUser, latestUserIndex);
}

function staleTurnNoticeText(reason = "no_assistant_response", options = {}) {
  const noticeCause = clean(options.noticeCause || options.cause).toLowerCase();
  if (noticeCause === "active_turn_timeout") {
    if (reason === "no_final_answer") {
      return [
        "Codex response timed out",
        "",
        "Orkestr found progress updates for this turn, but Codex stayed active too long without a final answer.",
        "Send the next instruction normally to continue.",
        "If this repeats, reply /safe-reset to save recent Orkestr context and start a fresh Codex session for this thread.",
      ].join("\n");
    }
    return [
      "Codex response timed out",
      "",
      "Orkestr delivered this message to Codex, but Codex stayed active too long without producing a visible response.",
      "Send the next instruction normally to continue.",
      "If this repeats, reply /safe-reset to save recent Orkestr context and start a fresh Codex session for this thread.",
    ].join("\n");
  }
  if (noticeCause === "orkestr_restart") {
    if (reason === "no_final_answer") {
      return [
        "Orkestr restarted before Codex finished",
        "",
        "Orkestr restarted while Codex was working on this turn. Progress updates before the restart were preserved, but no final answer was recorded.",
        "Send the next instruction normally to continue.",
      ].join("\n");
    }
    return [
      "Orkestr restarted before Codex replied",
      "",
      "Orkestr restarted after this message reached Codex, before an assistant response was recorded.",
      "Send the next instruction normally to continue.",
    ].join("\n");
  }
  if (reason === "no_final_answer") {
    return [
      "Codex stopped before final answer",
      "",
      "Orkestr found progress updates for this turn, but Codex went idle before a final answer was recorded.",
      "Send the next instruction normally to continue.",
      "If this repeats, reply /safe-reset to save recent Orkestr context and start a fresh Codex session for this thread.",
    ].join("\n");
  }
  return [
    "Codex response missing",
    "",
    "Orkestr found a delivered message with no assistant response after the Codex runtime stopped, restarted, or lost the active turn.",
    "Send the next instruction normally to continue.",
    "If this repeats, reply /safe-reset to save recent Orkestr context and start a fresh Codex session for this thread.",
  ].join("\n");
}

function staleTurnEventId(thread, codexId, turn, options = {}) {
  const message = turn?.latestUser || {};
  const reason = clean(turn?.reason || "no_assistant_response");
  return threadEventId({
    codexThreadId: codexId,
    turnId: clean(message?.codexTurnId || message?.executorTurnId || thread?.runtime?.activeTurnId || "stale-turn"),
    itemId: `stale-${reason}:${message?.id || "latest"}`,
    type: `turn/stale-${reason}`,
    role: "assistant",
    text: staleTurnNoticeText(reason, options),
  });
}

function noticeWhatsappParent(turn, thread = null) {
  if (turn?.latestUser && whatsappOrigin(turn.latestUser)) return turn.latestUser;
  if (turn?.latestAssistant && whatsappOrigin(turn.latestAssistant)) return turn.latestAssistant;
  return threadWhatsAppBindingParent(thread);
}

async function appendStaleTurnNotice(thread, messages, turn, env = process.env, options = {}) {
  const codexId = codexThreadId(thread);
  const latestUser = turn?.latestUser || null;
  const text = staleTurnNoticeText(turn?.reason, options);
  const eventId = staleTurnEventId(thread, codexId, turn, options);
  const existing = messages.find((message) => message.eventId === eventId);
  const whatsappParent = noticeWhatsappParent(turn, thread);
  const notice = await appendOrUpdateEventMessage(thread, {
    role: "assistant",
    source: "orkestr_runtime",
    phase: "runtime_interrupted",
    text,
    state: "completed",
    eventId,
    codexThreadId: codexId,
    codexTurnId: clean(latestUser?.codexTurnId || latestUser?.executorTurnId || thread?.runtime?.activeTurnId) || null,
    ...codexAppServerMessageFields(codexId, {
      turnId: clean(latestUser?.codexTurnId || latestUser?.executorTurnId || thread?.runtime?.activeTurnId),
      itemId: "stale-no-reply",
    }),
    ...whatsappProjectionFields(whatsappParent, thread),
  }, env);
  return { notice, appended: !existing && Boolean(notice?.id) };
}

function incompleteTurnMatchesRuntimeTurn(thread, turn) {
  const runtimeTurnId = clean(thread?.runtime?.activeTurnId);
  return Boolean(runtimeTurnId && runtimeTurnId === messageTurnId(turn?.latestUser));
}

function recentEnoughForStaleRecovery(turn, env = process.env) {
  const lookbackMs = staleRecoveryLookbackMs(env);
  if (lookbackMs <= 0) return true;
  const lastActivityMs = Number(turn?.lastActivityMs || 0);
  if (!lastActivityMs) return true;
  return Date.now() - lastActivityMs <= lookbackMs;
}

function shouldRecoverIncompleteTurn(thread, clientState, turn, env = process.env) {
  if (!turn) return false;
  const liveStatusState = appServerStateFromStatus(clientState?.status || null);
  const liveActiveTurnId = clean(clientState?.activeTurnId);
  if (liveActiveTurnId || liveStatusState === "working") return false;
  const threadState = clean(thread?.state).toLowerCase();
  if (["working", "queued", "pending_delivery", "awaiting_ack"].includes(threadState)) return false;
  if (!incompleteTurnMatchesRuntimeTurn(thread, turn) && !recentEnoughForStaleRecovery(turn, env)) return false;
  if (!turn.lastActivityMs) return true;
  return Date.now() - turn.lastActivityMs >= staleFinalGraceMs(env);
}

function pendingApprovalState(thread = {}, clientState = {}) {
  const liveStatusState = appServerStateFromStatus(clientState?.status || null);
  const threadState = clean(thread?.state).toLowerCase();
  const runtimeState = clean(thread?.runtime?.state).toLowerCase();
  return liveStatusState === "awaiting_approval" ||
    threadState === "awaiting_approval" ||
    runtimeState === "awaiting_approval" ||
    Boolean(thread?.runtime?.pendingRequest);
}

function activeTurnMatchesDeliveredTurn(thread, clientState, turn) {
  const liveActiveTurnIds = activeTurnIdsFromClientState(clientState);
  if (!liveActiveTurnIds.length || !turn) return false;
  const turnId = messageTurnId(turn?.latestUser);
  if (turnId && liveActiveTurnIds.includes(turnId)) return true;
  const runtimeTurnId = clean(thread?.runtime?.activeTurnId);
  return incompleteTurnMatchesRuntimeTurn(thread, turn) && liveActiveTurnIds.includes(runtimeTurnId);
}

function shouldRecoverStaleActiveTurn(thread, clientState, turn, env = process.env) {
  if (!activeTurnMatchesDeliveredTurn(thread, clientState, turn)) return false;
  if (pendingApprovalState(thread, clientState)) return false;
  const timeoutMs = staleActiveTurnMs(env);
  if (!timeoutMs) return false;
  const lastActivityMs = Number(turn?.lastActivityMs || 0);
  if (!lastActivityMs || Date.now() - lastActivityMs < timeoutMs) return false;
  const observedAt = timestampMs(clientState?.activeTurnObservedAt);
  if (!observedAt || Date.now() - observedAt < timeoutMs) return false;
  return true;
}

function activeTurnRecoveryPending(thread, clientState, turn, env = process.env) {
  return Boolean(
    staleActiveTurnMs(env) &&
    activeTurnMatchesDeliveredTurn(thread, clientState, turn) &&
    !pendingApprovalState(thread, clientState)
  );
}

function activeTurnIdsFromClientState(clientState = {}) {
  const ids = [];
  const add = (value) => {
    const id = clean(value);
    if (id && !ids.includes(id)) ids.push(id);
  };
  add(clientState?.activeTurnId);
  for (const id of Array.isArray(clientState?.activeTurnIds) ? clientState.activeTurnIds : []) add(id);
  return ids;
}

function recoveryScanMessages(messages = [], fullScan = false, env = process.env) {
  if (fullScan) return messages;
  const limit = staleRecoveryMessageScanLimit(env);
  if (limit <= 0 || messages.length <= limit) return messages;
  return messages.slice(-limit);
}

function safeResetBoundaryMs(thread = {}) {
  return Math.max(
    timestampMs(thread?.runtime?.safeReset?.resetAt),
    timestampMs(thread?.executor?.metadata?.lastSafeReset?.resetAt),
  );
}

function recoveryEligibleMessages(thread = {}, messages = []) {
  const codexId = codexThreadId(thread);
  const boundaryMs = safeResetBoundaryMs(thread);
  if (!codexId && !boundaryMs) return messages;
  return (Array.isArray(messages) ? messages : []).filter((message) => {
    const messageCodexId = clean(message?.codexThreadId || message?.executorThreadId);
    if (codexId && messageCodexId && messageCodexId !== codexId) return false;
    if (!boundaryMs) return true;
    if (codexId && messageCodexId === codexId) return true;
    const activityMs = messageActivityMs(message);
    return Boolean(activityMs && activityMs >= boundaryMs);
  });
}

async function threadMessagesFingerprint(threadId, env = process.env) {
  const filePath = path.join(dataPaths(env).threadMessages, `${safeThreadId(threadId)}.json`);
  const stats = await fs.stat(filePath).catch(() => null);
  if (!stats?.isFile()) return "missing";
  return `${stats.size}:${stats.mtimeMs}`;
}

function recoveryScanKey(thread, clientState, messagesFingerprint, options = {}, env = process.env) {
  const runtime = thread?.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  const clientStatus = clientState?.status || null;
  return JSON.stringify({
    home: dataPaths(env).home,
    id: thread?.id || "",
    updatedAt: thread?.updatedAt || "",
    state: thread?.state || "",
    lastError: thread?.lastError || "",
    runtimeState: runtime.state || "",
    runtimeKind: runtime.runtimeKind || thread?.runtimeKind || "",
    activeTurnId: runtime.activeTurnId || "",
    safeResetAt: runtime.safeReset?.resetAt || thread?.executor?.metadata?.lastSafeReset?.resetAt || "",
    pendingRequest: runtime.pendingRequest || null,
    lastTurnStatus: runtime.lastTurnStatus || "",
    codexStatus: runtime.codexStatus || null,
    clientActiveTurnId: clientState?.activeTurnId || "",
    clientStatus,
    messagesFingerprint,
    noticeCause: clean(options.noticeCause || options.cause),
  });
}

function recoveryCacheHit(threadId, scanKey, env = process.env) {
  const ttlMs = staleRecoveryScanCacheMs(env);
  if (ttlMs <= 0) return false;
  const cached = recoveryScanCache.get(threadId);
  return Boolean(cached && cached.scanKey === scanKey && cached.expiresAt > Date.now());
}

function rememberRecoveryNoop(threadId, scanKey, env = process.env) {
  const ttlMs = staleRecoveryScanCacheMs(env);
  if (ttlMs <= 0) return;
  recoveryScanCache.set(threadId, { scanKey, expiresAt: Date.now() + ttlMs });
}

function pruneRecoveryScanCache(activeThreadIds) {
  for (const threadId of recoveryScanCache.keys()) {
    if (!activeThreadIds.has(threadId)) recoveryScanCache.delete(threadId);
  }
}

export async function recoverStaleCodexAppServerTurns(env = process.env, options = {}) {
  const threads = await listThreads(env).catch(() => []);
  const appServerThreads = threads.filter((thread) => threadUsesCodexAppServer(thread, env));
  if (!appServerThreads.length) return { recovered: 0, appended: 0 };
  pruneRecoveryScanCache(new Set(appServerThreads.map((thread) => thread.id).filter(Boolean)));
  const client = await getCodexAppServerClient({ env, home: runtimeHome(env) }).catch(() => null);
  let recovered = 0;
  let appended = 0;
  for (const thread of appServerThreads) {
    const codexId = codexThreadId(thread);
    if (!codexId) continue;
    let clientState = client?.threadStates.has(codexId) ? client.threadStates.get(codexId) : null;
    const messagesFingerprint = await threadMessagesFingerprint(thread.id, env);
    const initialScanKey = recoveryScanKey(thread, clientState, messagesFingerprint, options, env);
    if (recoveryCacheHit(thread.id, initialScanKey, env)) continue;
    const staleRuntimeCandidate = staleAppServerRuntime(thread, clientState);
    const messages = recoveryEligibleMessages(thread, await listThreadMessages(thread.id, env).catch(() => []));
    const scanMessages = recoveryScanMessages(messages, staleRuntimeCandidate, env);
    const incompleteTurn = latestIncompleteDeliveredTurn(scanMessages);
    let staleRuntime = staleRuntimeCandidate;
    let shouldRecoverTurn = shouldRecoverIncompleteTurn(thread, clientState, incompleteTurn, env);
    let shouldRecoverActiveTurn = shouldRecoverStaleActiveTurn(thread, clientState, incompleteTurn, env);
    if ((staleRuntime || shouldRecoverTurn || shouldRecoverActiveTurn || activeTurnRecoveryPending(thread, clientState, incompleteTurn, env)) && client) {
      const liveReadState = await readLiveCodexThreadState(client, codexId);
      if (liveReadState) {
        clientState = liveReadState;
        staleRuntime = staleAppServerRuntime(thread, clientState);
        shouldRecoverTurn = shouldRecoverIncompleteTurn(thread, clientState, incompleteTurn, env);
        shouldRecoverActiveTurn = shouldRecoverStaleActiveTurn(thread, clientState, incompleteTurn, env);
      }
    }
    const liveScanKey = clientState === (client?.threadStates.has(codexId) ? client.threadStates.get(codexId) : null)
      ? initialScanKey
      : recoveryScanKey(thread, clientState, messagesFingerprint, options, env);
    const noticeTurn = shouldRecoverTurn || shouldRecoverActiveTurn || incompleteTurnMatchesRuntimeTurn(thread, incompleteTurn)
      ? incompleteTurn
      : null;
    if (!staleRuntime && !shouldRecoverTurn && !shouldRecoverActiveTurn) {
      if (!activeTurnRecoveryPending(thread, clientState, incompleteTurn, env)) {
        rememberRecoveryNoop(thread.id, liveScanKey, env);
      }
      continue;
    }
    let notice = null;
    let noticeMessages = messages;
    let freshNoticeTurn = noticeTurn;
    if (noticeTurn) {
      noticeMessages = recoveryEligibleMessages(thread, await listThreadMessages(thread.id, env).catch(() => messages));
      freshNoticeTurn = refreshedTurnState(noticeMessages, noticeTurn);
    }
    if (freshNoticeTurn) {
      const noticeOptions = shouldRecoverActiveTurn && !clean(options.noticeCause || options.cause)
        ? { ...options, noticeCause: "active_turn_timeout" }
        : options;
      const result = await appendStaleTurnNotice(thread, noticeMessages, freshNoticeTurn, env, noticeOptions);
      notice = result?.notice || null;
      if (result?.appended) appended += 1;
    }
    const interruptedTurnIds = shouldRecoverActiveTurn ? activeTurnIdsFromClientState(clientState) : [];
    let interruptError = "";
    if (interruptedTurnIds.length && client) {
      for (const interruptedTurnId of interruptedTurnIds) {
        await client.request("turn/interrupt", { threadId: codexId, turnId: interruptedTurnId }).catch((error) => {
          interruptError = [interruptError, publicError(error)].filter(Boolean).join("; ");
          return null;
        });
      }
      client.threadStates.set(codexId, {
        ...(client.threadStates.get(codexId) || clientState || {}),
        activeTurnId: "",
        activeTurnIds: [],
        activeTurnObservedAt: null,
        status: { type: "idle" },
        statusObservedAt: nowIso(),
      });
    }
    await updateThread(thread.id, {
      state: "ready",
      lastError: null,
      runtime: {
        ...(thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "ready",
        activeTurnId: null,
        pendingRequest: null,
        codexStatus: shouldRecoverActiveTurn ? { type: "idle" } : clientState?.status || { type: "idle" },
        recoveredAt: nowIso(),
      },
    }, env).catch(() => null);
    recovered += 1;
    await appendEvent({
      type: "codex_app_server_stale_turn_recovered",
      threadId: thread.id,
      codexThreadId: codexId,
      noticeMessageId: notice?.id || null,
      latestUserMessageId: freshNoticeTurn?.latestUser?.id || noticeTurn?.latestUser?.id || null,
      reason: shouldRecoverActiveTurn ? "active_turn_timeout" : freshNoticeTurn?.reason || noticeTurn?.reason || (staleRuntime ? "stale_runtime" : "incomplete_turn"),
      interruptedTurnId: interruptedTurnIds[0] || null,
      interruptedTurnIds,
      interruptError: interruptError || null,
      noticeCause: shouldRecoverActiveTurn && !clean(options.noticeCause || options.cause)
        ? "active_turn_timeout"
        : clean(options.noticeCause || options.cause),
    }, env).catch(() => {});
    recoveryScanCache.delete(thread.id);
  }
  return { recovered, appended };
}
