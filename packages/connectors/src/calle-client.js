import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  clean,
  cleanText,
  isCallablePhone,
  normalizePhone,
  normalizeStatus,
} from "./calle-callback-store.js";

const execFileAsync = promisify(execFile);
const calleEnv = {
  CALLE_SOURCE: "skills_sh",
  CALLE_INTEGRATION: "skills_sh_skill",
  CALLE_INTEGRATION_VERSION: "0.1.0",
};

export function safeError(error) {
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
  if (!isCallablePhone(record.caller)) return { ok: false, error: "caller_phone_not_callable" };
  if (!clean(config.calleGoal) || config.calleGoalConfigured === false) {
    return { ok: false, error: "twilio_voice_calle_goal_required" };
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
  return { ok: true, runId: clean(payload.run_id || payload.runId || status.runId), status };
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
