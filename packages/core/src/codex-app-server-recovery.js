import { appendEvent } from "../../storage/src/store.js";
import { listThreadMessages, listThreads, updateThread } from "./threads.js";
import { getCodexAppServerClient } from "./codex-app-server-client.js";
import {
  appendOrUpdateEventMessage,
  appServerStateFromStatus,
  clean,
  codexThreadId,
  nowIso,
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

function staleRecoveryLookbackMs(env = process.env) {
  const fallback = 24 * 60 * 60 * 1000;
  const parsed = Number(env.ORKESTR_CODEX_APP_SERVER_STALE_RECOVERY_LOOKBACK_MS || fallback);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
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

function deliveredTurnState(messages = [], latestUser = {}, latestUserIndex = -1) {
  const assistants = assistantMessagesForDeliveredTurn(messages, latestUser, latestUserIndex);
  if (assistants.some((message) => terminalAssistantMessage(message))) return null;
  const latestAssistant = latestByStorageOrder(assistants);
  return {
    latestUser,
    latestAssistant,
    reason: latestAssistant ? "no_final_answer" : "no_assistant_response",
    lastActivityMs: Math.max(messageActivityMs(latestAssistant), messageActivityMs(latestUser)),
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
    ].join("\n");
  }
  return [
    "Codex response missing",
    "",
    "Orkestr found a delivered message with no assistant response after the Codex runtime stopped, restarted, or lost the active turn.",
    "Send the next instruction normally to continue.",
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

export async function recoverStaleCodexAppServerTurns(env = process.env, options = {}) {
  const threads = await listThreads(env).catch(() => []);
  const appServerThreads = threads.filter((thread) => threadUsesCodexAppServer(thread, env));
  if (!appServerThreads.length) return { recovered: 0, appended: 0 };
  const client = await getCodexAppServerClient({ env, home: runtimeHome(env) }).catch(() => null);
  let recovered = 0;
  let appended = 0;
  for (const thread of appServerThreads) {
    const codexId = codexThreadId(thread);
    if (!codexId) continue;
    let clientState = client?.threadStates.has(codexId) ? client.threadStates.get(codexId) : null;
    const messages = await listThreadMessages(thread.id, env).catch(() => []);
    const incompleteTurn = latestIncompleteDeliveredTurn(messages);
    let staleRuntime = staleAppServerRuntime(thread, clientState);
    let shouldRecoverTurn = shouldRecoverIncompleteTurn(thread, clientState, incompleteTurn, env);
    if ((staleRuntime || shouldRecoverTurn) && client) {
      const liveReadState = await readLiveCodexThreadState(client, codexId);
      if (liveReadState) {
        clientState = liveReadState;
        staleRuntime = staleAppServerRuntime(thread, clientState);
        shouldRecoverTurn = shouldRecoverIncompleteTurn(thread, clientState, incompleteTurn, env);
      }
    }
    const noticeTurn = shouldRecoverTurn || incompleteTurnMatchesRuntimeTurn(thread, incompleteTurn)
      ? incompleteTurn
      : null;
    if (!staleRuntime && !shouldRecoverTurn) continue;
    let notice = null;
    let noticeMessages = messages;
    let freshNoticeTurn = noticeTurn;
    if (noticeTurn) {
      noticeMessages = await listThreadMessages(thread.id, env).catch(() => messages);
      freshNoticeTurn = refreshedTurnState(noticeMessages, noticeTurn);
    }
    if (freshNoticeTurn) {
      const result = await appendStaleTurnNotice(thread, noticeMessages, freshNoticeTurn, env, options);
      notice = result?.notice || null;
      if (result?.appended) appended += 1;
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
        codexStatus: clientState?.status || { type: "idle" },
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
      reason: freshNoticeTurn?.reason || noticeTurn?.reason || (staleRuntime ? "stale_runtime" : "incomplete_turn"),
      noticeCause: clean(options.noticeCause || options.cause),
    }, env).catch(() => {});
  }
  return { recovered, appended };
}
