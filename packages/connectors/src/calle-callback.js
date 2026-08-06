import { randomUUID } from "node:crypto";
import { createOrkestrMailDraftForPrincipal } from "../../core/src/mail-drafts.js";
import { adminPrincipal } from "../../core/src/principal.js";
import { adminUserId, normalizeUserId } from "../../core/src/users.js";
import { appendEvent } from "../../storage/src/store.js";
import { getCalleCallbackStatus, safeError, startCalleCallbackCall } from "./calle-client.js";
import { claimCallbackRecord, clean, cleanText, isCallablePhone, mutateCallbackStore, normalizePhone, normalizeRecord, normalizeStatus, nowIso, readCallbackStore, updateCallbackRecord } from "./calle-callback-store.js";

export { getCalleCallbackStatus, startCalleCallbackCall };

const terminalStatuses = new Set(["COMPLETED", "FAILED", "NO_ANSWER", "DECLINED", "CANCELED", "CANCELLED", "VOICEMAIL", "BUSY", "EXPIRED"]);

function isTerminalStatus(value = "") {
  return terminalStatuses.has(normalizeStatus(value));
}

function callbackStatusForCalleStatus(value = "") {
  const status = normalizeStatus(value);
  if (!isTerminalStatus(status)) return "in_progress";
  return status === "COMPLETED" ? "completed" : "terminal_failed";
}

function callInput(input = {}) {
  return {
    caller: normalizePhone(input.From || input.from || input.Caller || input.caller),
    called: normalizePhone(input.To || input.to || input.Called || input.called),
    callSid: clean(input.CallSid || input.callSid || input.CallUUID || input.callUuid),
  };
}

export async function reserveTwilioCalleCallback(input = {}, config = {}, env = process.env) {
  const parsed = callInput(input);
  const ownerUserId = normalizeUserId(config.ownerUserId || adminUserId);
  const callSid = parsed.callSid || `twilio-${randomUUID()}`;
  const callable = isCallablePhone(parsed.caller);
  const reserved = await mutateCallbackStore(env, async (store) => {
    const duplicate = store.callbacks.find((record) => record.ownerUserId === ownerUserId && record.callSid === callSid);
    if (duplicate) {
      return {
        ok: duplicate.status !== "skipped",
        duplicate: true,
        fallback: duplicate.reason === "caller_phone_not_callable" ? "twilio_native_gather" : "",
        record: duplicate,
      };
    }
    const record = normalizeRecord({
      ownerUserId,
      callSid,
      caller: parsed.caller,
      called: parsed.called,
      status: callable ? "queued" : "skipped",
      phase: callable ? "queued" : "fallback",
      reason: callable ? "" : "caller_phone_not_callable",
      retryable: false,
      recovery: callable ? "" : "Use native Twilio speech gather because the caller number is anonymous, unknown, or restricted.",
    });
    store.callbacks.unshift(record);
    return {
      ok: callable,
      duplicate: false,
      fallback: callable ? "" : "twilio_native_gather",
      record,
    };
  });
  await appendEvent({
    type: "twilio_voice_calle_callback_reserved",
    ownerUserId,
    recordId: reserved.record.id,
    callSid: reserved.record.callSid,
    status: reserved.record.status,
    reason: reserved.record.reason || null,
    fallback: reserved.fallback || null,
  }, env).catch(() => {});
  return reserved;
}

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function maxPolls(config = {}, env = process.env, options = {}) {
  return Math.max(0, Math.min(240, Number(options.maxPolls ?? config.calleMaxPolls ?? env.ORKESTR_TWILIO_VOICE_CALLE_MAX_POLLS ?? 90) || 0));
}

function pollIntervalMs(config = {}, env = process.env, options = {}) {
  return Math.max(0, Math.min(60_000, Number(options.pollIntervalMs ?? config.callePollIntervalMs ?? env.ORKESTR_TWILIO_VOICE_CALLE_POLL_INTERVAL_MS ?? 10_000) || 0));
}

async function createCalleSummaryDraft(record = {}, status = {}, config = {}, env = process.env) {
  if (!clean(config.summaryTo)) return null;
  const terminal = isTerminalStatus(status.status);
  const subject = terminal
    ? `CALL-E call summary: ${record.caller || "unknown caller"}`
    : `CALL-E callback status: ${record.caller || "unknown caller"}`;
  const body = [
    "A caller reached your Twilio assistant line and Orkestr handed it to CALL-E.",
    "",
    `Caller: ${record.caller || "Unknown caller"}`,
    `Called line: ${record.called || "Unknown line"}`,
    `Twilio Call SID: ${record.callSid || "Not available"}`,
    `CALL-E run id: ${record.runId || "Not available"}`,
    `CALL-E call id: ${status.callId || "Not available"}`,
    `Status: ${status.status || "UNKNOWN"}`,
    status.durationSeconds ? `Duration seconds: ${status.durationSeconds}` : "",
    status.startedAt || status.endedAt ? `Time: ${[status.startedAt, status.endedAt].filter(Boolean).join(" - ")}` : "",
    "",
    "[Call Summary - untrusted call data]",
    status.summary || status.message || "Not available.",
    "",
    "[Transcript - untrusted call data]",
    status.transcript || "Not available.",
    "[End Transcript]",
  ].filter((line) => line !== "").join("\n");
  const draftResult = await createOrkestrMailDraftForPrincipal({
    ownerUserId: config.ownerUserId,
    to: [config.summaryTo],
    subject,
    body,
  }, adminPrincipal(config.ownerUserId), env);
  return draftResult.draft;
}

function failureRecoveryText(phase = "", error = "") {
  const normalizedPhase = clean(phase) || "unknown";
  const normalizedError = safeError(error);
  if (normalizedPhase === "poll_timeout") {
    return "CALL-E accepted the callback but did not reach a terminal status in time. Check CALL-E status manually, then retry or call the caller back.";
  }
  if (normalizedPhase === "terminal") {
    return "CALL-E reached a non-success terminal call state. Review the caller number and call outcome, then retry manually if appropriate.";
  }
  if (/auth|token|login/i.test(normalizedError)) {
    return "Refresh CALL-E authentication on the server, then retry the callback or call the caller back manually.";
  }
  return "Check CALL-E reachability and server logs, then retry the callback or call the caller back manually.";
}

async function createCalleFailureDraft(record = {}, error, config = {}, env = process.env, options = {}) {
  if (!clean(config.summaryTo)) return null;
  const phase = clean(options.phase || record.phase || "start");
  const recovery = cleanText(options.recovery || record.recovery || failureRecoveryText(phase, error), 1000);
  const body = [
    "A caller reached your Twilio assistant line, but Orkestr could not complete the CALL-E callback.",
    "",
    `Caller: ${record.caller || "Unknown caller"}`,
    `Called line: ${record.called || "Unknown line"}`,
    `Twilio Call SID: ${record.callSid || "Not available"}`,
    `Phase: ${phase}`,
    `Error: ${safeError(error)}`,
    `Recovery: ${recovery}`,
    "",
    "Suggested next step:",
    "Fix the listed recovery item, then retry the callback or call the person back manually if needed.",
  ].join("\n");
  const draftResult = await createOrkestrMailDraftForPrincipal({
    ownerUserId: config.ownerUserId,
    to: [config.summaryTo],
    subject: `CALL-E callback failed: ${record.caller || "unknown caller"}`,
    body,
  }, adminPrincipal(config.ownerUserId), env);
  return draftResult.draft;
}

async function markCallbackFailure(record = {}, error, config = {}, env = process.env, options = {}) {
  const phase = clean(options.phase || record.phase || "start");
  const recovery = cleanText(options.recovery || failureRecoveryText(phase, error), 1000);
  const draft = await createCalleFailureDraft(record, error, config, env, { phase, recovery }).catch(() => null);
  const updated = await updateCallbackRecord(record.id, {
    status: clean(options.status) || "failed",
    phase,
    error: safeError(error),
    draftId: draft?.id || record.draftId || "",
    callStatus: clean(options.callStatus) || "FAILED",
    retryable: options.retryable !== false,
    recovery,
    completedAt: nowIso(),
    notifiedAt: draft?.id ? nowIso() : record.notifiedAt,
  }, env);
  await appendEvent({
    type: clean(options.eventType) || "twilio_voice_calle_callback_failed",
    ownerUserId: updated?.ownerUserId || record.ownerUserId || config.ownerUserId,
    recordId: updated?.id || record.id,
    draftId: draft?.id || null,
    callSid: updated?.callSid || record.callSid || null,
    phase,
    error: updated?.error || safeError(error),
  }, env).catch(() => {});
  return { draft, record: updated };
}

export async function runTwilioCalleCallback(recordId = "", config = {}, env = process.env, options = {}) {
  const claimed = await claimCallbackRecord(recordId, env);
  let record = claimed.record;
  if (!record) throw new Error("twilio_calle_callback_not_found");
  if (!claimed.ok) {
    await appendEvent({
      type: "twilio_voice_calle_callback_claim_skipped",
      ownerUserId: record.ownerUserId || config.ownerUserId,
      recordId: record.id,
      callSid: record.callSid,
      status: record.status,
      reason: claimed.reason,
      alreadyRunning: Boolean(claimed.alreadyRunning),
    }, env).catch(() => {});
    return {
      ok: true,
      duplicate: true,
      alreadyRunning: Boolean(claimed.alreadyRunning),
      reason: claimed.reason,
      record,
    };
  }
  try {
    const started = await startCalleCallbackCall(record, config, env, options);
    if (!started.ok) {
      record = await updateCallbackRecord(record.id, {
        status: "skipped",
        phase: "fallback",
        reason: started.error,
        callStatus: "SKIPPED",
        completedAt: nowIso(),
      }, env);
      return { ok: false, skipped: true, record };
    }
    let latest = started.status || {};
    const initialRuntimeStatus = callbackStatusForCalleStatus(latest.status);
    record = await updateCallbackRecord(record.id, {
      status: initialRuntimeStatus,
      phase: isTerminalStatus(latest.status) ? "terminal" : "poll",
      runId: started.runId,
      callStatus: latest.status,
      summary: latest.summary,
      transcript: latest.transcript,
      retryable: initialRuntimeStatus === "terminal_failed",
      completedAt: isTerminalStatus(latest.status) ? nowIso() : "",
    }, env);
    const interval = pollIntervalMs(config, env, options);
    for (let attempt = 0; attempt < maxPolls(config, env, options) && !isTerminalStatus(latest.status); attempt += 1) {
      if (interval) await delay(interval);
      latest = await getCalleCallbackStatus(started.runId, env, options);
      const runtimeStatus = callbackStatusForCalleStatus(latest.status);
      record = await updateCallbackRecord(record.id, {
        status: runtimeStatus,
        phase: isTerminalStatus(latest.status) ? "terminal" : "poll",
        callStatus: latest.status,
        summary: latest.summary,
        transcript: latest.transcript,
        retryable: runtimeStatus === "terminal_failed",
        completedAt: isTerminalStatus(latest.status) ? nowIso() : "",
      }, env);
    }
    if (isTerminalStatus(latest.status) && normalizeStatus(latest.status) !== "COMPLETED") {
      const error = `calle_call_${normalizeStatus(latest.status).toLowerCase()}`;
      const draft = await createCalleFailureDraft(record, error, config, env, { phase: "terminal" }).catch(() => null);
      record = await updateCallbackRecord(record.id, {
        status: "terminal_failed",
        phase: "terminal",
        error,
        draftId: draft?.id || record.draftId || "",
        retryable: true,
        recovery: failureRecoveryText("terminal", error),
        notifiedAt: draft?.id ? nowIso() : record.notifiedAt,
      }, env);
      await appendEvent({
        type: "twilio_voice_calle_callback_terminal_failed",
        ownerUserId: record.ownerUserId,
        recordId: record.id,
        draftId: draft?.id || null,
        callSid: record.callSid,
        callStatus: latest.status,
        error,
      }, env).catch(() => {});
      return { ok: false, terminal: true, error, record, status: latest };
    }
    if (!isTerminalStatus(latest.status)) {
      const error = "calle_callback_terminal_timeout";
      const draft = await createCalleFailureDraft(record, error, config, env, { phase: "poll_timeout" }).catch(() => null);
      record = await updateCallbackRecord(record.id, {
        status: "timed_out",
        phase: "poll_timeout",
        error,
        draftId: draft?.id || record.draftId || "",
        retryable: true,
        recovery: failureRecoveryText("poll_timeout", error),
        completedAt: nowIso(),
        notifiedAt: draft?.id ? nowIso() : record.notifiedAt,
      }, env);
      await appendEvent({
        type: "twilio_voice_calle_callback_timed_out",
        ownerUserId: record.ownerUserId,
        recordId: record.id,
        draftId: draft?.id || null,
        callSid: record.callSid,
        callStatus: latest.status || "UNKNOWN",
      }, env).catch(() => {});
      return { ok: false, timedOut: true, error, record, status: latest };
    }
    if (!record?.draftId) {
      const draft = await createCalleSummaryDraft(record, latest, config, env);
      record = await updateCallbackRecord(record.id, {
        draftId: draft?.id || "",
        status: "completed",
        phase: "terminal",
        retryable: false,
        notifiedAt: draft?.id ? nowIso() : record.notifiedAt,
      }, env);
      await appendEvent({
        type: "twilio_voice_calle_callback_summary_draft_created",
        ownerUserId: record.ownerUserId,
        recordId: record.id,
        draftId: draft?.id || null,
        callSid: record.callSid,
        callStatus: latest.status,
      }, env).catch(() => {});
    }
    return { ok: true, record, status: latest };
  } catch (error) {
    const phase = record?.phase || "start";
    const draft = await createCalleFailureDraft(record, error, config, env, { phase }).catch(() => null);
    record = await updateCallbackRecord(record.id, {
      status: "failed",
      phase,
      error: safeError(error),
      draftId: draft?.id || "",
      callStatus: "FAILED",
      retryable: true,
      recovery: failureRecoveryText(phase, error),
      completedAt: nowIso(),
      notifiedAt: draft?.id ? nowIso() : record.notifiedAt,
    }, env);
    await appendEvent({
      type: "twilio_voice_calle_callback_failed",
      ownerUserId: record?.ownerUserId || config.ownerUserId,
      recordId: record?.id || recordId,
      callSid: record?.callSid || null,
      phase,
      error: record?.error || safeError(error),
    }, env).catch(() => {});
    return { ok: false, error: safeError(error), record };
  }
}

export async function enqueueTwilioCalleCallback(input = {}, config = {}, env = process.env, options = {}) {
  const reserved = await reserveTwilioCalleCallback(input, config, env);
  if (reserved.duplicate || !reserved.ok) return reserved;
  const runner = () => runTwilioCalleCallback(reserved.record.id, config, env, options);
  if (options.awaitCallback === true) {
    reserved.result = await runner();
  } else {
    const timer = setTimeout(() => {
      void runner().catch((error) => appendEvent({
        type: "twilio_voice_calle_callback_runner_failed",
        ownerUserId: config.ownerUserId,
        recordId: reserved.record.id,
        error: safeError(error),
      }, env).catch(() => {}));
    }, 0);
    if (typeof timer.unref === "function") timer.unref();
  }
  return reserved;
}

function recordAgeMs(record = {}) {
  const timestamp = Date.parse(record.updatedAt || record.createdAt || "");
  return timestamp ? Math.max(0, Date.now() - timestamp) : Number.POSITIVE_INFINITY;
}

function staleStartingMs(env = process.env, options = {}) {
  return Math.max(1000, Number(options.staleStartingMs || env.ORKESTR_TWILIO_CALLBACK_STALE_STARTING_MS || 60_000) || 60_000);
}

function terminalTimeoutMs(env = process.env, options = {}) {
  return Math.max(1000, Number(options.terminalTimeoutMs || env.ORKESTR_TWILIO_CALLBACK_TERMINAL_TIMEOUT_MS || 30 * 60_000) || 30 * 60_000);
}

function scheduleRecoveredCallback(record = {}, config = {}, env = process.env, options = {}) {
  const runner = () => runTwilioCalleCallback(record.id, config, env, options);
  if (options.awaitRecovery === true) return runner();
  const timer = setTimeout(() => {
    void runner().catch((error) => appendEvent({
      type: "twilio_voice_calle_callback_recovery_runner_failed",
      ownerUserId: config.ownerUserId,
      recordId: record.id,
      error: safeError(error),
    }, env).catch(() => {}));
  }, 0);
  if (typeof timer.unref === "function") timer.unref();
  return Promise.resolve({ ok: true, scheduled: true, record });
}

export async function recoverTwilioCalleCallbacks(config = {}, env = process.env, options = {}) {
  const store = await readCallbackStore(env);
  const result = {
    ok: true,
    started: [],
    reconciled: [],
    timedOut: [],
    failed: [],
    skipped: [],
  };
  for (const record of store.callbacks.map(normalizeRecord)) {
    if (record.status === "queued") {
      result.started.push(record.id);
      await scheduleRecoveredCallback(record, config, env, options);
      continue;
    }
    if (record.status === "starting" && recordAgeMs(record) >= staleStartingMs(env, options)) {
      const failure = await markCallbackFailure(record, "calle_callback_start_state_lost", config, env, {
        phase: "start",
        recovery: "Orkestr restarted while CALL-E startup was in an unknown state. No duplicate callback was started automatically; retry manually after checking CALL-E.",
      });
      result.failed.push(failure.record?.id || record.id);
      continue;
    }
    if (record.status !== "in_progress") {
      result.skipped.push({ id: record.id, status: record.status });
      continue;
    }
    if (record.runId && options.reconcileStatus !== false) {
      try {
        const latest = await getCalleCallbackStatus(record.runId, env, options);
        const runtimeStatus = callbackStatusForCalleStatus(latest.status);
        const updated = await updateCallbackRecord(record.id, {
          status: runtimeStatus,
          phase: isTerminalStatus(latest.status) ? "terminal" : "poll",
          callStatus: latest.status,
          summary: latest.summary,
          transcript: latest.transcript,
          retryable: runtimeStatus === "terminal_failed",
          completedAt: isTerminalStatus(latest.status) ? nowIso() : "",
        }, env);
        result.reconciled.push(updated?.id || record.id);
        if (isTerminalStatus(latest.status) && normalizeStatus(latest.status) !== "COMPLETED") {
          const error = `calle_call_${normalizeStatus(latest.status).toLowerCase()}`;
          const failure = await markCallbackFailure(updated || record, error, config, env, {
            phase: "terminal",
            status: "terminal_failed",
            callStatus: latest.status,
            eventType: "twilio_voice_calle_callback_terminal_failed",
          });
          result.failed.push(failure.record?.id || record.id);
        } else if (isTerminalStatus(latest.status) && normalizeStatus(latest.status) === "COMPLETED" && !(updated || record).draftId) {
          const draft = await createCalleSummaryDraft(updated || record, latest, config, env);
          await updateCallbackRecord(record.id, {
            draftId: draft?.id || "",
            status: "completed",
            phase: "terminal",
            retryable: false,
            notifiedAt: draft?.id ? nowIso() : (updated || record).notifiedAt,
          }, env);
        } else if (!isTerminalStatus(latest.status) && recordAgeMs(updated || record) >= terminalTimeoutMs(env, options)) {
          const failure = await markCallbackFailure(updated || record, "calle_callback_terminal_timeout", config, env, {
            phase: "poll_timeout",
            status: "timed_out",
            callStatus: latest.status || "UNKNOWN",
            eventType: "twilio_voice_calle_callback_timed_out",
          });
          result.timedOut.push(failure.record?.id || record.id);
        }
        continue;
      } catch (error) {
        const failure = await markCallbackFailure(record, error, config, env, {
          phase: "reconcile",
          recovery: "Orkestr could not reconcile the stored CALL-E run. Check CALL-E auth/reachability, then retry manually if needed.",
        });
        result.failed.push(failure.record?.id || record.id);
        continue;
      }
    }
    if (recordAgeMs(record) >= terminalTimeoutMs(env, options)) {
      const failure = await markCallbackFailure(record, "calle_callback_terminal_timeout", config, env, {
        phase: "poll_timeout",
        status: "timed_out",
        callStatus: record.callStatus || "UNKNOWN",
        eventType: "twilio_voice_calle_callback_timed_out",
      });
      result.timedOut.push(failure.record?.id || record.id);
    } else {
      result.skipped.push({ id: record.id, status: record.status });
    }
  }
  if (result.started.length || result.failed.length || result.timedOut.length || result.reconciled.length) {
    await appendEvent({
      type: "twilio_voice_calle_callback_recovery_completed",
      ownerUserId: config.ownerUserId,
      started: result.started.length,
      reconciled: result.reconciled.length,
      failed: result.failed.length,
      timedOut: result.timedOut.length,
    }, env).catch(() => {});
  }
  return result;
}

export async function listTwilioCalleCallbacks(env = process.env) {
  const store = await readCallbackStore(env);
  return { callbacks: store.callbacks.map(normalizeRecord) };
}
