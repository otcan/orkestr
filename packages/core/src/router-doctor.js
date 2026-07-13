import { appendEvent } from "../../storage/src/store.js";
import { resourceOwnerUserId } from "./policy.js";
import { deliverPendingThreadInputs, runtimeStatus, wakeThread } from "./runtime-leases.js";
import { getThread, listThreadMessages, listThreads, updateThreadMessage } from "./threads.js";
import { listRouterOutbox, listRouterTraces, recordRouterTraceEvent } from "./router-traces.js";
import { backfillRouterTracePhases } from "./router-trace-backfill.js";
import {
  inferredRuntimeBackfillPhases,
  phaseSet,
  phaseTime,
  requiredTracePhases,
  traceHasRuntimeReplyEvidence,
  traceShortCircuitedBeforeRuntime,
} from "./router-doctor-trace-rules.js";

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function dateMs(value = "") {
  const ms = Date.parse(clean(value));
  return Number.isFinite(ms) ? ms : 0;
}

function ageMs(value = "") {
  const ms = dateMs(value);
  return ms ? Math.max(0, Date.now() - ms) : 0;
}

function staleQueueMs(env = process.env) {
  const parsed = Number(env.ORKESTR_ROUTER_DOCTOR_STALE_QUEUE_MS || 60_000);
  return Number.isFinite(parsed) ? Math.max(15_000, Math.floor(parsed)) : 60_000;
}

function outboxClaimTimeoutMs(env = process.env) {
  const parsed = Number(env.ORKESTR_ROUTER_DOCTOR_OUTBOX_CLAIM_MS || env.ORKESTR_CONNECTOR_OUTBOX_CLAIM_TTL_MS || 120_000);
  return Number.isFinite(parsed) ? Math.max(5_000, Math.floor(parsed)) : 120_000;
}

function issue(code, severity, summary, detail = {}) {
  return {
    code,
    severity,
    summary,
    ...detail,
  };
}

function whatsappMessage(message = {}) {
  return lower(message.connector) === "whatsapp" ||
    ["whatsapp", "whatsapp_inbound", "whatsapp_client"].includes(lower(message.source)) ||
    lower(message.originSurface) === "whatsapp";
}

function activeQueuedMessage(message = {}) {
  return message.role === "user" && ["queued", "pending_delivery", "awaiting_ack", "running"].includes(lower(message.state));
}

function terminalUserMessage(message = {}) {
  if (message.role !== "user") return false;
  return ["completed", "delivered"].includes(lower(message.state)) ||
    ["completed", "delivered"].includes(lower(message.deliveryState));
}

function runtimeDeliveryObservedVia(value = "") {
  const observed = lower(value);
  if (!observed) return false;
  if (observed.startsWith("codex_app_server_turn_")) return true;
  if (observed.startsWith("tmux_send")) return true;
  if (observed.startsWith("tmux_submit")) return true;
  return new Set([
    "assistant_after_input",
    "codex_app_server_user_input",
    "codex_request_user_input",
    "codex_rollout_growth",
    "orkestr_steer_command",
    "runtime_working",
    "thread_input_delivery",
  ]).has(observed);
}

function messageRuntimeDeliveryEvidence(message = {}) {
  if (!terminalUserMessage(message)) return false;
  if (runtimeDeliveryObservedVia(message.observedVia)) return true;
  if (message.steerActiveTurn === true && clean(message.codexTurnId)) return true;
  if (clean(message.codexTurnId) && clean(message.codexThreadId)) return true;
  return false;
}

function inferredMessageRuntimeBackfillPhases(trace = {}, message = {}, missingPhases = []) {
  const missing = new Set((Array.isArray(missingPhases) ? missingPhases : []).map(lower));
  const phases = phaseSet(trace);
  const additions = [];
  const queuedMs = phaseTime(trace, "queued") || phaseTime(trace, "routed") || phaseTime(trace, "received") || dateMs(trace.createdAt);
  const deliveredMs = dateMs(message.deliveredAt || message.deliveryLastAttemptAt || message.updatedAt) || dateMs(trace.updatedAt) || Date.now();
  const startMs = queuedMs && queuedMs < deliveredMs ? Math.max(queuedMs + 1, deliveredMs - 2) : Math.max(1, deliveredMs - 2);
  const reason = `router_doctor_inferred_from_${lower(message.observedVia) || "message_delivery"}`.slice(0, 200);
  if (missing.has("delivery_started") && !phases.has("delivery_started")) {
    additions.push({ phase: "delivery_started", ts: new Date(startMs).toISOString(), reason });
  }
  if (missing.has("delivered_to_runtime") && !phases.has("delivered_to_runtime")) {
    additions.push({ phase: "delivered_to_runtime", ts: new Date(Math.max(startMs + 1, deliveredMs)).toISOString(), reason });
  }
  return additions;
}

function deliveredAssistantMessage(message = {}) {
  if (message.role !== "assistant") return false;
  if (lower(message.deliveryState) === "failed") return false;
  return ["completed", "delivered", ""].includes(lower(message.state)) ||
    ["completed", "delivered", ""].includes(lower(message.deliveryState));
}

function sameChat(left = {}, right = {}) {
  const leftChat = clean(left.chatId);
  const rightChat = clean(right.chatId);
  return !leftChat || !rightChat || leftChat === rightChat;
}

function traceForMessage(message = {}, traces = []) {
  const routerTraceId = clean(message.routerTraceId);
  if (routerTraceId) {
    const byTrace = traces.find((trace) => clean(trace.routerTraceId) === routerTraceId);
    if (byTrace) return byTrace;
  }
  return traces.find((trace) => clean(trace.messageId) === clean(message.id)) || null;
}

function accountIdForThread(thread = {}) {
  const binding = thread.binding && typeof thread.binding === "object" ? thread.binding : {};
  return clean(
    binding.responderAccountId ||
    binding.outboundAccountId ||
    binding.senderAccountId ||
    binding.accountId ||
    thread.accountId
  );
}

function sourceRevisionForMessage(message = {}) {
  const parsed = Number(message.revision || 1);
  return String(Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1);
}

function whatsappAssistantFinal(message = {}) {
  return message.role === "assistant" &&
    lower(message.state) === "completed" &&
    lower(message.phase || "final_answer") === "final_answer" &&
    whatsappMessage(message) &&
    Boolean(clean(message.chatId));
}

function deliveredWhatsAppMirrorMessage(message = {}) {
  return lower(message.deliveryState) === "delivered" || Boolean(clean(message.deliveredAt || message.mirrorOutboxJobId));
}

function outboxJobForFinalMessage(jobs = [], message = {}) {
  const messageId = clean(message.id);
  return (jobs || []).find((job) =>
    lower(job.connector) === "whatsapp" &&
    lower(job.deliveryType) === "final" &&
    clean(job.sourceMessageId) === messageId
  ) || null;
}

function accountReady(status = {}, accountId = "") {
  const accounts = Array.isArray(status.accounts) ? status.accounts : [];
  const id = clean(accountId);
  const relevant = id ? accounts.filter((account) => accountMatchesId(account, id)) : accounts;
  if (!relevant.length) return Boolean(status.ready || ["ready", "send_ready_scoped"].includes(lower(status.state || status.status)));
  return relevant.some((account) => account.ready === true || lower(account.state) === "ready" || lower(account.status) === "ready");
}

function accountMatchesId(account = {}, id = "") {
  const candidates = [
    account.accountId,
    account.id,
    account.runtimeAccountId,
    account.sessionRef,
    ...(Array.isArray(account.legacyRoleAliases) ? account.legacyRoleAliases : []),
  ].map(clean).filter(Boolean);
  return candidates.includes(clean(id)) || candidates.includes(`whatsapp:${clean(id)}`);
}

function newerAssistant(messages = [], userMessage = {}) {
  const userTs = dateMs(userMessage.createdAt || userMessage.updatedAt);
  return messages
    .filter((message) => deliveredAssistantMessage(message) && sameChat(message, userMessage))
    .find((message) => dateMs(message.createdAt || message.updatedAt) > userTs) || null;
}

function olderAssistant(messages = [], userMessage = {}) {
  const userTs = dateMs(userMessage.createdAt || userMessage.updatedAt);
  return [...messages]
    .reverse()
    .find((message) => deliveredAssistantMessage(message) && sameChat(message, userMessage) && dateMs(message.createdAt || message.updatedAt) <= userTs) || null;
}

function queueNoticeWithoutRuntimeDelivery(message = {}, trace = null, thresholdMs = 60_000) {
  if (!message || message.role !== "user") return false;
  if (!["waiting_runtime_ready", "waiting_runtime_start", "awaiting_active_turn", "interrupting"].includes(lower(message.deliveryState))) return false;
  const phases = trace ? phaseSet(trace) : new Set();
  if (phases.has("delivered_to_runtime")) return false;
  return ageMs(message.updatedAt || message.createdAt) >= thresholdMs;
}

function runtimeReady(status = {}) {
  if (status.working === true) return false;
  if (["working", "running", "busy"].includes(lower(status.state))) return false;
  return lower(status.state) === "ready" || status.promptReady === true || status.ready === true;
}

async function repairIssue(item = {}, context = {}) {
  const { env, thread, repairSafe, releaseConnectorOutboxClaimFn, ensureConnectorOutboxJobFn } = context;
  if (item.code === "sleeping_thread_has_queued_whatsapp_input") {
    const result = await wakeThread(thread.id, { reason: "router_doctor_whatsapp_repair" }, env);
    return { code: "wake_thread", ok: true, threadId: thread.id, messageId: item.messageId, status: result.status || null };
  }
  if (item.code === "stale_queued_whatsapp_input_ready_runtime") {
    let requeued = false;
    if (lower(item.messageState) !== "awaiting_ack") {
      await updateThreadMessage(thread.id, item.messageId, {
        state: "queued",
        deliveryState: "retrying_delivery",
        error: null,
        deliveryNextAttemptAt: null,
      }, env);
      requeued = true;
    }
    const delivered = await deliverPendingThreadInputs(thread.id, env, { processApiAgent: true });
    return { code: "retry_runtime_delivery", ok: true, threadId: thread.id, messageId: item.messageId, requeued, delivered };
  }
  if (item.code === "stale_outbox_claim") {
    const released = typeof releaseConnectorOutboxClaimFn === "function"
      ? await releaseConnectorOutboxClaimFn(item.outboxJobId, { reason: "router_doctor_stale_claim" }, env)
      : null;
    return { code: "release_stale_outbox_claim", ok: Boolean(released), outboxJobId: item.outboxJobId, state: released?.state || "" };
  }
  if (item.code === "orphaned_whatsapp_final_answer" && repairSafe !== false) {
    if (typeof ensureConnectorOutboxJobFn !== "function") return null;
    const message = (Array.isArray(context.messages) ? context.messages : []).find((entry) => clean(entry.id) === clean(item.messageId));
    if (!message) return null;
    const chatId = clean(item.chatId || message.chatId || thread?.binding?.chatId);
    if (!chatId) return null;
    const accountId = clean(item.accountId || message.accountId || accountIdForThread(thread));
    const ownerUserId = resourceOwnerUserId(thread || {}, env);
    const sourceRevision = sourceRevisionForMessage(message);
    const result = await ensureConnectorOutboxJobFn({
      tenantId: ownerUserId,
      ownerUserId,
      connector: "whatsapp",
      accountId,
      chatId,
      threadId: thread.id,
      sourceEventId: clean(message.eventId || message.sourceEventId || message.id),
      sourceMessageId: clean(message.id),
      sourceRevision,
      deliveryType: "final",
      payload: { text: clean(message.text) },
      metadata: {
        kind: "thread",
        parentMessageId: clean(message.parentMessageId),
        routerTraceId: clean(message.routerTraceId),
        repairedBy: "router_doctor_whatsapp",
      },
    }, env);
    await updateThreadMessage(thread.id, message.id, {
      mirrorOutboxJobId: result.job.id,
      mirrorDeliveryType: "final",
      deliveryState: "pending_whatsapp_mirror",
      deliveryLastAttemptAt: nowIso(),
      deliveryError: "",
    }, env).catch(() => null);
    await recordRouterTraceEvent({
      routerTraceId: clean(message.routerTraceId),
      connector: "whatsapp",
      threadId: thread.id,
      messageId: message.id,
      phase: "assistant_seen",
      reason: "router_doctor_enqueued_orphaned_final_answer",
      deliveryType: "final",
      chatId,
      accountId,
      connectorOutboxJobId: result.job.id,
    }, env).catch(() => null);
    return {
      code: "enqueue_orphaned_final_answer_mirror",
      ok: true,
      threadId: thread.id,
      messageId: message.id,
      outboxJobId: result.job.id,
      state: result.job.state,
      created: result.created === true,
    };
  }
  if (item.code === "queued_whatsapp_input_marked_terminal_without_runtime_delivery" && repairSafe !== false) {
    const updated = await updateThreadMessage(thread.id, item.messageId, {
      state: "queued",
      deliveryState: "retrying_delivery",
      error: "router_doctor_requeued_missing_runtime_delivery",
    }, env);
    await recordRouterTraceEvent({
      routerTraceId: item.routerTraceId,
      connector: "whatsapp",
      threadId: thread.id,
      messageId: item.messageId,
      phase: "queued",
      reason: "router_doctor_requeued_missing_runtime_delivery",
      terminal: false,
    }, env).catch(() => null);
    return { code: "requeue_swallowed_input", ok: true, threadId: thread.id, messageId: item.messageId, state: updated?.state || "" };
  }
  if (item.code === "missing_router_trace_phase" && repairSafe !== false) {
    const routerTraceId = clean(item.routerTraceId);
    if (!routerTraceId) return null;
    const trace = (await listRouterTraces({ routerTraceId, connector: "whatsapp" }, env))[0] || null;
    if (!trace || traceShortCircuitedBeforeRuntime(trace)) return null;
    const message = (Array.isArray(context.messages) ? context.messages : []).find((entry) => clean(entry.id) === clean(item.messageId || trace.messageId)) || {};
    const additions = traceHasRuntimeReplyEvidence(trace)
      ? inferredRuntimeBackfillPhases(trace, item.missingPhases)
      : inferredMessageRuntimeBackfillPhases(trace, message, item.missingPhases);
    if (!additions.length) return null;
    const result = await backfillRouterTracePhases({
      routerTraceId,
      phases: additions,
      reason: "router_doctor_backfill_missing_runtime_delivery",
    }, env);
    const added = Array.isArray(result?.addedPhases) ? result.addedPhases.map((phase) => phase.phase) : [];
    if (!added.length) return null;
    return {
      code: "backfill_router_trace_phases",
      ok: true,
      threadId: thread.id,
      messageId: item.messageId || trace.messageId || "",
      routerTraceId,
      phases: added,
      currentPhase: result?.trace?.currentPhase || trace.currentPhase || "",
    };
  }
  return null;
}

async function inspectThread(thread, options = {}) {
  const env = options.env || process.env;
  const repair = options.repair === true;
  const repairSafe = options.repairSafe !== false;
  const listConnectorOutboxJobsFn = typeof options.listConnectorOutboxJobsFn === "function" ? options.listConnectorOutboxJobsFn : null;
  const releaseConnectorOutboxClaimFn = typeof options.releaseConnectorOutboxClaimFn === "function" ? options.releaseConnectorOutboxClaimFn : null;
  const ensureConnectorOutboxJobFn = typeof options.ensureConnectorOutboxJobFn === "function" ? options.ensureConnectorOutboxJobFn : null;
  const thresholdMs = Number(options.staleMs || 0) || staleQueueMs(env);
  const messages = await listThreadMessages(thread.id, env);
  const traces = await listRouterTraces({ threadId: thread.id, connector: "whatsapp" }, env);
  const status = await Promise.resolve(typeof options.runtimeStatusFn === "function"
    ? options.runtimeStatusFn(thread, messages, env)
    : runtimeStatus(thread.id, env)
  ).catch(() => ({ state: thread.state || "unknown" }));
  const whatsappStatus = await Promise.resolve(typeof options.whatsappStatusFn === "function"
    ? options.whatsappStatusFn(thread, env)
    : Promise.resolve({ ready: false, state: "unknown" })
  ).catch((error) => ({ state: "error", error: clean(error?.message || error) }));
  const checks = [];
  const repairs = [];

  const accountId = accountIdForThread(thread);
  if (!accountReady(whatsappStatus, accountId)) {
    checks.push(issue("transport_down", "error", "WhatsApp transport is not ready for this thread/account.", {
      threadId: thread.id,
      accountId,
      transportState: clean(whatsappStatus.state || whatsappStatus.status || "unknown"),
    }));
  }

  for (const trace of traces) {
    const phases = phaseSet(trace);
    const required = requiredTracePhases(trace);
    const missing = required.filter((phase) => !phases.has(phase));
    if (missing.length) {
      checks.push(issue("missing_router_trace_phase", trace.terminal === true ? "error" : "warn", `Router trace is missing phase(s): ${missing.join(", ")}.`, {
        threadId: trace.threadId,
        messageId: trace.messageId,
        routerTraceId: trace.routerTraceId,
        currentPhase: trace.currentPhase,
        missingPhases: missing,
      }));
    }
  }

  for (const message of messages.filter((item) => whatsappMessage(item) && item.role === "user")) {
    const trace = traceForMessage(message, traces);
    const shortCircuitTrace = trace ? traceShortCircuitedBeforeRuntime(trace) : false;
    const phases = trace ? phaseSet(trace) : new Set();
    const assistant = newerAssistant(messages, message);
    const runtimeDelivered = phases.has("delivered_to_runtime") || messageRuntimeDeliveryEvidence(message);
    if (!shortCircuitTrace && terminalUserMessage(message) && !runtimeDelivered && !assistant) {
      const older = olderAssistant(messages, message);
      checks.push(issue("queued_whatsapp_input_marked_terminal_without_runtime_delivery", "error", "WhatsApp user input is terminal without runtime delivery evidence or a newer same-chat assistant reply.", {
        threadId: thread.id,
        messageId: message.id,
        routerTraceId: trace?.routerTraceId || clean(message.routerTraceId),
        messageState: clean(message.state),
        deliveryState: clean(message.deliveryState),
        olderAssistantMessageId: older?.id || "",
      }));
    }
    if (!shortCircuitTrace && terminalUserMessage(message) && !runtimeDelivered && !assistant && olderAssistant(messages, message)) {
      checks.push(issue("older_reply_completed_newer_user_message", "error", "A reply/notice older than the WhatsApp user message appears to be the only completion evidence.", {
        threadId: thread.id,
        messageId: message.id,
        routerTraceId: trace?.routerTraceId || clean(message.routerTraceId),
      }));
    }
    if (activeQueuedMessage(message) && ageMs(message.createdAt) >= thresholdMs && runtimeReady(status)) {
      checks.push(issue("stale_queued_whatsapp_input_ready_runtime", "error", "WhatsApp input is queued while the runtime is ready past the stale threshold.", {
        threadId: thread.id,
        messageId: message.id,
        routerTraceId: trace?.routerTraceId || clean(message.routerTraceId),
        messageState: clean(message.state),
        deliveryState: clean(message.deliveryState),
        deliveryNextAttemptAt: clean(message.deliveryNextAttemptAt),
        ageMs: ageMs(message.createdAt),
        runtimeState: clean(status.state),
        runtimeWorking: status.working === true,
        runtimePromptReady: status.promptReady === true,
      }));
    }
    if (activeQueuedMessage(message) && (["sleeping", "unloaded"].includes(lower(status.state)) || ["sleeping", "unloaded"].includes(lower(thread.state)))) {
      checks.push(issue("sleeping_thread_has_queued_whatsapp_input", "warn", "WhatsApp input is queued while the runtime is sleeping.", {
        threadId: thread.id,
        messageId: message.id,
        routerTraceId: trace?.routerTraceId || clean(message.routerTraceId),
        runtimeState: clean(status.state || thread.state),
      }));
    }
    if (queueNoticeWithoutRuntimeDelivery(message, trace, thresholdMs)) {
      checks.push(issue("queue_notice_without_runtime_delivery", "error", "A queue/handoff notice exists but no runtime delivery happened soon after.", {
        threadId: thread.id,
        messageId: message.id,
        routerTraceId: trace?.routerTraceId || clean(message.routerTraceId),
        deliveryState: clean(message.deliveryState),
        ageMs: ageMs(message.updatedAt || message.createdAt),
      }));
    }
    if (trace && phaseTime(trace, "assistant_seen") && phaseTime(trace, "assistant_seen") <= dateMs(message.createdAt) && !assistant) {
      checks.push(issue("assistant_seen_older_than_user_message", "error", "Router trace assistant_seen phase is older than the WhatsApp user message.", {
        threadId: thread.id,
        messageId: message.id,
        routerTraceId: trace.routerTraceId,
      }));
    }
  }

  const connectorOutbox = listConnectorOutboxJobsFn
    ? await listConnectorOutboxJobsFn({ connector: "whatsapp", threadId: thread.id, limit: 5000 }, env)
    : { jobs: [] };
  const connectorOutboxJobs = connectorOutbox.jobs || [];
  for (const message of messages.filter(whatsappAssistantFinal)) {
    const job = outboxJobForFinalMessage(connectorOutboxJobs, message);
    if (!job && !deliveredWhatsAppMirrorMessage(message)) {
      checks.push(issue("orphaned_whatsapp_final_answer", "error", "Completed WhatsApp assistant final has no mirror delivery marker or connector outbox job.", {
        threadId: thread.id,
        messageId: message.id,
        routerTraceId: clean(message.routerTraceId),
        chatId: clean(message.chatId),
        accountId: clean(message.accountId || accountIdForThread(thread)),
        sourceRevision: sourceRevisionForMessage(message),
      }));
    }
  }
  for (const job of connectorOutboxJobs.filter((item) => ["claimed", "sent_to_broker"].includes(lower(item.state)))) {
    const claimAge = ageMs(job.claimedAt || job.updatedAt);
    const expired = clean(job.claimExpiresAt) ? dateMs(job.claimExpiresAt) <= Date.now() : claimAge >= outboxClaimTimeoutMs(env);
    if (expired) {
      checks.push(issue("stale_outbox_claim", "error", "WhatsApp outbox job is claimed past its timeout and should be released for retry.", {
        threadId: thread.id,
        outboxJobId: job.id,
        state: job.state,
        ageMs: claimAge,
      }));
    }
  }

  if (repair) {
    for (const item of checks) {
      const repaired = await repairIssue(item, {
        env,
        thread,
        messages,
        repairSafe,
        releaseConnectorOutboxClaimFn,
        ensureConnectorOutboxJobFn,
      }).catch((error) => ({
        code: "repair_failed",
        ok: false,
        issueCode: item.code,
        threadId: thread.id,
        messageId: item.messageId || "",
        error: clean(error?.message || error),
      }));
      if (repaired) repairs.push(repaired);
    }
  }

  return {
    threadId: thread.id,
    threadName: clean(thread.name),
    runtime: { state: clean(status.state || thread.state), promptReady: status.promptReady === true, working: status.working === true },
    traceCount: traces.length,
    messageCount: messages.length,
    checks,
    repairs,
  };
}

export async function doctorWhatsAppRouter(options = {}) {
  const env = options.env || process.env;
  const repair = options.repair === true;
  const threadSelector = clean(options.threadId || options.thread || "");
  const routerTraceId = clean(options.routerTraceId || options.trace || "");
  let threads = [];
  if (threadSelector) {
    const thread = await getThread(threadSelector, env);
    if (!thread) {
      const error = new Error("thread_not_found");
      error.statusCode = 404;
      throw error;
    }
    threads = [thread];
  } else if (routerTraceId) {
    const traces = await listRouterTraces({ routerTraceId, connector: "whatsapp" }, env);
    const threadIds = [...new Set(traces.map((trace) => clean(trace.threadId)).filter(Boolean))];
    threads = (await Promise.all(threadIds.map((id) => getThread(id, env)))).filter(Boolean);
  } else {
    threads = (await listThreads(env)).filter((thread) => lower(thread.binding?.connector || "") === "whatsapp");
  }

  const threadReports = [];
  for (const thread of threads) {
    threadReports.push(await inspectThread(thread, { ...options, env, repair }));
  }

  const routerOutbox = routerTraceId ? await listRouterOutbox({ routerTraceId }, env) : [];
  const checks = threadReports.flatMap((report) => report.checks);
  const repairs = threadReports.flatMap((report) => report.repairs);
  const errors = checks.filter((item) => item.severity === "error").length;
  const warnings = checks.filter((item) => item.severity === "warn").length;
  const payload = {
    ok: errors === 0,
    status: errors ? "broken" : warnings ? "warning" : "ok",
    summary: errors
      ? `${errors} router/WhatsApp invariant error${errors === 1 ? "" : "s"} detected.`
      : warnings
        ? `${warnings} router/WhatsApp warning${warnings === 1 ? "" : "s"} detected.`
        : "WhatsApp/router invariants passed.",
    repair,
    generatedAt: nowIso(),
    counts: { threads: threadReports.length, checks: checks.length, errors, warnings, repairs: repairs.length },
    checks,
    repairs,
    threads: threadReports,
    ...(routerTraceId ? { routerTraceId, routerOutbox } : {}),
  };
  await appendEvent({
    type: "router_doctor_whatsapp_run",
    status: payload.status,
    repair,
    threadId: threadSelector,
    routerTraceId,
    errors,
    warnings,
    repairs: repairs.length,
  }, env).catch(() => null);
  return payload;
}
