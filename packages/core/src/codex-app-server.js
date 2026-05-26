import { appendEvent } from "../../storage/src/store.js";
import {
  getThread,
  listThreadMessages,
  updateThread,
  updateThreadMessage,
} from "./threads.js";
import {
  appendOrUpdateEventMessage,
  appServerStateFromStatus,
  clean,
  codexInputText,
  codexAppServerEnabled,
  codexSessionId,
  codexThreadId,
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
  turnStartParams,
  userInputText,
} from "./codex-app-server-common.js";
import { getCodexAppServerClient } from "./codex-app-server-client.js";
import { codexAppServerMessageFields } from "./codex-app-server-whatsapp.js";

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
  stopCodexAppServerClients,
} from "./codex-app-server-client.js";

export async function startCodexAppServerThread(thread, env = process.env) {
  if (!codexAppServerEnabled(env)) return null;
  const client = await getCodexAppServerClient({ env, home: runtimeHome(env) });
  const result = await client.request("thread/start", threadStartParams(thread));
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
        codexModel: modelForThread(thread) || codexThread.model || null,
        codexModelProvider: codexThread.modelProvider || "openai",
        codexSandbox: threadStartParams(thread).sandbox,
        codexApprovalPolicy: threadStartParams(thread).approvalPolicy,
      },
    },
    runtime: {
      ...(thread.runtime || {}),
      runtimeKind: "codex-app-server",
      state: "ready",
      codexThreadId: codexId,
      codexSessionId: clean(codexThread.sessionId || codexId),
      startedAt: nowIso(),
    },
  }, env);
  await appendEvent({ type: "codex_app_server_thread_started", threadId: thread.id, codexThreadId: codexId }, env).catch(() => {});
  return { thread: updated, codexThread, client };
}

export async function resumeCodexAppServerThread(thread, env = process.env) {
  const id = codexThreadId(thread);
  if (!id) throw new Error("codex_thread_id_required");
  const client = await getCodexAppServerClient({ env, home: runtimeHome(env) });
  const result = await client.request("thread/resume", { threadId: id });
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
      },
    },
    runtime: {
      ...(thread.runtime || {}),
      runtimeKind: "codex-app-server",
      state: "ready",
      codexThreadId: id,
      codexSessionId: clean(codexThread.sessionId || codexSessionId(thread) || id),
      activeTurnId: null,
      resumedAt: nowIso(),
    },
  }, env);
  return { thread: updated, codexThread, status: await codexAppServerThreadStatus(updated, env) };
}

export async function sleepCodexAppServerThread(thread, options = {}, env = process.env) {
  const id = codexThreadId(thread);
  const client = id ? await getCodexAppServerClient({ env, home: runtimeHome(env) }).catch(() => null) : null;
  const state = client?.threadStates.get(id) || {};
  if (options.kill !== false && id && state.activeTurnId) {
    await client.request("turn/interrupt", { threadId: id, turnId: state.activeTurnId }).catch(() => null);
  }
  if (id && client) await client.request("thread/unsubscribe", { threadId: id }).catch(() => null);
  const updated = await updateThread(thread.id, {
    state: "sleeping",
    runtime: {
      ...(thread.runtime || {}),
      runtimeKind: "codex-app-server",
      state: "sleeping",
      activeTurnId: null,
      endedAt: nowIso(),
      reason: options.reason || "sleep",
    },
  }, env);
  await appendEvent({ type: "codex_app_server_thread_slept", threadId: thread.id, codexThreadId: id, reason: options.reason || "sleep" }, env).catch(() => {});
  return { thread: updated, slept: id ? 1 : 0, notice: null };
}

export async function interruptCodexAppServerThread(thread, env = process.env) {
  const id = codexThreadId(thread);
  if (!id) return { interrupted: false, reason: "codex_thread_id_required" };
  const client = await getCodexAppServerClient({ env, home: runtimeHome(env) });
  const clientState = client.threadStates.get(id);
  const activeTurnId = clean(
    clientState && Object.prototype.hasOwnProperty.call(clientState, "activeTurnId")
      ? clientState.activeTurnId
      : thread.runtime?.activeTurnId
  );
  if (!activeTurnId) return { interrupted: false, reason: "no_active_turn" };
  await client.request("turn/interrupt", { threadId: id, turnId: activeTurnId });
  await updateThread(thread.id, {
    state: "ready",
    runtime: { ...(thread.runtime || {}), runtimeKind: "codex-app-server", activeTurnId: null, state: "ready" },
  }, env).catch(() => {});
  return { interrupted: true, turnId: activeTurnId };
}

function staleSteerError(error) {
  const text = clean(error?.message || error?.data?.message || error?.data?.error || error);
  return /no\s+active\s+turn/i.test(text) && /steer/i.test(text);
}

function staleSteerFailureMessage(message = {}) {
  if (message.role !== "user" || message.state !== "failed") return false;
  return staleSteerError(message.error || message.deliveryError || message.lastError);
}

async function startCodexAppServerTurn({ client, thread, id, pending, env, observedVia = "codex_app_server_turn_start" }) {
  const result = await client.request("turn/start", turnStartParams(thread, pending));
  const turnId = clean(result?.turn?.id || result?.turnId);
  if (turnId) {
    client.rememberTurnParent(id, turnId, pending);
    client.threadStates.set(id, { ...(client.threadStates.get(id) || {}), activeTurnId: turnId, status: { type: "active", activeFlags: ["running"] } });
    await updateThread(thread.id, {
      state: "working",
      runtime: { ...(thread.runtime || {}), runtimeKind: "codex-app-server", activeTurnId: turnId, state: "working" },
    }, env).catch(() => {});
  }
  return { result, observedVia, turnId };
}

export async function sendCodexAppServerInput(thread, message, env = process.env) {
  const id = codexThreadId(thread);
  if (!id) throw new Error("codex_thread_id_required");
  const client = await getCodexAppServerClient({ env, home: runtimeHome(env) });
  const pending = await updateThreadMessage(thread.id, message.id, {
    state: "pending_delivery",
    deliveryState: "codex_app_server_sending",
    deliveryLastAttemptAt: nowIso(),
  }, env);
  const activeTurnId = clean(client.threadStates.get(id)?.activeTurnId || thread.runtime?.activeTurnId);
  let result;
  let observedVia;
  let deliveryTurnId = activeTurnId;
  if (activeTurnId) {
    client.rememberTurnParent(id, activeTurnId, pending);
    try {
      result = await client.request("turn/steer", {
        threadId: id,
        expectedTurnId: activeTurnId,
        input: [{ type: "text", text: codexInputText(message), text_elements: [] }],
      });
      deliveryTurnId = activeTurnId;
      observedVia = "codex_app_server_turn_steer";
    } catch (error) {
      if (!staleSteerError(error)) throw error;
      client.threadStates.set(id, { ...(client.threadStates.get(id) || {}), activeTurnId: "", status: { type: "idle" } });
      await updateThread(thread.id, {
        state: "ready",
        runtime: { ...(thread.runtime || {}), runtimeKind: "codex-app-server", activeTurnId: null, state: "ready" },
      }, env).catch(() => {});
      await appendEvent({
        type: "codex_app_server_stale_turn_recovered",
        threadId: thread.id,
        codexThreadId: id,
        staleTurnId: activeTurnId,
        messageId: pending.id,
      }, env).catch(() => {});
      const started = await startCodexAppServerTurn({
        client,
        thread: { ...thread, runtime: { ...(thread.runtime || {}), activeTurnId: null } },
        id,
        pending,
        env,
        observedVia: "codex_app_server_turn_start_after_stale_steer",
      });
      result = started.result;
      observedVia = started.observedVia;
      deliveryTurnId = started.turnId;
    }
  } else {
    const started = await startCodexAppServerTurn({ client, thread, id, pending, env });
    result = started.result;
    observedVia = started.observedVia;
    deliveryTurnId = started.turnId;
  }
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
    codexThreadId: id,
    codexTurnId: result?.turn?.id || result?.turnId || deliveryTurnId || null,
    error: null,
  }, env);
  await appendEvent({ type: "thread_input_delivered", threadId: thread.id, messageId: message.id, observedVia }, env).catch(() => {});
  return { message: completed, result, observedVia };
}

export async function deliverCodexAppServerPendingInputs(thread, env = process.env) {
  const delivered = [];
  const messages = await listThreadMessages(thread.id, env);
  const nextQueued = messages.find((message) => message.role === "user" && ["queued", "pending_delivery", "awaiting_ack"].includes(message.state));
  let next = nextQueued || messages.find(staleSteerFailureMessage);
  if (!next) return delivered;
  let client;
  try {
    client = await getCodexAppServerClient({ env, home: runtimeHome(env) });
  } catch (error) {
    const errorText = publicError(error);
    await updateThread(thread.id, { state: "failed", lastError: errorText }, env).catch(() => {});
    await appendEvent({ type: "codex_app_server_unavailable", threadId: thread.id, error: errorText }, env).catch(() => {});
    return delivered;
  }
  const id = codexThreadId(thread);
  const statusType = clean(client.threadStates.get(id)?.status?.type);
  const threadState = clean(thread.state);
  if (id && (!statusType || statusType === "notLoaded" || threadState === "sleeping" || threadState === "failed")) {
    try {
      const resumed = await resumeCodexAppServerThread(thread, env);
      thread = resumed.thread || thread;
      client = resumed.client || client;
    } catch (error) {
      const errorText = publicError(error);
      await updateThreadMessage(thread.id, next.id, {
        state: "queued",
        deliveryState: "waiting_codex_resume",
        deliveryLastAttemptAt: nowIso(),
        error: errorText,
      }, env).catch(() => {});
      await updateThread(thread.id, { state: "sleeping", lastError: errorText }, env).catch(() => {});
      await appendEvent({ type: "codex_app_server_resume_failed", threadId: thread.id, codexThreadId: id, error: errorText }, env).catch(() => {});
      return delivered;
    }
  }
  if (staleSteerFailureMessage(next)) {
    next = await updateThreadMessage(thread.id, next.id, {
      state: "queued",
      deliveryState: "retrying_delivery",
      deliveryLastAttemptAt: nowIso(),
      error: null,
    }, env).catch(() => ({ ...next, state: "queued", deliveryState: "retrying_delivery", error: null }));
    await updateThread(thread.id, { lastError: null }, env).catch(() => {});
    await appendEvent({
      type: "codex_app_server_stale_turn_failed_input_retrying",
      threadId: thread.id,
      codexThreadId: id,
      messageId: next.id,
    }, env).catch(() => {});
  }
  const pendingApproval = client.pendingRequestForThread(thread);
  const text = clean(next.text);
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
  if (text === "/stop") {
    await interruptCodexAppServerThread(thread, env).catch(() => null);
    await updateThreadMessage(thread.id, next.id, {
      state: "completed",
      deliveryState: "delivered",
      deliveredAt: nowIso(),
      observedVia: "codex_app_server_stop",
    }, env);
    delivered.push(next.id);
    return delivered;
  }
  try {
    const result = await sendCodexAppServerInput(thread, next, env);
    delivered.push(result.message.id);
  } catch (error) {
    const errorText = publicError(error);
    await updateThreadMessage(thread.id, next.id, {
      state: "failed",
      deliveryState: "failed",
      error: errorText,
    }, env).catch(() => {});
    await updateThread(thread.id, { state: "failed", lastError: errorText }, env).catch(() => {});
    await appendEvent({ type: "thread_input_delivery_failed", threadId: thread.id, messageId: next.id, error: errorText }, env).catch(() => {});
  }
  return delivered;
}

export async function codexAppServerThreadStatus(thread, env = process.env, counts = {}) {
  const id = codexThreadId(thread);
  const client = id ? await getCodexAppServerClient({ env, home: runtimeHome(env) }).catch(() => null) : null;
  const state = id && client ? client.threadStates.get(id) || {} : {};
  const pendingRequest = client?.pendingRequestForThread(thread) || thread.runtime?.pendingRequest || null;
  const codexStatus = state.status || thread.runtime?.codexStatus || null;
  const statusState = appServerStateFromStatus(codexStatus);
  const activeTurnId = ["ready", "failed", "sleeping"].includes(statusState)
    ? clean(state.activeTurnId)
    : clean(state.activeTurnId || thread.runtime?.activeTurnId);
  const threadState = clean(thread.state);
  const runtimeState = pendingRequest ? "awaiting_approval" : activeTurnId ? "working" : statusState || (threadState === "sleeping" ? "sleeping" : "ready");
  return {
    state: runtimeState,
    status: runtimeState,
    runtimeState: "codex-app-server",
    runtimeKind: "codex-app-server",
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
    hibernated: runtimeState === "sleeping",
    codexMode: thread.codexMode || null,
    codexModeSource: thread.codexModeSource || null,
    planImplementationReady: false,
    planImplementationMenuVisible: false,
    planImplementationSelectedChoice: null,
    progress: null,
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
    state: "sleeping",
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
    codexThreadId: id,
    codexSessionId: clean(codexThread.sessionId || id),
    importedFromCodex: true,
  }, env);
  await hydrateCodexAppServerThreadMessages(thread, codexThread, env);
  await appendEvent({ type: "codex_app_server_thread_imported", threadId: thread.id, codexThreadId: id }, env).catch(() => {});
  return { thread: await getThread(thread.id, env) || thread, imported: true, codexThread };
}

export async function hydrateCodexAppServerThreadMessages(thread, codexThread, env = process.env) {
  const turns = Array.isArray(codexThread?.turns) ? codexThread.turns : [];
  let count = 0;
  for (const turn of turns) {
    const turnId = clean(turn.id);
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      const type = clean(item.type);
      if (type === "userMessage") {
        const text = itemText(item) || userInputText(item.input);
        if (!text) continue;
        await appendOrUpdateEventMessage(thread, {
          role: "user",
          source: "codex-app-server-import",
          text,
          state: "completed",
          eventId: threadEventId({ codexThreadId: codexThread.id, turnId, itemId: item.id, type, role: "user", text }),
          codexThreadId: codexThread.id,
          codexTurnId: turnId,
          codexItemId: item.id || null,
          ...codexAppServerMessageFields(codexThread.id, { turnId, itemId: item.id }),
        }, env).catch(() => null);
        count += 1;
      } else if (["agentMessage", "plan", "exitedReviewMode", "contextCompaction"].includes(type)) {
        const text = type === "contextCompaction" ? "Codex compacted the conversation context." : itemText(item);
        if (!text) continue;
        await appendOrUpdateEventMessage(thread, {
          role: "assistant",
          source: "codex-app-server-import",
          phase: itemPhase(item) || "final_answer",
          text,
          state: "completed",
          eventId: threadEventId({ codexThreadId: codexThread.id, turnId, itemId: item.id, type, role: "assistant", text }),
          codexThreadId: codexThread.id,
          codexTurnId: turnId,
          codexItemId: item.id || null,
          ...codexAppServerMessageFields(codexThread.id, { turnId, itemId: item.id }),
        }, env).catch(() => null);
        count += 1;
      }
    }
  }
  return { count };
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
