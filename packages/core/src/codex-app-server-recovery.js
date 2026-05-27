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

function latestDeliveredUserWithoutAssistant(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (assistantMessage(message)) return null;
    if (deliveredUserMessage(message)) return message;
  }
  return null;
}

function staleTurnNoticeText() {
  return [
    "Codex conversation interrupted",
    "",
    "Orkestr found a delivered message with no assistant response after the Codex runtime stopped, restarted, or lost the active turn.",
    "Send the next instruction normally to continue. Use /now only when you intentionally want to interrupt active work.",
  ].join("\n");
}

function staleTurnEventId(thread, codexId, message) {
  return threadEventId({
    codexThreadId: codexId,
    turnId: clean(message?.codexTurnId || message?.executorTurnId || thread?.runtime?.activeTurnId || "stale-turn"),
    itemId: `stale-no-reply:${message?.id || "latest"}`,
    type: "turn/stale-no-reply",
    role: "assistant",
    text: staleTurnNoticeText(),
  });
}

async function appendStaleTurnNotice(thread, messages, latestUser, env = process.env) {
  const codexId = codexThreadId(thread);
  const text = staleTurnNoticeText();
  const eventId = staleTurnEventId(thread, codexId, latestUser);
  const existing = messages.find((message) => message.eventId === eventId);
  const whatsappParent = whatsappOrigin(latestUser) ? latestUser : null;
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

export async function recoverStaleCodexAppServerTurns(env = process.env) {
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
    if (!staleAppServerRuntime(thread, clientState)) continue;
    const messages = await listThreadMessages(thread.id, env).catch(() => []);
    const latestUser = latestDeliveredUserWithoutAssistant(messages);
    let notice = null;
    if (latestUser) {
      const result = await appendStaleTurnNotice(thread, messages, latestUser, env).catch(() => null);
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
      latestUserMessageId: latestUser?.id || null,
    }, env).catch(() => {});
  }
  return { recovered, appended };
}
