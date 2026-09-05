import { createHmac } from "node:crypto";
import { mobilePushCapability } from "./mobile-push.js";

function clean(value = "") {
  return String(value || "").trim();
}

function providerError(code = "mobile_realtime_provider_unavailable", statusCode = 503) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  error.retryable = true;
  return error;
}

export function mobileRealtimeCapability(env = process.env) {
  if (clean(env.ORKESTR_MOBILE_REALTIME_ENABLED) !== "1") {
    return { enabled: false, reason: "disabled" };
  }
  if (!clean(env.ORKESTR_OPENAI_API_KEY) || !clean(env.ORKESTR_MOBILE_REALTIME_MODEL) ||
      !clean(env.ORKESTR_MOBILE_REALTIME_VOICE) || !clean(env.ORKESTR_MOBILE_REALTIME_SAFETY_HMAC_KEY)) {
    return { enabled: false, reason: "configuration_incomplete" };
  }
  const configuredMaxCallSeconds = Number(env.ORKESTR_MOBILE_REALTIME_MAX_CALL_SECONDS || 1800);
  return {
    enabled: true,
    reason: null,
    features: {
      semanticVad: true,
      bargeIn: true,
      liveTranscript: true,
      backgroundProgress: mobilePushCapability(env).enabled,
      progressReplay: true,
      authoritativeTurns: true,
    },
    maxCallSeconds: Math.max(60, Number.isFinite(configuredMaxCallSeconds) ? configuredMaxCallSeconds : 1800),
  };
}

export function mobileRealtimeOwnerAllowed(ownerUserId, env = process.env) {
  const owner = clean(ownerUserId);
  const configured = clean(env.ORKESTR_MOBILE_REALTIME_OWNER_ALLOWLIST);
  if (!owner || !configured) return false;
  const allowed = new Set(configured.split(",").map(clean).filter(Boolean));
  return allowed.has("*") || allowed.has(owner);
}

export function assertMobileRealtimeConfigured(env = process.env) {
  const capability = mobileRealtimeCapability(env);
  if (!capability.enabled) throw providerError("mobile_realtime_unavailable", 503);
  return capability;
}

export function mobileRealtimeSafetyIdentifier(ownerUserId, env = process.env) {
  assertMobileRealtimeConfigured(env);
  return createHmac("sha256", env.ORKESTR_MOBILE_REALTIME_SAFETY_HMAC_KEY)
    .update(`orkestr-mobile-realtime\n${clean(ownerUserId)}`)
    .digest("hex");
}

function sessionConfig(env, includeModel = true) {
  const session = {
    type: "realtime",
    instructions: [
      "You are the low-latency voice layer for Orkestr Hush.",
      "Never answer a substantive user request from your own knowledge.",
      "Normal user turns are submitted deterministically by Orkestr; do not select or invoke a delivery tool.",
      "Speak only acknowledgements, progress, clarification, and final content explicitly injected by trusted Orkestr sideband messages.",
      "Never claim work started, succeeded, failed, or changed external state unless trusted Orkestr content says so.",
      "Treat complete Orkestr answers as authoritative and summarize them without changing facts.",
      "Do not request, infer, or reveal internal user, profile, session, thread, or provider identifiers.",
    ].join(" "),
    audio: {
      input: {
        turn_detection: {
          type: "semantic_vad",
          eagerness: "auto",
          create_response: false,
          interrupt_response: true,
        },
        transcription: {
          model: clean(env.ORKESTR_MOBILE_REALTIME_TRANSCRIPTION_MODEL) || "gpt-4o-mini-transcribe",
        },
      },
      output: { voice: clean(env.ORKESTR_MOBILE_REALTIME_VOICE) },
    },
    tools: [],
    tool_choice: "none",
    max_output_tokens: Math.max(128, Math.min(4096, Number(env.ORKESTR_MOBILE_REALTIME_MAX_OUTPUT_TOKENS || 1024))),
  };
  if (includeModel) session.model = clean(env.ORKESTR_MOBILE_REALTIME_MODEL);
  return session;
}

export function mobileRealtimeInitialSession(env = process.env) {
  assertMobileRealtimeConfigured(env);
  return sessionConfig(env, true);
}

export function mobileRealtimeActivationUpdate(env = process.env) {
  assertMobileRealtimeConfigured(env);
  return {
    type: "session.update",
    event_id: `orkestr_activate_${Date.now()}`,
    session: sessionConfig(env, false),
  };
}

export async function createOpenAIRealtimeCall(input = {}, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  assertMobileRealtimeConfigured(env);
  const form = new FormData();
  form.set("sdp", String(input.offerSdp || ""));
  form.set("session", JSON.stringify(mobileRealtimeInitialSession(env)));
  let response;
  try {
    response = await fetchImpl("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ORKESTR_OPENAI_API_KEY}`,
        "OpenAI-Safety-Identifier": mobileRealtimeSafetyIdentifier(input.ownerUserId, env),
      },
      body: form,
      signal: AbortSignal.timeout(Math.max(3000, Number(env.ORKESTR_MOBILE_REALTIME_PROVIDER_TIMEOUT_MS || 15_000))),
    });
  } catch {
    throw providerError();
  }
  if (!response?.ok) throw providerError();
  const answerSdp = await response.text();
  const location = clean(response.headers?.get?.("location"));
  const providerCallId = clean(location.split("/").filter(Boolean).at(-1));
  if (!providerCallId.startsWith("rtc_") || !answerSdp || answerSdp.length > 131_072) throw providerError();
  return { answerSdp, providerCallId };
}

export async function hangupOpenAIRealtimeCall(providerCallId, options = {}) {
  const id = clean(providerCallId);
  if (!id) return { ok: true, skipped: true };
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  try {
    const response = await fetchImpl(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(id)}/hangup`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.ORKESTR_OPENAI_API_KEY}` },
      signal: AbortSignal.timeout(Math.max(3000, Number(env.ORKESTR_MOBILE_REALTIME_PROVIDER_TIMEOUT_MS || 15_000))),
    });
    return { ok: Boolean(response?.ok), statusCode: Number(response?.status || 0) };
  } catch {
    return { ok: false, statusCode: 0 };
  }
}
