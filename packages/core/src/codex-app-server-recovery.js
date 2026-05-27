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

function timestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function deliveredUserMessage(message = {}) {
  if (message?.role !== "user") return false;
  const state = clean(message.state).toLowerCase();
  if (state && state !== "completed") return false;
  const deliveryState = clean(message.deliveryState).toLowerCase();
  const observedVia = clean(message.observedVia).toLowerCase();
  return deliveryState === "delivered" ||
    observedVia.startsWith("codex_app_server") ||
    Boolean(clean(message.codexTurnId || message.executorTurnId));
}

function assistantMessage(message = {}) {
  if (message?.role !== "assistant") return false;
  const state = clean(message.state).toLowerCase();
  return !state || state === "completed";
}

function terminalAssistantMessage(message = {}) {
  if (!assistantMessage(message)) return false;
  const phase = clean(message.phase || "final_answer").toLowerCase();
  if (phase === "final_answer" || phase === "runtime_interrupted") return true;
  return ["plan", "need_input"].includes(phase);
}

function latestIncompleteDeliveredTurn(messages = []) {
  const latestUserIndex = messages.findLastIndex((message) => deliveredUserMessage(message));
  if (latestUserIndex < 0) return null;
  const latestUser = messages[latestUserIndex];
  const afterUser = messages.slice(latestUserIndex + 1).filter((message) => assistantMessage(message));
  if (afterUser.some((message) => terminalAssistantMessage(message))) return null;
  const latestAssistant = afterUser.at(-1) || null;
  return {
    latestUser,
    latestAssistant,
    reason: latestAssistant ? "no_final_answer" : "no_assistant_response",
    lastActivityMs: timestampMs(latestAssistant?.timestamp || latestAssistant?.createdAt || latestUser.timestamp || latestUser.createdAt),
  };
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

function shouldRecoverIncompleteTurn(thread, clientState, turn, env = process.env) {
  if (!turn) return false;
  const liveStatusState = appServerStateFromStatus(clientState?.status || null);
  const liveActiveTurnId = clean(clientState?.activeTurnId);
  if (liveActiveTurnId || liveStatusState === "working") return false;
  const threadState = clean(thread?.state).toLowerCase();
  if (["working", "queued", "pending_delivery", "awaiting_ack"].includes(threadState)) return false;
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
    const clientState = client?.threadStates.has(codexId) ? client.threadStates.get(codexId) : null;
    const messages = await listThreadMessages(thread.id, env).catch(() => []);
    const incompleteTurn = latestIncompleteDeliveredTurn(messages);
    const staleRuntime = staleAppServerRuntime(thread, clientState);
    if (!staleRuntime && !shouldRecoverIncompleteTurn(thread, clientState, incompleteTurn, env)) continue;
    let notice = null;
    if (incompleteTurn) {
      const result = await appendStaleTurnNotice(thread, messages, incompleteTurn, env, options);
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
      latestUserMessageId: incompleteTurn?.latestUser?.id || null,
      reason: incompleteTurn?.reason || (staleRuntime ? "stale_runtime" : "incomplete_turn"),
      noticeCause: clean(options.noticeCause || options.cause),
    }, env).catch(() => {});
  }
  return { recovered, appended };
}
