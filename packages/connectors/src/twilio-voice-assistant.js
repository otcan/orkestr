import { randomUUID } from "node:crypto";
import { createOrkestrMailDraftForPrincipal } from "../../core/src/mail-drafts.js";
import { adminPrincipal } from "../../core/src/principal.js";
import { resolveSecureSecretValue } from "../../core/src/secure-secrets.js";
import { adminUserId, normalizeUserId } from "../../core/src/users.js";
import { appendEvent } from "../../storage/src/store.js";

function clean(value = "") {
  return String(value || "").trim();
}

function envFirst(env = process.env, names = []) {
  for (const name of names) {
    const value = clean(env[name]);
    if (value) return value;
  }
  return "";
}

function xmlEscape(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeLanguage(value = "") {
  const text = clean(value) || "de-DE";
  return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(text) ? text : "de-DE";
}

function normalizeToken(value = "") {
  return clean(value)
    .replace(/[^A-Za-z0-9._~-]+/g, "")
    .slice(0, 180);
}

function sanitizeLine(value = "") {
  return String(value || "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function publicBaseUrlFromInput(input = {}, env = process.env) {
  const configured = clean(input.publicBaseUrl || env.ORKESTR_TWILIO_VOICE_PUBLIC_URL || env.ORKESTR_PUBLIC_APP_URL || env.ORKESTR_APP_URL || env.ORKESTR_PUBLIC_URL);
  if (configured) return configured.replace(/\/+$/g, "");
  const protocol = clean(input.protocol || input.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim() || "https";
  const host = clean(input.host || input.headers?.["x-forwarded-host"] || input.headers?.host);
  return host ? `${protocol}://${host}`.replace(/\/+$/g, "") : "";
}

async function resolveConfigSecret(name, fallbackNames = [], options = {}, env = process.env) {
  const ownerUserId = normalizeUserId(options.ownerUserId || options.userId || env.ORKESTR_TWILIO_VOICE_OWNER_USER_ID || env.ORKESTR_ADMIN_USER_ID || adminUserId);
  for (const secretName of [name, ...fallbackNames]) {
    const resolved = await resolveSecureSecretValue(secretName, {
      ownerUserId,
      usedBy: "twilio-voice-assistant",
    }, env);
    if (clean(resolved?.value)) return clean(resolved.value);
  }
  return "";
}

export async function twilioVoiceAssistantConfig(options = {}, env = process.env) {
  const ownerUserId = normalizeUserId(options.ownerUserId || options.userId || env.ORKESTR_TWILIO_VOICE_OWNER_USER_ID || env.ORKESTR_ADMIN_USER_ID || adminUserId);
  const publicBaseUrl = clean(
    options.publicBaseUrl ||
    envFirst(env, ["ORKESTR_TWILIO_VOICE_PUBLIC_URL", "TWILIO_VOICE_PUBLIC_URL"]) ||
    await resolveConfigSecret("twilio/voice-public-url", ["twilio_voice_public_url", "twilio-voice-public-url"], { ownerUserId }, env),
  );
  const webhookToken = normalizeToken(
    clean(options.webhookToken) ||
    envFirst(env, ["ORKESTR_TWILIO_VOICE_WEBHOOK_TOKEN", "TWILIO_VOICE_WEBHOOK_TOKEN"]) ||
    await resolveConfigSecret("twilio/voice-webhook-token", ["twilio_voice_webhook_token", "twilio-voice-webhook-token"], { ownerUserId }, env),
  );
  const summaryTo = clean(
    options.summaryTo ||
    envFirst(env, ["ORKESTR_TWILIO_VOICE_SUMMARY_TO", "TWILIO_VOICE_SUMMARY_TO"]) ||
    await resolveConfigSecret("twilio/voice-summary-to", ["twilio_voice_summary_to", "twilio-voice-summary-to"], { ownerUserId }, env),
  );
  const assistantLabel = sanitizeLine(
    options.assistantLabel ||
    envFirst(env, ["ORKESTR_TWILIO_VOICE_ASSISTANT_LABEL", "TWILIO_VOICE_ASSISTANT_LABEL"]) ||
    await resolveConfigSecret("twilio/voice-assistant-label", ["twilio_voice_assistant_label", "twilio-voice-assistant-label"], { ownerUserId }, env) ||
    "Orkestr assistant",
  );
  return {
    ownerUserId,
    webhookToken,
    summaryTo,
    assistantLabel,
    language: normalizeLanguage(options.language || envFirst(env, ["ORKESTR_TWILIO_VOICE_LANGUAGE", "TWILIO_VOICE_LANGUAGE"])),
    publicBaseUrl: publicBaseUrl || publicBaseUrlFromInput(options, env),
  };
}

export function twilioVoiceWebhookUrls(config = {}) {
  const base = clean(config.publicBaseUrl).replace(/\/+$/g, "");
  const token = encodeURIComponent(normalizeToken(config.webhookToken));
  const root = `${base}/api/connectors/twilio/voice/${token}`;
  return {
    incoming: `${root}/incoming`,
    gather: `${root}/gather`,
  };
}

function twimlResponse(inner = "") {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

export function twilioVoiceIncomingTwiml(config = {}) {
  const urls = twilioVoiceWebhookUrls(config);
  const language = normalizeLanguage(config.language);
  const label = clean(config.assistantLabel) || "Orkestr assistant";
  const prompt = `Hallo, hier ist ${label}. Bitte sagen Sie kurz, warum Sie anrufen. Ich fasse die Nachricht per E-Mail zusammen.`;
  return twimlResponse([
    `<Gather input="speech" action="${xmlEscape(urls.gather)}" method="POST" language="${xmlEscape(language)}" speechTimeout="auto" timeout="5">`,
    `<Say language="${xmlEscape(language)}">${xmlEscape(prompt)}</Say>`,
    "</Gather>",
    `<Say language="${xmlEscape(language)}">Ich habe leider nichts gehört. Bitte rufen Sie später erneut an.</Say>`,
  ].join(""));
}

function twilioVoiceThanksTwiml(config = {}) {
  const language = normalizeLanguage(config.language);
  return twimlResponse(
    `<Say language="${xmlEscape(language)}">Danke. Ich habe Ihre Nachricht aufgenommen und fasse sie weiter.</Say>`,
  );
}

function twilioVoiceUnavailableTwiml(config = {}) {
  const language = normalizeLanguage(config.language);
  return twimlResponse(
    `<Say language="${xmlEscape(language)}">Der Assistent ist gerade nicht erreichbar. Bitte versuchen Sie es später erneut.</Say>`,
  );
}

export async function verifyTwilioVoiceWebhookToken(token = "", options = {}, env = process.env) {
  const config = await twilioVoiceAssistantConfig(options, env);
  if (!config.webhookToken) return { ok: false, statusCode: 503, error: "twilio_voice_webhook_token_missing", config };
  if (normalizeToken(token) !== config.webhookToken) return { ok: false, statusCode: 403, error: "twilio_voice_webhook_token_invalid", config };
  return { ok: true, config };
}

export async function createTwilioVoiceSummaryDraft(input = {}, options = {}, env = process.env) {
  const config = await twilioVoiceAssistantConfig(options, env);
  if (!config.summaryTo) {
    return {
      ok: false,
      error: "twilio_voice_summary_to_missing",
      twiml: twilioVoiceUnavailableTwiml(config),
    };
  }
  const speech = sanitizeLine(input.SpeechResult || input.speechResult || input.TranscriptionText || input.transcriptionText);
  const caller = sanitizeLine(input.From || input.from || "Unknown caller");
  const called = sanitizeLine(input.To || input.to || "Unknown line");
  const callSid = sanitizeLine(input.CallSid || input.callSid || `call-${randomUUID()}`);
  const confidence = sanitizeLine(input.Confidence || input.confidence);
  const now = new Date().toISOString();
  const reason = speech || "No speech was captured.";
  const subject = `Call summary: ${caller}`;
  const body = [
    "A caller reached your Twilio assistant line.",
    "",
    `Caller: ${caller}`,
    `Called line: ${called}`,
    `Call SID: ${callSid}`,
    `Time: ${now}`,
    confidence ? `Speech confidence: ${confidence}` : "",
    "",
    "Caller message:",
    reason,
    "",
    "Suggested next step:",
    "Review the message and call or message the person back if needed.",
  ].filter((line) => line !== "").join("\n");

  const draftResult = await createOrkestrMailDraftForPrincipal({
    ownerUserId: config.ownerUserId,
    to: [config.summaryTo],
    subject,
    body,
  }, adminPrincipal(config.ownerUserId), env);
  await appendEvent({
    type: "twilio_voice_summary_draft_created",
    ownerUserId: config.ownerUserId,
    draftId: draftResult.draft.id,
    callSid,
    hasSpeech: Boolean(speech),
  }, env).catch(() => {});
  return {
    ok: true,
    draft: draftResult.draft,
    twiml: twilioVoiceThanksTwiml(config),
  };
}

export async function twilioVoiceIncomingResponse(token = "", options = {}, env = process.env) {
  const verified = await verifyTwilioVoiceWebhookToken(token, options, env);
  if (!verified.ok) {
    return {
      ok: false,
      statusCode: verified.statusCode,
      error: verified.error,
      twiml: twilioVoiceUnavailableTwiml(verified.config || {}),
    };
  }
  return { ok: true, twiml: twilioVoiceIncomingTwiml(verified.config), config: verified.config };
}
