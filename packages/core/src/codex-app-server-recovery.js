import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent } from "../../storage/src/store.js";
import { enqueueThreadInput, getThread, listThreadMessages, listThreads, updateThread } from "./threads.js";
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
import {
  activeTurnIdsFromClientState,
  activeTurnRecoveryPending,
  shouldSteerStaleActiveTurn,
  shouldRecoverStaleActiveTurn,
} from "./codex-app-server-active-turn-recovery.js";

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

function staleRecoveryPendingApproval(thread = {}, clientState = null) {
  const liveStatusState = appServerStateFromStatus(clientState?.status || null);
  const threadState = clean(thread?.state).toLowerCase();
  const runtimeState = clean(thread?.runtime?.state).toLowerCase();
  return liveStatusState === "awaiting_approval" ||
    threadState === "awaiting_approval" ||
    runtimeState === "awaiting_approval" ||
    Boolean(thread?.runtime?.pendingRequest);
}

function staleFinalGraceMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CODEX_APP_SERVER_STALE_FINAL_GRACE_MS || 120000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 120000;
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

function staleRecoveryAutoSafeResetEnabled(env = process.env) {
  const raw = clean(env.ORKESTR_CODEX_APP_SERVER_AUTO_SAFE_RESET_ON_REPEAT_STALE_TURN ?? "1").toLowerCase();
  return !["0", "off", "false", "disabled", "no"].includes(raw);
}

function staleRecoveryAutoSafeResetCooldownMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CODEX_APP_SERVER_AUTO_SAFE_RESET_COOLDOWN_MS || 5 * 60 * 1000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 5 * 60 * 1000;
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

function priorRuntimeRecoveryNotice(messages = [], currentTurn = null) {
  const latestUserId = clean(currentTurn?.latestUser?.id);
  return (Array.isArray(messages) ? messages : []).some((message) => {
    if (!runtimeRecoveryMessage(message)) return false;
    if (latestUserId && clean(message?.parentMessageId) === latestUserId) return false;
    return true;
  });
}

function staleTurnRecoveryStreak(thread = {}) {
  const value = Number(thread?.runtime?.staleTurnRecoveryStreak || 0);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function staleRecoveryContinuationTurn(turn = null) {
  const message = turn?.latestUser || {};
  return message.recoveryContinuation === true ||
    Boolean(clean(message.replayedFromMessageId)) ||
    Boolean(clean(message.previousRecoveryNoticeId)) ||
    Boolean(clean(message.previousCodexThreadId));
}

function durableStaleRecoveryRepeated(thread = {}, turn = null) {
  return staleTurnRecoveryStreak(thread) > 0 && staleRecoveryContinuationTurn(turn);
}

function autoSafeResetCooldownActive(thread = {}, env = process.env) {
  const cooldownMs = staleRecoveryAutoSafeResetCooldownMs(env);
  if (cooldownMs <= 0) return false;
  const runtime = thread?.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  const metadata = thread?.executor?.metadata && typeof thread.executor.metadata === "object" ? thread.executor.metadata : {};
  const lastResetMs = Math.max(
    timestampMs(runtime.autoSafeReset?.resetAt),
    timestampMs(metadata.lastAutoSafeReset?.resetAt),
    timestampMs(runtime.safeReset?.resetAt),
    timestampMs(metadata.lastSafeReset?.resetAt),
  );
  return Boolean(lastResetMs && Date.now() - lastResetMs < cooldownMs);
}

function shouldAutoSafeResetRepeatedStaleTurn(thread = {}, messages = [], turn = null, options = {}, env = process.env) {
  if (!turn) return false;
  if (typeof options.autoSafeResetThread !== "function") return false;
  if (!staleRecoveryAutoSafeResetEnabled(env)) return false;
  if (autoSafeResetCooldownActive(thread, env)) return false;
  return priorRuntimeRecoveryNotice(messages, turn) || durableStaleRecoveryRepeated(thread, turn);
}

function latestDeliveredTerminalTurn(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const latestUser = messages[index];
    if (!deliveredUserMessage(latestUser)) continue;
    const terminal = assistantMessagesForDeliveredTurn(messages, latestUser, index)
      .find((message) => terminalAssistantMessage(message) && !runtimeRecoveryMessage(message));
    if (terminal) return { latestUser, terminal };
    return null;
  }
  return null;
}

function staleRecoveryClearPatch(thread = {}, messages = []) {
  if (staleTurnRecoveryStreak(thread) <= 0) return null;
  const completed = latestDeliveredTerminalTurn(messages);
  if (!completed?.terminal) return null;
  const terminalId = clean(completed.terminal.id);
  return {
    staleTurnRecoveryStreak: 0,
    lastSuccessfulTerminalAnswerAt: nowIso(),
    lastSuccessfulTerminalAnswerMessageId: terminalId || null,
    lastSuccessfulTerminalAnswerUserMessageId: clean(completed.latestUser?.id) || null,
    lastSuccessfulTerminalAnswerCodexThreadId: clean(completed.terminal?.codexThreadId || completed.latestUser?.codexThreadId) || null,
  };
}

function staleRecoveryReason(thread = {}, turn = null, shouldRecoverActiveTurn = false, staleRuntime = false) {
  if (shouldRecoverActiveTurn) return "active_turn_timeout";
  return turn?.reason || (staleRuntime ? "stale_runtime" : "incomplete_turn");
}

function staleRecoveryRuntimePatch(thread = {}, options = {}) {
  const turn = options.turn || null;
  const notice = options.notice || null;
  const codexId = clean(options.codexId || codexThreadId(thread));
  const recoveredAt = clean(options.recoveredAt) || nowIso();
  return {
    staleTurnRecoveryStreak: staleTurnRecoveryStreak(thread) + 1,
    lastStaleTurnRecoveryAt: recoveredAt,
    lastStaleTurnRecoveryNoticeId: clean(notice?.id) || null,
    lastStaleTurnRecoveryCodexThreadId: codexId || null,
    lastStaleTurnRecoveryLatestUserMessageId: clean(turn?.latestUser?.id) || null,
    lastStaleTurnRecoveryReason: clean(options.reason) || null,
    lastStaleTurnRecoveryAutoSafeResetAttempted: Boolean(options.autoSafeResetAttempted),
  };
}

async function persistStaleRecoveryRuntimePatch(threadId, runtimePatch = null, resetResult = null, env = process.env, extra = {}) {
  if (!threadId || !runtimePatch || typeof runtimePatch !== "object") return null;
  const refreshed = resetResult?.thread || await getThread(threadId, env).catch(() => null);
  const updated = await updateThread(threadId, {
    runtime: {
      ...(refreshed?.runtime || {}),
      ...runtimePatch,
      ...extra,
    },
  }, env).catch(() => null);
  if (updated && resetResult && typeof resetResult === "object") resetResult.thread = updated;
  return updated;
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
  const doctorLines = Array.isArray(options.doctorLines)
    ? options.doctorLines.map((line) => clean(line)).filter(Boolean)
    : [];
  const withDoctor = (lines) => [...lines, ...doctorLines].join("\n");
  if (noticeCause === "active_turn_timeout") {
    if (reason === "no_final_answer") {
      return withDoctor([
        "Codex response timed out",
        "",
        "Orkestr found progress updates for this turn, but Codex stayed active too long without a final answer.",
        "Send the next instruction normally to continue.",
        "If this repeats, reply /safe-reset to save recent Orkestr context and start a fresh Codex session for this thread.",
      ]);
    }
    return withDoctor([
      "Codex response timed out",
      "",
      "Orkestr delivered this message to Codex, but Codex stayed active too long without producing a visible response.",
      "Send the next instruction normally to continue.",
      "If this repeats, reply /safe-reset to save recent Orkestr context and start a fresh Codex session for this thread.",
    ]);
  }
  if (noticeCause === "orkestr_restart") {
    if (reason === "no_final_answer") {
      return withDoctor([
        "Orkestr restarted before Codex finished",
        "",
        "Orkestr restarted while Codex was working on this turn. Progress updates before the restart were preserved, but no final answer was recorded.",
        "Send the next instruction normally to continue.",
      ]);
    }
    return withDoctor([
      "Orkestr restarted before Codex replied",
      "",
      "Orkestr restarted after this message reached Codex, before an assistant response was recorded.",
      "Send the next instruction normally to continue.",
    ]);
  }
  if (noticeCause === "host_reboot") {
    if (reason === "no_final_answer") {
      return withDoctor([
        "Host rebooted before Codex finished",
        "",
        "The machine restarted while Codex was working on this turn. Orkestr preserved recent progress and is recovering the thread state.",
        "Send the next instruction normally to continue.",
      ]);
    }
    return withDoctor([
      "Host rebooted before Codex replied",
      "",
      "The machine restarted after this message reached Codex, before a visible assistant response was recorded.",
      "Send the next instruction normally to continue.",
    ]);
  }
  if (reason === "no_final_answer") {
    return withDoctor([
      "Codex stopped before final answer",
      "",
      "Orkestr found progress updates for this turn, but Codex went idle before a final answer was recorded.",
      "Send the next instruction normally to continue.",
      "If this repeats, reply /safe-reset to save recent Orkestr context and start a fresh Codex session for this thread.",
    ]);
  }
  return withDoctor([
    "Codex response missing",
    "",
    "Orkestr found a delivered message with no assistant response after the Codex runtime stopped, restarted, or lost the active turn.",
    "Send the next instruction normally to continue.",
    "If this repeats, reply /safe-reset to save recent Orkestr context and start a fresh Codex session for this thread.",
  ]);
}

function recoveryNoticeCause(options = {}, activeTurnRecovery = false) {
  const explicit = clean(options.noticeCause || options.cause);
  if (explicit) return explicit;
  return activeTurnRecovery ? "active_turn_timeout" : "";
}

function staleTurnEventId(thread, codexId, turn, options = {}) {
  const message = turn?.latestUser || {};
  const reason = clean(turn?.reason || "no_assistant_response");
  const stableTextOptions = { ...options, doctorLines: [] };
  return threadEventId({
    codexThreadId: codexId,
    turnId: clean(message?.codexTurnId || message?.executorTurnId || thread?.runtime?.activeTurnId || "stale-turn"),
    itemId: `stale-${reason}:${message?.id || "latest"}`,
    type: `turn/stale-${reason}`,
    role: "assistant",
    text: staleTurnNoticeText(reason, stableTextOptions),
  });
}

function safeResetSucceeded(result = null) {
  return Boolean(result?.ok || result?.safeReset || result?.reset);
}

function safeResetRecoveryText() {
  return [
    "Codex session recovered",
    "",
    "Orkestr saved recent context and started a fresh Codex session for this thread.",
    "Send the next instruction normally to continue.",
  ].join("\n");
}

function safeResetRecoveryEventId(thread, codexId, turn, resetResult = {}) {
  const latestUser = turn?.latestUser || {};
  return threadEventId({
    codexThreadId: resetResult?.newCodexThreadId || codexId,
    turnId: clean(latestUser?.codexTurnId || latestUser?.executorTurnId || thread?.runtime?.activeTurnId || "safe-reset"),
    itemId: `safe-reset-recovered:${latestUser?.id || "latest"}`,
    type: "turn/safe-reset-recovered",
    role: "assistant",
    text: safeResetRecoveryText(),
  });
}

async function appendSafeResetRecoveryNotice(thread, codexId, turn, resetResult = {}, env = process.env) {
  if (!safeResetSucceeded(resetResult)) return null;
  const refreshedThread = resetResult?.thread || thread;
  const latestUser = turn?.latestUser || null;
  const whatsappParent = noticeWhatsappParent(turn, refreshedThread);
  return appendOrUpdateEventMessage(refreshedThread, {
    role: "assistant",
    source: "orkestr_runtime",
    phase: "runtime_recovered",
    text: safeResetRecoveryText(),
    state: "completed",
    eventId: safeResetRecoveryEventId(refreshedThread, codexId, turn, resetResult),
    parentMessageId: latestUser?.id || null,
    codexThreadId: resetResult?.newCodexThreadId || codexThreadId(refreshedThread) || codexId,
    codexTurnId: clean(latestUser?.codexTurnId || latestUser?.executorTurnId || thread?.runtime?.activeTurnId) || null,
    ...codexAppServerMessageFields(resetResult?.newCodexThreadId || codexThreadId(refreshedThread) || codexId, {
      turnId: clean(latestUser?.codexTurnId || latestUser?.executorTurnId || thread?.runtime?.activeTurnId),
      itemId: "safe-reset-recovered",
    }),
    ...whatsappProjectionFields(whatsappParent, refreshedThread),
  }, env);
}

function safeResetContinuationEventId(thread, codexId, turn, resetResult = {}) {
  const latestUser = turn?.latestUser || {};
  return threadEventId({
    codexThreadId: resetResult?.newCodexThreadId || codexThreadId(resetResult?.thread || thread) || codexId,
    turnId: "safe-reset-continuation",
    itemId: `safe-reset-continue:${latestUser?.id || "latest"}`,
    type: "turn/safe-reset-continue",
    role: "user",
    text: clean(latestUser?.text || latestUser?.promptFile || ""),
  });
}

async function enqueueSafeResetContinuationInput(thread, codexId, turn, resetResult = {}, env = process.env, options = {}) {
  if (!safeResetSucceeded(resetResult)) return null;
  const latestUser = turn?.latestUser || null;
  const text = clean(latestUser?.text);
  const promptFile = clean(latestUser?.promptFile);
  if (!latestUser || (!text && !promptFile)) return null;
  const refreshedThread = resetResult?.thread || thread;
  const newCodexThreadId = resetResult?.newCodexThreadId || codexThreadId(refreshedThread) || codexId;
  const whatsappParent = noticeWhatsappParent(turn, refreshedThread);
  return enqueueThreadInput(refreshedThread.id || thread.id, {
    role: "user",
    source: clean(latestUser.source) || "manual",
    connector: clean(latestUser.connector),
    chatId: clean(latestUser.chatId),
    from: clean(latestUser.from),
    accountId: clean(latestUser.accountId),
    originSurface: clean(latestUser.originSurface),
    originTransport: clean(latestUser.originTransport),
    ownerUserId: clean(latestUser.ownerUserId || refreshedThread?.ownerUserId),
    text,
    promptFile,
    attachments: Array.isArray(latestUser.attachments) ? latestUser.attachments : [],
    parentMessageId: latestUser.id || null,
    visibility: "internal",
    eventId: safeResetContinuationEventId(refreshedThread, codexId, turn, resetResult),
    codexThreadId: newCodexThreadId,
    executorThreadId: newCodexThreadId,
    recoveryContinuation: true,
    replayedFromMessageId: latestUser.id || null,
    previousCodexThreadId: codexId || null,
    previousRecoveryNoticeId: clean(options.previousRecoveryNoticeId) || null,
    ...whatsappProjectionFields(whatsappParent, refreshedThread),
  }, env);
}

function noticeWhatsappParent(turn, thread = null) {
  if (turn?.latestUser && whatsappOrigin(turn.latestUser)) return turn.latestUser;
  if (turn?.latestAssistant && whatsappOrigin(turn.latestAssistant)) return turn.latestAssistant;
  return threadWhatsAppBindingParent(thread);
}

function activeTurnInterruptPlan(thread = {}, clientState = {}, turn = null) {
  const candidateIds = activeTurnIdsFromClientState(clientState);
  if (!candidateIds.length) return { interruptTurnIds: [], skippedTurnIds: [], targetTurnId: "" };
  const targetTurnId = clean(
    messageTurnId(turn?.latestUser) ||
    thread?.runtime?.activeTurnId ||
    clientState?.activeTurnId,
  );
  const interruptTurnIds = targetTurnId
    ? candidateIds.filter((id) => id === targetTurnId)
    : [candidateIds[0]];
  const selected = new Set(interruptTurnIds);
  return {
    interruptTurnIds,
    skippedTurnIds: candidateIds.filter((id) => !selected.has(id)),
    targetTurnId,
  };
}

function activeTurnSteerText(env = process.env) {
  return clean(env.ORKESTR_CODEX_APP_SERVER_ACTIVE_TURN_STEER_TEXT) ||
    "Orkestr recovery check: please send a brief visible progress update now. Say what you have completed, what you are doing next, and whether you are waiting on a tool or external service. Do not stop the task unless you are blocked.";
}

function activeTurnSteerPlan(thread = {}, clientState = {}, turn = null) {
  const turnId = clean(
    messageTurnId(turn?.latestUser) ||
    thread?.runtime?.activeTurnId ||
    clientState?.activeTurnId,
  );
  const codexId = codexThreadId(thread);
  return {
    codexThreadId: codexId,
    turnId,
    canSteer: Boolean(codexId && turnId),
  };
}

async function steerStaleActiveTurn(thread = {}, clientState = {}, turn = null, client = null, env = process.env) {
  const plan = activeTurnSteerPlan(thread, clientState, turn);
  const steeredAt = nowIso();
  if (!plan.canSteer || !client) return { steered: false, turnId: plan.turnId || "", error: "steer_unavailable" };
  let error = "";
  try {
    await client.request("turn/steer", {
      threadId: plan.codexThreadId,
      expectedTurnId: plan.turnId,
      input: [{ type: "text", text: activeTurnSteerText(env) }],
    });
  } catch (caught) {
    error = publicError(caught);
  }
  await updateThread(thread.id, {
    runtime: {
      ...(thread.runtime || {}),
      runtimeKind: "codex-app-server",
      activeTurnSteer: {
        turnId: plan.turnId,
        steeredAt,
        ok: !error,
        error: error || null,
      },
    },
  }, env).catch(() => null);
  await appendEvent({
    type: error ? "codex_app_server_active_turn_steer_failed" : "codex_app_server_active_turn_steered",
    threadId: thread.id,
    codexThreadId: plan.codexThreadId,
    turnId: plan.turnId,
    error: error || null,
  }, env).catch(() => {});
  return { steered: !error, turnId: plan.turnId, error };
}

function activeTurnDoctorLines({ reason = "", interruptTurnIds = [], skippedTurnIds = [] } = {}) {
  if (reason !== "active_turn_timeout") return [];
  const targetCount = interruptTurnIds.length;
  const skippedCount = skippedTurnIds.length;
  const lines = [
    "",
    `Doctor: no final answer found, no approval pending, stale active Codex turn${targetCount === 1 ? "" : "s"} selected for recovery.`,
  ];
  if (skippedCount) {
    lines.push(`Doctor: ignored ${skippedCount} stale cached active turn id${skippedCount === 1 ? "" : "s"} instead of interrupting historical turns.`);
  }
  lines.push("Doctor action: interrupting the current stale turn, marking the thread ready, and safe-resetting only if stale turns repeat.");
  return lines;
}

async function appendStaleTurnNotice(thread, messages, turn, env = process.env, options = {}) {
  const codexId = codexThreadId(thread);
  const freshMessages = recoveryEligibleMessages(
    thread,
    await listThreadMessages(thread.id, env).catch(() => messages),
  );
  const freshTurn = refreshedTurnState(freshMessages, turn);
  if (!freshTurn) return { notice: null, appended: false, skipped: true, messages: freshMessages, turn: null };
  const latestUser = freshTurn?.latestUser || null;
  const noticeCause = recoveryNoticeCause(options);
  const recoverySource = clean(options.recoverySource || "");
  const text = staleTurnNoticeText(freshTurn?.reason, options);
  const eventId = staleTurnEventId(thread, codexId, freshTurn, options);
  const existing = freshMessages.find((message) => message.eventId === eventId);
  const whatsappParent = noticeWhatsappParent(freshTurn, thread);
  const notice = await appendOrUpdateEventMessage(thread, {
    role: "assistant",
    source: "orkestr_runtime",
    phase: "runtime_interrupted",
    text,
    state: "completed",
    eventId,
    noticeCause: noticeCause || null,
    recoverySource: recoverySource || null,
    recoveryReason: freshTurn?.reason || null,
    codexThreadId: codexId,
    codexTurnId: clean(latestUser?.codexTurnId || latestUser?.executorTurnId || thread?.runtime?.activeTurnId) || null,
    ...codexAppServerMessageFields(codexId, {
      turnId: clean(latestUser?.codexTurnId || latestUser?.executorTurnId || thread?.runtime?.activeTurnId),
      itemId: "stale-no-reply",
    }),
    ...whatsappProjectionFields(whatsappParent, thread),
  }, env);
  return { notice, appended: !existing && Boolean(notice?.id), skipped: false, messages: freshMessages, turn: freshTurn };
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

function staleRuntimeNoticeDue(thread, turn, env = process.env) {
  if (!incompleteTurnMatchesRuntimeTurn(thread, turn)) return false;
  if (!turn?.lastActivityMs) return true;
  return Date.now() - turn.lastActivityMs >= staleFinalGraceMs(env);
}

async function syncCodexHistoryBeforeRecoveryNotice(thread = {}, env = process.env) {
  const codexId = codexThreadId(thread);
  if (!codexId) return null;
  try {
    const { syncCodexAppServerThreadMessages } = await import("./codex-app-server.js");
    if (typeof syncCodexAppServerThreadMessages !== "function") return null;
    return await syncCodexAppServerThreadMessages(thread, env, { force: true, recovery: true });
  } catch (error) {
    await appendEvent({
      type: "codex_app_server_recovery_history_sync_failed",
      threadId: thread.id || null,
      codexThreadId: codexId,
      error: publicError(error),
    }, env).catch(() => {});
    return null;
  }
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
    staleTurnRecoveryStreak: runtime.staleTurnRecoveryStreak || 0,
    lastStaleTurnRecoveryAt: runtime.lastStaleTurnRecoveryAt || "",
    lastSuccessfulTerminalAnswerAt: runtime.lastSuccessfulTerminalAnswerAt || "",
    safeResetAt: runtime.safeReset?.resetAt || thread?.executor?.metadata?.lastSafeReset?.resetAt || "",
    pendingRequest: runtime.pendingRequest || null,
    lastTurnStatus: runtime.lastTurnStatus || "",
    codexStatus: runtime.codexStatus || null,
    autoSafeResetAvailable: typeof options.autoSafeResetThread === "function",
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
  if (!appServerThreads.length) return { recovered: 0, appended: 0, autoSafeReset: 0 };
  pruneRecoveryScanCache(new Set(appServerThreads.map((thread) => thread.id).filter(Boolean)));
  const client = await getCodexAppServerClient({ env, home: runtimeHome(env) }).catch(() => null);
  let recovered = 0;
  let appended = 0;
  let autoSafeReset = 0;
  let continued = 0;
  for (let thread of appServerThreads) {
    const codexId = codexThreadId(thread);
    if (!codexId) continue;
    let clientState = client?.threadStates.has(codexId) ? client.threadStates.get(codexId) : null;
    const messagesFingerprint = await threadMessagesFingerprint(thread.id, env);
    const initialScanKey = recoveryScanKey(thread, clientState, messagesFingerprint, options, env);
    if (recoveryCacheHit(thread.id, initialScanKey, env)) continue;
    const staleRuntimeCandidate = staleAppServerRuntime(thread, clientState);
    const messages = recoveryEligibleMessages(thread, await listThreadMessages(thread.id, env).catch(() => []));
    const clearPatch = staleRecoveryClearPatch(thread, messages);
    if (clearPatch) {
      const updated = await updateThread(thread.id, {
        runtime: {
          ...(thread.runtime || {}),
          ...clearPatch,
        },
      }, env).catch(() => null);
      if (updated) thread = updated;
    }
    const scanMessages = recoveryScanMessages(messages, staleRuntimeCandidate, env);
    const incompleteTurn = latestIncompleteDeliveredTurn(scanMessages);
    let staleRuntime = staleRuntimeCandidate;
    let recoveryBlockedByPendingApproval = staleRecoveryPendingApproval(thread, clientState);
    let shouldRecoverTurn = recoveryBlockedByPendingApproval ? false : shouldRecoverIncompleteTurn(thread, clientState, incompleteTurn, env);
    let shouldSteerActiveTurn = shouldSteerStaleActiveTurn(thread, clientState, incompleteTurn, env);
    let shouldRecoverActiveTurn = shouldRecoverStaleActiveTurn(thread, clientState, incompleteTurn, env);
    if ((staleRuntime || shouldRecoverTurn || shouldSteerActiveTurn || shouldRecoverActiveTurn || activeTurnRecoveryPending(thread, clientState, incompleteTurn, env)) && client) {
      const liveReadState = await readLiveCodexThreadState(client, codexId);
      if (liveReadState) {
        clientState = liveReadState;
        staleRuntime = staleAppServerRuntime(thread, clientState);
        recoveryBlockedByPendingApproval = staleRecoveryPendingApproval(thread, clientState);
        shouldRecoverTurn = recoveryBlockedByPendingApproval ? false : shouldRecoverIncompleteTurn(thread, clientState, incompleteTurn, env);
        shouldSteerActiveTurn = shouldSteerStaleActiveTurn(thread, clientState, incompleteTurn, env);
        shouldRecoverActiveTurn = shouldRecoverStaleActiveTurn(thread, clientState, incompleteTurn, env);
      }
    }
    if (recoveryBlockedByPendingApproval) continue;
    const liveScanKey = clientState === (client?.threadStates.has(codexId) ? client.threadStates.get(codexId) : null)
      ? initialScanKey
      : recoveryScanKey(thread, clientState, messagesFingerprint, options, env);
    const shouldRecoverRuntimeTurn = staleRuntime && staleRuntimeNoticeDue(thread, incompleteTurn, env);
    const noticeTurn = shouldRecoverTurn || shouldRecoverActiveTurn || shouldRecoverRuntimeTurn
      ? incompleteTurn
      : null;
    if (shouldSteerActiveTurn && !shouldRecoverActiveTurn && !shouldRecoverTurn && !shouldRecoverRuntimeTurn) {
      await steerStaleActiveTurn(thread, clientState, incompleteTurn, client, env);
      recoveryScanCache.delete(thread.id);
      continue;
    }
    if (!staleRuntime && !shouldRecoverTurn && !shouldRecoverActiveTurn) {
      if (!activeTurnRecoveryPending(thread, clientState, incompleteTurn, env)) {
        rememberRecoveryNoop(thread.id, liveScanKey, env);
      }
      continue;
    }
    const preNoticeInterruptPlan = shouldRecoverActiveTurn
      ? activeTurnInterruptPlan(thread, clientState, noticeTurn)
      : { interruptTurnIds: [], skippedTurnIds: [], targetTurnId: "" };
    let notice = null;
    let noticeMessages = messages;
    let freshNoticeTurn = noticeTurn;
    if (noticeTurn) {
      const syncResult = await syncCodexHistoryBeforeRecoveryNotice(thread, env);
      noticeMessages = recoveryEligibleMessages(thread, await listThreadMessages(thread.id, env).catch(() => messages));
      freshNoticeTurn = refreshedTurnState(noticeMessages, noticeTurn);
      if (!freshNoticeTurn && syncResult?.synced) {
        await appendEvent({
          type: "codex_app_server_recovery_history_sync_resolved",
          threadId: thread.id,
          codexThreadId: codexId,
          latestUserMessageId: noticeTurn?.latestUser?.id || null,
          count: syncResult.count || 0,
          created: syncResult.created || 0,
          updated: syncResult.updated || 0,
          completedTurnId: syncResult.completedTurnId || null,
        }, env).catch(() => {});
        recovered += 1;
        recoveryScanCache.delete(thread.id);
        continue;
      }
    }
    if (freshNoticeTurn) {
      const noticeCause = recoveryNoticeCause(options, shouldRecoverActiveTurn);
      const repeatAfterSafeResetLines = durableStaleRecoveryRepeated(thread, freshNoticeTurn)
        ? [
            "",
            "Doctor: this replay followed an earlier stale-turn recovery, so Orkestr is escalating across the fresh Codex session.",
          ]
        : [];
      const noticeOptions = noticeCause === "active_turn_timeout"
        ? {
            ...options,
            noticeCause,
            doctorLines: activeTurnDoctorLines({
              reason: "active_turn_timeout",
              interruptTurnIds: preNoticeInterruptPlan.interruptTurnIds,
              skippedTurnIds: preNoticeInterruptPlan.skippedTurnIds,
            }).concat(repeatAfterSafeResetLines),
          }
        : repeatAfterSafeResetLines.length
          ? { ...options, doctorLines: [...(Array.isArray(options.doctorLines) ? options.doctorLines : []), ...repeatAfterSafeResetLines] }
          : options;
      const result = await appendStaleTurnNotice(thread, noticeMessages, freshNoticeTurn, env, noticeOptions);
      notice = result?.notice || null;
      noticeMessages = result?.messages || noticeMessages;
      freshNoticeTurn = result?.turn || (result?.skipped ? null : freshNoticeTurn);
      if (result?.appended) appended += 1;
    }
    const interruptPlan = shouldRecoverActiveTurn
      ? activeTurnInterruptPlan(thread, clientState, freshNoticeTurn || noticeTurn)
      : { interruptTurnIds: [], skippedTurnIds: [], targetTurnId: "" };
    const interruptedTurnIds = interruptPlan.interruptTurnIds;
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
    const autoSafeResetAttempted = shouldAutoSafeResetRepeatedStaleTurn(thread, noticeMessages, freshNoticeTurn, options, env);
    const recoveryTurn = freshNoticeTurn || noticeTurn;
    const recoveryReason = staleRecoveryReason(thread, recoveryTurn, shouldRecoverActiveTurn, staleRuntime);
    const recoveredAt = nowIso();
    const recoveryRuntimePatch = recoveryTurn
      ? staleRecoveryRuntimePatch(thread, {
          turn: recoveryTurn,
          notice,
          codexId,
          reason: recoveryReason,
          recoveredAt,
          autoSafeResetAttempted,
        })
      : null;
    const recoveredThread = await updateThread(thread.id, {
      state: "ready",
      lastError: null,
      runtime: {
        ...(thread.runtime || {}),
        runtimeKind: "codex-app-server",
        state: "ready",
        activeTurnId: null,
        pendingRequest: null,
        codexStatus: shouldRecoverActiveTurn ? { type: "idle" } : clientState?.status || { type: "idle" },
        recoveredAt,
        ...(recoveryRuntimePatch || {}),
      },
    }, env).catch(() => null);
    if (recoveredThread) thread = recoveredThread;
    recovered += 1;
    let autoSafeResetResult = null;
    let autoSafeResetError = "";
    if (autoSafeResetAttempted) {
      const resetReason = shouldRecoverActiveTurn
        ? "stale_active_turn_auto_safe_reset"
        : "stale_turn_auto_safe_reset";
      try {
        autoSafeResetResult = await options.autoSafeResetThread(thread.id, {
          reason: resetReason,
          threadId: thread.id,
          codexThreadId: codexId,
          noticeMessageId: notice?.id || null,
          latestUserMessageId: freshNoticeTurn?.latestUser?.id || noticeTurn?.latestUser?.id || null,
          noticeCause: recoveryNoticeCause(options, shouldRecoverActiveTurn) || null,
          recoverySource: clean(options.recoverySource || "") || null,
          recoveryReason,
        });
        if (safeResetSucceeded(autoSafeResetResult)) {
          autoSafeReset += 1;
          await persistStaleRecoveryRuntimePatch(thread.id, recoveryRuntimePatch, autoSafeResetResult, env, {
            lastStaleTurnRecoveryAutoSafeReset: true,
            lastStaleTurnRecoveryAutoSafeResetAt: nowIso(),
            lastStaleTurnRecoveryAutoSafeResetOldCodexThreadId: autoSafeResetResult?.oldCodexThreadId || codexId || null,
            lastStaleTurnRecoveryAutoSafeResetNewCodexThreadId: autoSafeResetResult?.newCodexThreadId || null,
          });
          const continuation = await enqueueSafeResetContinuationInput(thread, codexId, freshNoticeTurn || noticeTurn, autoSafeResetResult, env, {
            previousRecoveryNoticeId: notice?.id || null,
          }).catch(() => null);
          if (continuation?.id) {
            continued += 1;
            if (typeof options.continueThreadInput === "function") {
              await options.continueThreadInput(thread.id, {
                reason: resetReason,
                threadId: thread.id,
                codexThreadId: autoSafeResetResult?.newCodexThreadId || null,
                messageId: continuation.id,
                replayedFromMessageId: freshNoticeTurn?.latestUser?.id || noticeTurn?.latestUser?.id || null,
                previousCodexThreadId: codexId || null,
                previousRecoveryNoticeId: notice?.id || null,
              }).catch(() => null);
            }
          } else {
            await appendSafeResetRecoveryNotice(thread, codexId, freshNoticeTurn || noticeTurn, autoSafeResetResult, env).catch(() => null);
          }
        }
        await appendEvent({
          type: "codex_app_server_auto_safe_reset",
          threadId: thread.id,
          codexThreadId: codexId,
          noticeMessageId: notice?.id || null,
          latestUserMessageId: freshNoticeTurn?.latestUser?.id || noticeTurn?.latestUser?.id || null,
          reason: resetReason,
          oldCodexThreadId: autoSafeResetResult?.oldCodexThreadId || codexId || null,
          newCodexThreadId: autoSafeResetResult?.newCodexThreadId || null,
          manualCheckpointPath: autoSafeResetResult?.manualCheckpoint?.path || null,
          noticeCause: recoveryNoticeCause(options, shouldRecoverActiveTurn) || null,
          recoverySource: clean(options.recoverySource || "") || null,
        }, env).catch(() => {});
      } catch (error) {
        autoSafeResetError = publicError(error);
        await appendEvent({
          type: "codex_app_server_auto_safe_reset_failed",
          threadId: thread.id,
          codexThreadId: codexId,
          noticeMessageId: notice?.id || null,
          latestUserMessageId: freshNoticeTurn?.latestUser?.id || noticeTurn?.latestUser?.id || null,
          reason: resetReason,
          error: autoSafeResetError,
        }, env).catch(() => {});
      }
    }
    await appendEvent({
      type: "codex_app_server_stale_turn_recovered",
      threadId: thread.id,
      codexThreadId: codexId,
      noticeMessageId: notice?.id || null,
      latestUserMessageId: freshNoticeTurn?.latestUser?.id || noticeTurn?.latestUser?.id || null,
      reason: recoveryReason,
      interruptedTurnId: interruptedTurnIds[0] || null,
      interruptedTurnIds,
      skippedCachedActiveTurnIds: interruptPlan.skippedTurnIds,
      activeTurnRecoveryTargetId: interruptPlan.targetTurnId || null,
      interruptError: interruptError || null,
      noticeCause: recoveryNoticeCause(options, shouldRecoverActiveTurn),
      recoverySource: clean(options.recoverySource || ""),
      recoveryContinuation: staleRecoveryContinuationTurn(freshNoticeTurn || noticeTurn),
      staleTurnRecoveryStreak: recoveryRuntimePatch?.staleTurnRecoveryStreak || staleTurnRecoveryStreak(thread),
      autoSafeResetAttempted,
      autoSafeReset: Boolean(autoSafeResetResult?.ok || autoSafeResetResult?.safeReset || autoSafeResetResult?.reset),
      autoSafeResetError: autoSafeResetError || null,
      autoSafeResetOldCodexThreadId: autoSafeResetResult?.oldCodexThreadId || null,
      autoSafeResetNewCodexThreadId: autoSafeResetResult?.newCodexThreadId || null,
    }, env).catch(() => {});
    recoveryScanCache.delete(thread.id);
  }
  return { recovered, appended, autoSafeReset, continued };
}
