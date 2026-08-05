import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createOrkestrMailDraftForPrincipal } from "../../core/src/mail-drafts.js";
import { adminPrincipal } from "../../core/src/principal.js";
import { adminUserId, normalizeUserId } from "../../core/src/users.js";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";

const execFileAsync = promisify(execFile);
const calleEnv = {
  CALLE_SOURCE: "skills_sh",
  CALLE_INTEGRATION: "skills_sh_skill",
  CALLE_INTEGRATION_VERSION: "0.1.0",
};
const terminalStatuses = new Set(["COMPLETED", "FAILED", "NO_ANSWER", "DECLINED", "CANCELED", "CANCELLED", "VOICEMAIL", "BUSY", "EXPIRED"]);

function clean(value = "") {
  return String(value || "").trim();
}

function cleanText(value = "", max = 20_000) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function nowIso() {
  return new Date().toISOString();
}

function callbackStorePath(env = process.env) {
  return dataPaths(env).twilioVoiceCallbacks;
}

function normalizePhone(value = "") {
  const text = clean(value);
  if (!text || /^(anonymous|unknown|restricted)$/i.test(text)) return "";
  return text.replace(/[^\d+]/g, "");
}

function isCallablePhone(value = "") {
  return /^\+\d{7,18}$/.test(normalizePhone(value));
}

function normalizeStatus(value = "") {
  const status = clean(value).toUpperCase();
  return status || "UNKNOWN";
}

function isTerminalStatus(value = "") {
  return terminalStatuses.has(normalizeStatus(value));
}

function normalizeRecord(record = {}) {
  const createdAt = clean(record.createdAt) || nowIso();
  return {
    id: clean(record.id) || randomUUID(),
    ownerUserId: normalizeUserId(record.ownerUserId || record.userId || adminUserId),
    callSid: clean(record.callSid),
    caller: normalizePhone(record.caller),
    called: normalizePhone(record.called),
    status: clean(record.status) || "queued",
    reason: clean(record.reason).slice(0, 500),
    runId: clean(record.runId),
    callStatus: normalizeStatus(record.callStatus),
    summary: cleanText(record.summary, 5000),
    transcript: cleanText(record.transcript, 20_000),
    draftId: clean(record.draftId),
    error: clean(record.error).slice(0, 500),
    createdAt,
    updatedAt: clean(record.updatedAt) || createdAt,
    completedAt: clean(record.completedAt),
  };
}

function normalizeStore(payload = {}) {
  const callbacks = Array.isArray(payload.callbacks) ? payload.callbacks.map(normalizeRecord) : [];
  return {
    schemaVersion: 1,
    callbacks,
  };
}

async function readCallbackStore(env = process.env) {
  return normalizeStore(await readJson(callbackStorePath(env), { schemaVersion: 1, callbacks: [] }));
}

async function writeCallbackStore(store = {}, env = process.env) {
  const callbacks = Array.isArray(store.callbacks) ? store.callbacks.map(normalizeRecord).slice(0, 500) : [];
  await writeJson(callbackStorePath(env), {
    schemaVersion: 1,
    callbacks,
    updatedAt: nowIso(),
  });
}

function callInput(input = {}) {
  return {
    caller: normalizePhone(input.From || input.from || input.Caller || input.caller),
    called: normalizePhone(input.To || input.to || input.Called || input.called),
    callSid: clean(input.CallSid || input.callSid || input.CallUUID || input.callUuid),
  };
}

function safeError(error) {
  const payloadCode = clean(error?.payload?.error?.code || error?.payload?.code);
  const payloadMessage = clean(error?.payload?.error?.message || error?.payload?.message);
  return clean(payloadCode || payloadMessage || error?.code || error?.message || error || "calle_callback_failed").slice(0, 500);
}

function parseJsonOutput(raw = "") {
  const text = clean(raw);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    const wrapped = new Error("calle_invalid_json");
    wrapped.cause = error;
    throw wrapped;
  }
}

async function execCalleJson(args = [], env = process.env, options = {}) {
  const command = clean(options.command || env.ORKESTR_CALLE_COMMAND || "calle");
  const execImpl = options.execFileAsync || execFileAsync;
  const timeout = Math.max(1000, Number(options.timeoutMs || env.ORKESTR_CALLE_COMMAND_TIMEOUT_MS || 120_000) || 120_000);
  try {
    const result = await execImpl(command, args, {
      env: { ...process.env, ...env, ...calleEnv },
      timeout,
      maxBuffer: Math.max(1024 * 1024, Number(env.ORKESTR_CALLE_MAX_BUFFER_BYTES || 4 * 1024 * 1024) || 4 * 1024 * 1024),
    });
    return parseJsonOutput(result?.stdout || "");
  } catch (error) {
    const payload = parseJsonOutput(error?.stdout || "");
    const wrapped = new Error(clean(payload?.error?.code || payload?.error?.message || error?.message || "calle_command_failed"));
    wrapped.payload = payload;
    wrapped.cause = error;
    throw wrapped;
  }
}

function structuredContent(payload = {}, key = "status_result") {
  return (
    payload?.[key]?.structuredContent ||
    payload?.status_result?.structuredContent ||
    payload?.statusResult?.structuredContent ||
    payload?.result?.structuredContent ||
    payload?.structuredContent ||
    {}
  );
}

function publicCalleStatus(status = {}) {
  const extracted = status.extracted && typeof status.extracted === "object" ? status.extracted : {};
  const calling = extracted.calling && typeof extracted.calling === "object" ? extracted.calling : {};
  return {
    status: normalizeStatus(status.status || status.call_status || status.state),
    message: cleanText(status.message, 1000),
    summary: cleanText(status.post_summary || status.summary || status.message, 5000),
    transcript: cleanText(status.transcript, 20_000),
    callId: clean(status.call_id || status.callId),
    callee: clean(extracted.to_phones?.[0] || calling.callee),
    durationSeconds: clean(calling.duration_seconds || calling.durationSeconds),
    startedAt: clean(calling.started_at || calling.startedAt),
    endedAt: clean(calling.ended_at || calling.endedAt),
  };
}

export async function startCalleCallbackCall(record = {}, config = {}, env = process.env, options = {}) {
  if (!isCallablePhone(record.caller)) {
    return { ok: false, error: "caller_phone_not_callable" };
  }
  const args = [
    "call",
    "start",
    "--to-phone",
    normalizePhone(record.caller),
    "--goal",
    cleanText(config.calleGoal, 4000),
  ];
  if (clean(config.calleLanguage)) args.push("--language", clean(config.calleLanguage));
  if (clean(config.calleRegion)) args.push("--region", clean(config.calleRegion));
  const payload = await execCalleJson(args, env, options);
  if (payload?.ok === false) {
    const error = new Error(clean(payload?.error?.code || payload?.error?.message || "calle_call_start_failed"));
    error.payload = payload;
    throw error;
  }
  const status = publicCalleStatus(structuredContent(payload, "status_result"));
  return {
    ok: true,
    runId: clean(payload.run_id || payload.runId || status.runId),
    status,
  };
}

export async function getCalleCallbackStatus(runId = "", env = process.env, options = {}) {
  const id = clean(runId);
  if (!id) throw new Error("calle_run_id_required");
  const payload = await execCalleJson(["call", "status", "--run-id", id], env, options);
  if (payload?.ok === false) {
    const error = new Error(clean(payload?.error?.code || payload?.error?.message || "calle_call_status_failed"));
    error.payload = payload;
    throw error;
  }
  return publicCalleStatus(structuredContent(payload, "result"));
}

async function upsertCallbackRecord(record = {}, env = process.env) {
  const normalized = normalizeRecord({ ...record, updatedAt: nowIso() });
  const store = await readCallbackStore(env);
  const index = store.callbacks.findIndex((item) => item.id === normalized.id);
  if (index >= 0) store.callbacks[index] = normalized;
  else store.callbacks.unshift(normalized);
  await writeCallbackStore(store, env);
  return normalized;
}

async function updateCallbackRecord(recordId = "", patch = {}, env = process.env) {
  const store = await readCallbackStore(env);
  const index = store.callbacks.findIndex((item) => item.id === clean(recordId));
  if (index < 0) return null;
  const record = normalizeRecord({ ...store.callbacks[index], ...patch, updatedAt: nowIso() });
  store.callbacks[index] = record;
  await writeCallbackStore(store, env);
  return record;
}

export async function reserveTwilioCalleCallback(input = {}, config = {}, env = process.env) {
  const parsed = callInput(input);
  const ownerUserId = normalizeUserId(config.ownerUserId || adminUserId);
  const callSid = parsed.callSid || `twilio-${randomUUID()}`;
  const store = await readCallbackStore(env);
  const duplicate = store.callbacks.find((record) => record.ownerUserId === ownerUserId && record.callSid === callSid);
  if (duplicate) {
    return { ok: true, duplicate: true, record: duplicate };
  }
  const record = normalizeRecord({
    ownerUserId,
    callSid,
    caller: parsed.caller,
    called: parsed.called,
    status: isCallablePhone(parsed.caller) ? "queued" : "skipped",
    reason: isCallablePhone(parsed.caller) ? "" : "caller_phone_not_callable",
  });
  store.callbacks.unshift(record);
  await writeCallbackStore(store, env);
  await appendEvent({
    type: "twilio_voice_calle_callback_reserved",
    ownerUserId,
    recordId: record.id,
    callSid: record.callSid,
    status: record.status,
    reason: record.reason || null,
  }, env).catch(() => {});
  return { ok: record.status !== "skipped", duplicate: false, record };
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

async function createCalleFailureDraft(record = {}, error, config = {}, env = process.env) {
  if (!clean(config.summaryTo)) return null;
  const body = [
    "A caller reached your Twilio assistant line, but Orkestr could not start the CALL-E callback.",
    "",
    `Caller: ${record.caller || "Unknown caller"}`,
    `Called line: ${record.called || "Unknown line"}`,
    `Twilio Call SID: ${record.callSid || "Not available"}`,
    `Error: ${safeError(error)}`,
    "",
    "Suggested next step:",
    "Check CALL-E authentication on the server, then call the person back manually if needed.",
  ].join("\n");
  const draftResult = await createOrkestrMailDraftForPrincipal({
    ownerUserId: config.ownerUserId,
    to: [config.summaryTo],
    subject: `CALL-E callback failed: ${record.caller || "unknown caller"}`,
    body,
  }, adminPrincipal(config.ownerUserId), env);
  return draftResult.draft;
}

export async function runTwilioCalleCallback(recordId = "", config = {}, env = process.env, options = {}) {
  let record = await updateCallbackRecord(recordId, { status: "starting", error: "", reason: "" }, env);
  if (!record) throw new Error("twilio_calle_callback_not_found");
  try {
    const started = await startCalleCallbackCall(record, config, env, options);
    if (!started.ok) {
      record = await updateCallbackRecord(record.id, { status: "skipped", reason: started.error, callStatus: "SKIPPED" }, env);
      return { ok: false, skipped: true, record };
    }
    let latest = started.status || {};
    record = await updateCallbackRecord(record.id, {
      status: isTerminalStatus(latest.status) ? "completed" : "in_progress",
      runId: started.runId,
      callStatus: latest.status,
      summary: latest.summary,
      transcript: latest.transcript,
      completedAt: isTerminalStatus(latest.status) ? nowIso() : "",
    }, env);
    const interval = pollIntervalMs(config, env, options);
    for (let attempt = 0; attempt < maxPolls(config, env, options) && !isTerminalStatus(latest.status); attempt += 1) {
      if (interval) await delay(interval);
      latest = await getCalleCallbackStatus(started.runId, env, options);
      record = await updateCallbackRecord(record.id, {
        status: isTerminalStatus(latest.status) ? "completed" : "in_progress",
        callStatus: latest.status,
        summary: latest.summary,
        transcript: latest.transcript,
        completedAt: isTerminalStatus(latest.status) ? nowIso() : "",
      }, env);
    }
    if (isTerminalStatus(latest.status) && !record?.draftId) {
      const draft = await createCalleSummaryDraft(record, latest, config, env);
      record = await updateCallbackRecord(record.id, { draftId: draft?.id || "", status: "completed" }, env);
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
    const draft = await createCalleFailureDraft(record, error, config, env).catch(() => null);
    record = await updateCallbackRecord(record.id, {
      status: "failed",
      error: safeError(error),
      draftId: draft?.id || "",
      callStatus: "FAILED",
      completedAt: nowIso(),
    }, env);
    await appendEvent({
      type: "twilio_voice_calle_callback_failed",
      ownerUserId: record?.ownerUserId || config.ownerUserId,
      recordId: record?.id || recordId,
      callSid: record?.callSid || null,
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

export async function listTwilioCalleCallbacks(env = process.env) {
  const store = await readCallbackStore(env);
  return { callbacks: store.callbacks.map(normalizeRecord) };
}
