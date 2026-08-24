import { appendEvent } from "../../storage/src/store.js";
import { runtimeStatus } from "./runtime-leases.js";
import { getThread, listThreadMessages, listThreads } from "./threads.js";
import { listRouterOutbox, listRouterTraces } from "./router-traces.js";
import { phaseSet, phaseTime, requiredTracePhases, traceShortCircuitedBeforeRuntime } from "./router-doctor-trace-rules.js";
import { boundedResult, buildMessageIndex, buildTraceIndex, scopedMessageIdsForTraces, timeoutMs } from "./router-doctor-indexes.js";
import { queueNoticeWithoutRuntimeDelivery, runtimeDeliveryMissingAssistantIssue } from "./router-doctor-message-recovery.js";
import { orphanedWhatsAppFinalAnswerIssues } from "./router-doctor-whatsapp-final-mirror.js";
import { abortable, throwIfAborted } from "./router-doctor-abort.js";
import { repairIssue } from "./router-doctor-repairs.js";
import { hostBoundaryRouterIssues } from "./host-boundary-doctor.js";
function clean(value = "") {
  return String(value || "").trim();
}

function participantIdentityDoctorSummary(status = {}) {
  const roleSummary = {};
  for (const role of ["owner", "trusted", "blocked"]) {
    const identities = Array.isArray(status.roles?.[role]) ? status.roles[role] : [];
    roleSummary[role] = {
      identities: identities.length,
      verifiedAliases: identities.reduce((count, identity) => count + (Array.isArray(identity.aliases) ? identity.aliases.length : 0), 0),
    };
  }
  return {
    enabled: status.enabled === true,
    configured: status.configured === true,
    valid: status.valid !== false,
    revision: clean(status.revision),
    error: clean(status.error),
    roles: roleSummary,
  };
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
  const relevant = id ? accounts.filter((account) => accountMatchesId(account, id)) : accounts;
  if (!relevant.length) return Boolean(status.ready || ["ready", "send_ready_scoped"].includes(lower(status.state || status.status)));
  return relevant.some((account) =>
    (account.ready === true || lower(account.state) === "ready" || lower(account.status) === "ready") &&
      account.chatOpsReady !== false &&
      account.runtimeUsable !== false
  );
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

function runtimeReady(status = {}) {
  if (status.working === true) return false;
  if (["working", "running", "busy"].includes(lower(status.state))) return false;
  return lower(status.state) === "ready" || status.promptReady === true || status.ready === true;
}

async function inspectThread(thread, options = {}) {
  const env = options.env || process.env;
  const signal = options.signal || null;
  throwIfAborted(signal);
  const repair = options.repair === true;
  const repairSafe = options.repairSafe !== false;
  const listConnectorOutboxJobsFn = typeof options.listConnectorOutboxJobsFn === "function" ? options.listConnectorOutboxJobsFn : null;
  const releaseConnectorOutboxClaimFn = typeof options.releaseConnectorOutboxClaimFn === "function" ? options.releaseConnectorOutboxClaimFn : null;
  const ensureConnectorOutboxJobFn = typeof options.ensureConnectorOutboxJobFn === "function" ? options.ensureConnectorOutboxJobFn : null;
  const thresholdMs = Number(options.staleMs || 0) || staleQueueMs(env);
  const routerTraceId = clean(options.routerTraceId || options.trace || "");
  const messages = await abortable(listThreadMessages(thread.id, env), signal);
  const allTraces = await abortable(listRouterTraces({ threadId: thread.id, connector: "whatsapp" }, env), signal);
  const traces = routerTraceId
    ? allTraces.filter((trace) => clean(trace.routerTraceId) === routerTraceId)
    : allTraces;
  const scopedTraceMessageIds = scopedMessageIdsForTraces(traces);
  const scopedMessages = routerTraceId
    ? messages.filter((message) =>
      clean(message.routerTraceId) === routerTraceId ||
        scopedTraceMessageIds.has(clean(message.id)) ||
        scopedTraceMessageIds.has(clean(message.parentMessageId))
    )
    : messages;
  const traceIndex = buildTraceIndex(traces);
  const messageIndex = buildMessageIndex(messages);
  const status = await abortable(Promise.resolve(typeof options.runtimeStatusFn === "function"
    ? options.runtimeStatusFn(thread, messages, env)
    : runtimeStatus(thread.id, env)
  ).catch(() => ({ state: thread.state || "unknown" })), signal);
  const whatsappStatus = await abortable(Promise.resolve(typeof options.whatsappStatusFn === "function"
    ? options.whatsappStatusFn(thread, env)
    : Promise.resolve({ ready: false, state: "unknown" })
  ).catch((error) => ({ state: "error", error: clean(error?.message || error) })), signal);
  const checks = [];
  const repairs = [];
  const participantIdentity = typeof options.whatsappParticipantIdentityStatusFn === "function"
    ? options.whatsappParticipantIdentityStatusFn(thread.binding || {}, env)
    : { enabled: false, configured: false, valid: true, revision: "", roles: {} };
  const participantIdentitySummary = participantIdentityDoctorSummary(participantIdentity);

  if (participantIdentity.configured && !participantIdentity.valid) {
    checks.push(issue("whatsapp_participant_identity_invalid", "error", "WhatsApp participant identity grants are invalid and inbound routing is failing closed.", {
      threadId: thread.id,
      failureCode: participantIdentity.error,
      remediation: "Repair alias collisions or owner/trusted overlap in the binding before using explicit replay.",
    }));
  }

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
    if (trace.failureCode === "whatsapp_inbound_sender_denied" || ["inbound_security_denied", "inbound_security_blocked", "duplicate_of_rejection"].includes(lower(trace.phases?.at(-1)?.reason))) {
      checks.push(issue("whatsapp_inbound_terminal_denial", "info", "WhatsApp inbound was rejected terminally and will not be retried automatically.", {
        threadId: trace.threadId,
        routerTraceId: trace.routerTraceId,
        failureCode: trace.failureCode || "whatsapp_inbound_sender_denied",
        classification: trace.classification || "",
        effectiveRole: trace.effectiveRole || "unknown",
        policyRevision: trace.policyRevision || "",
        bindingRevision: trace.bindingRevision || "",
        retryable: false,
        remediation: trace.remediation || "Correct the participant binding, then use explicit linked replay.",
      }));
    }
  }

  for (const message of scopedMessages.filter((item) => whatsappMessage(item) && item.role === "user")) {
    const trace = traceIndex.forMessage(message);
    const shortCircuitTrace = trace ? traceShortCircuitedBeforeRuntime(trace) : false;
    const phases = trace ? phaseSet(trace) : new Set();
    const assistant = messageIndex.newerAssistant(message);
    const runtimeDelivered = phases.has("delivered_to_runtime") || messageRuntimeDeliveryEvidence(message);
    if (!shortCircuitTrace && terminalUserMessage(message) && !runtimeDelivered && !assistant) {
      const older = messageIndex.olderAssistant(message);
      checks.push(issue("queued_whatsapp_input_marked_terminal_without_runtime_delivery", "error", "WhatsApp user input is terminal without runtime delivery evidence or a newer same-chat assistant reply.", {
        threadId: thread.id,
        messageId: message.id,
        routerTraceId: trace?.routerTraceId || clean(message.routerTraceId),
        messageState: clean(message.state),
        deliveryState: clean(message.deliveryState),
        olderAssistantMessageId: older?.id || "",
      }));
    }
    if (!shortCircuitTrace && terminalUserMessage(message) && !runtimeDelivered && !assistant && messageIndex.olderAssistant(message)) {
      checks.push(issue("older_reply_completed_newer_user_message", "error", "A reply/notice older than the WhatsApp user message appears to be the only completion evidence.", {
        threadId: thread.id,
        messageId: message.id,
        routerTraceId: trace?.routerTraceId || clean(message.routerTraceId),
      }));
    }
    const missingAssistant = runtimeDeliveryMissingAssistantIssue({ message, messages, trace, status, thresholdMs, runtimeDelivered, shortCircuitTrace, assistant, newerWhatsAppUserMessage: messageIndex.newerWhatsAppUser(message), terminalUserMessageFn: terminalUserMessage, runtimeReadyFn: runtimeReady, whatsappMessageFn: whatsappMessage, issueFn: issue });
    if (missingAssistant) checks.push({ threadId: thread.id, ...missingAssistant });
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
    ? await abortable(listConnectorOutboxJobsFn({ connector: "whatsapp", threadId: thread.id, limit: 5000 }, env), signal)
    : { jobs: [] };
  const connectorOutboxJobs = routerTraceId
    ? (connectorOutbox.jobs || []).filter((job) =>
      clean(job.routerTraceId || job.metadata?.routerTraceId) === routerTraceId ||
        scopedTraceMessageIds.has(clean(job.sourceMessageId)) ||
        scopedTraceMessageIds.has(clean(job.sourceEventId))
    )
    : (connectorOutbox.jobs || []);
  checks.push(...orphanedWhatsAppFinalAnswerIssues({
    messages: scopedMessages,
    connectorOutboxJobs,
    thread,
    whatsappMessageFn: whatsappMessage,
    accountIdForThreadFn: accountIdForThread,
    issueFn: issue,
  }));
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
      throwIfAborted(signal);
      const repaired = await repairIssue(item, {
        env,
        thread,
        messages,
        repairSafe,
        releaseConnectorOutboxClaimFn,
        ensureConnectorOutboxJobFn,
        accountIdForThreadFn: accountIdForThread,
        signal,
      }).catch((error) => {
        if (error?.name === "AbortError") throw error;
        return {
          code: "repair_failed",
          ok: false,
          issueCode: item.code,
          threadId: thread.id,
          messageId: item.messageId || "",
          error: clean(error?.message || error),
        };
      });
      if (repaired) repairs.push(repaired);
    }
  }

  return {
    threadId: thread.id,
    threadName: clean(thread.name),
    runtime: { state: clean(status.state || thread.state), promptReady: status.promptReady === true, working: status.working === true },
    traceCount: traces.length,
    messageCount: messages.length,
    participantIdentity: participantIdentitySummary,
    checks,
    repairs,
  };
}

export function routerDoctorRunEvent(payload = {}, options = {}) {
  return {
    type: "router_doctor_whatsapp_run",
    status: clean(payload.status),
    repair: payload.repair === true,
    threadId: clean(options.threadSelector || options.threadId || ""),
    routerTraceId: clean(options.routerTraceId || ""),
    errors: Number(payload.counts?.errors || 0),
    warnings: Number(payload.counts?.warnings || 0),
    repairs: Number(payload.counts?.repairs || 0),
  };
}

export async function doctorWhatsAppRouter(options = {}) {
  const env = options.env || process.env;
  const signal = options.signal || null;
  throwIfAborted(signal);
  const repair = options.repair === true;
  const threadSelector = clean(options.threadId || options.thread || "");
  const routerTraceId = clean(options.routerTraceId || options.trace || "");
  let threads = [];
  if (threadSelector) {
    const thread = await abortable(getThread(threadSelector, env), signal);
    if (!thread) {
      const error = new Error("thread_not_found");
      error.statusCode = 404;
      throw error;
    }
    threads = [thread];
  } else if (routerTraceId) {
    const traces = await abortable(listRouterTraces({ routerTraceId, connector: "whatsapp" }, env), signal);
    const threadIds = [...new Set(traces.map((trace) => clean(trace.threadId)).filter(Boolean))];
    threads = (await abortable(Promise.all(threadIds.map((id) => getThread(id, env))), signal)).filter(Boolean);
  } else {
    threads = (await abortable(listThreads(env), signal)).filter((thread) => lower(thread.binding?.connector || "") === "whatsapp");
  }

  const statusTimeout = timeoutMs(options.whatsappStatusTimeoutMs || env.ORKESTR_ROUTER_DOCTOR_WHATSAPP_STATUS_TIMEOUT_MS, 5_000, 5_000);
  let sharedWhatsAppStatusPromise = null;
  const sharedWhatsAppStatusFn = (thread) => {
    sharedWhatsAppStatusPromise ||= boundedResult(
      typeof options.whatsappStatusFn === "function"
        ? options.whatsappStatusFn(thread, env)
        : Promise.resolve({ ready: false, state: "unknown" }),
      statusTimeout,
      { ok: false, state: "timeout", statusCode: 503, error: `whatsapp_status_timeout_${statusTimeout}ms` },
    ).catch((error) => ({ ok: false, state: "error", statusCode: 503, error: clean(error?.message || error) }));
    return sharedWhatsAppStatusPromise;
  };

  const threadReports = [];
  for (const thread of threads) {
    throwIfAborted(signal);
    threadReports.push(await inspectThread(thread, { ...options, env, repair, whatsappStatusFn: sharedWhatsAppStatusFn }));
  }

  const routerOutbox = routerTraceId ? await abortable(listRouterOutbox({ routerTraceId }, env), signal) : [];
  const checks = [...await hostBoundaryRouterIssues(env), ...threadReports.flatMap((report) => report.checks)];
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
  throwIfAborted(signal);
  if (options.recordRunEvent !== false) {
    await abortable(appendEvent(routerDoctorRunEvent(payload, { threadSelector, routerTraceId }), env).catch(() => null), signal);
  }
  return payload;
}
