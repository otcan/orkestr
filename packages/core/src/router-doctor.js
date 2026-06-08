import { appendEvent } from "../../storage/src/store.js";
import { deliverPendingThreadInputs, runtimeStatus, wakeThread } from "./runtime-leases.js";
import { getThread, listThreadMessages, listThreads, updateThreadMessage } from "./threads.js";
import { listRouterOutbox, listRouterTraces, recordRouterTraceEvent } from "./router-traces.js";

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

function phaseSet(trace = {}) {
  return new Set((Array.isArray(trace.phases) ? trace.phases : []).map((phase) => lower(phase.phase)));
}

function phaseTime(trace = {}, phaseName = "") {
  const phase = (Array.isArray(trace.phases) ? trace.phases : []).find((entry) => lower(entry.phase) === lower(phaseName));
  return dateMs(phase?.ts);
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

function accountReady(status = {}, accountId = "") {
  const accounts = Array.isArray(status.accounts) ? status.accounts : [];
  const id = clean(accountId);
  const relevant = id ? accounts.filter((account) => clean(account.accountId || account.id) === id) : accounts;
  if (!relevant.length) return Boolean(status.ready || status.state === "ready");
  return relevant.some((account) => account.ready === true || lower(account.state) === "ready" || lower(account.status) === "ready");
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
  const { env, thread, repairSafe, releaseConnectorOutboxClaimFn } = context;
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
  return null;
}

async function inspectThread(thread, options = {}) {
  const env = options.env || process.env;
  const repair = options.repair === true;
  const repairSafe = options.repairSafe !== false;
  const listConnectorOutboxJobsFn = typeof options.listConnectorOutboxJobsFn === "function" ? options.listConnectorOutboxJobsFn : null;
  const releaseConnectorOutboxClaimFn = typeof options.releaseConnectorOutboxClaimFn === "function" ? options.releaseConnectorOutboxClaimFn : null;
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
    const required = ["received", "routed", "queued"];
    if (trace.terminal === true || ["completed", "delivered_to_runtime", "assistant_seen"].includes(lower(trace.currentPhase))) {
      required.push("delivery_started", "delivered_to_runtime");
    }
    if (trace.terminal === true || lower(trace.currentPhase) === "completed") required.push("assistant_seen");
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
    const phases = trace ? phaseSet(trace) : new Set();
    const assistant = newerAssistant(messages, message);
    if (terminalUserMessage(message) && !phases.has("delivered_to_runtime") && !assistant) {
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
    if (terminalUserMessage(message) && !assistant && olderAssistant(messages, message)) {
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
    ? await listConnectorOutboxJobsFn({ connector: "whatsapp", threadId: thread.id, state: "claimed sent_to_broker" }, env)
    : { jobs: [] };
  for (const job of connectorOutbox.jobs || []) {
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
      const repaired = await repairIssue(item, { env, thread, repairSafe, releaseConnectorOutboxClaimFn }).catch((error) => ({
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
