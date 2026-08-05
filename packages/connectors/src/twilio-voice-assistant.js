import { randomUUID } from "node:crypto";
import { createOrkestrMailDraftForPrincipal } from "../../core/src/mail-drafts.js";
import { adminPrincipal } from "../../core/src/principal.js";
import { resolveSecureSecretValue } from "../../core/src/secure-secrets.js";
import { adminUserId, normalizeUserId } from "../../core/src/users.js";
import { appendEvent } from "../../storage/src/store.js";
import { enqueueTwilioCalleCallback } from "./calle-callback.js";

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

function sanitizeText(value = "", max = 4000) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function normalizeVoiceMode(value = "") {
  const text = clean(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (["calle", "call_e", "call_e_callback", "calle_callback"].includes(text)) return "calle_callback";
  return "twilio_native";
}

function normalizeOptionalLanguage(value = "") {
  const text = clean(value);
  if (!text) return "";
  return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(text) ? text : "";
}

function positiveInteger(value, fallback, max = 240) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function defaultCalleGoal(label = "Orkestr assistant") {
  return [
    `You are ${label}, the account owner's CALL-E phone assistant.`,
    "Call the person back in German.",
    "Briefly explain that you are the account owner's assistant, ask for their name, why they called, urgency, and the best way for the account owner to respond.",
    "Be warm, concise, and practical. Do not pretend to be the account owner. Do not collect sensitive secrets or payment details.",
    "At the end, summarize the next action clearly so Orkestr can email the account owner a useful call summary.",
  ].join(" ");
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
  const mode = normalizeVoiceMode(
    options.mode ||
    envFirst(env, ["ORKESTR_TWILIO_VOICE_MODE", "TWILIO_VOICE_MODE"]) ||
    await resolveConfigSecret("twilio/voice-mode", ["twilio_voice_mode", "twilio-voice-mode"], { ownerUserId }, env),
  );
  const calleGoal = sanitizeText(
    options.calleGoal ||
    envFirst(env, ["ORKESTR_TWILIO_VOICE_CALLE_GOAL", "TWILIO_VOICE_CALLE_GOAL"]) ||
    await resolveConfigSecret("twilio/voice-calle-goal", ["twilio_voice_calle_goal", "twilio-voice-calle-goal"], { ownerUserId }, env) ||
    defaultCalleGoal(assistantLabel),
  );
  const calleLanguage = sanitizeLine(
    options.calleLanguage ||
    envFirst(env, ["ORKESTR_TWILIO_VOICE_CALLE_LANGUAGE", "TWILIO_VOICE_CALLE_LANGUAGE"]) ||
    await resolveConfigSecret("twilio/voice-calle-language", ["twilio_voice_calle_language", "twilio-voice-calle-language"], { ownerUserId }, env) ||
    "German",
  );
  const calleRegion = sanitizeLine(
    options.calleRegion ||
    envFirst(env, ["ORKESTR_TWILIO_VOICE_CALLE_REGION", "TWILIO_VOICE_CALLE_REGION"]) ||
    await resolveConfigSecret("twilio/voice-calle-region", ["twilio_voice_calle_region", "twilio-voice-calle-region"], { ownerUserId }, env) ||
    "DE",
  );
  const introMessage = sanitizeText(
    options.introMessage ||
    envFirst(env, ["ORKESTR_TWILIO_VOICE_INTRO_MESSAGE", "TWILIO_VOICE_INTRO_MESSAGE"]) ||
    await resolveConfigSecret("twilio/voice-intro-message", ["twilio_voice_intro_message", "twilio-voice-intro-message"], { ownerUserId }, env),
    2000,
  );
  const introMessageEnglish = sanitizeText(
    options.introMessageEnglish ||
    options.introMessageEn ||
    envFirst(env, ["ORKESTR_TWILIO_VOICE_INTRO_MESSAGE_EN", "TWILIO_VOICE_INTRO_MESSAGE_EN"]) ||
    await resolveConfigSecret("twilio/voice-intro-message-en", ["twilio_voice_intro_message_en", "twilio-voice-intro-message-en"], { ownerUserId }, env),
    2000,
  );
  const englishLanguage = normalizeOptionalLanguage(
    options.englishLanguage ||
    envFirst(env, ["ORKESTR_TWILIO_VOICE_ENGLISH_LANGUAGE", "TWILIO_VOICE_ENGLISH_LANGUAGE"]) ||
    await resolveConfigSecret("twilio/voice-english-language", ["twilio_voice_english_language", "twilio-voice-english-language"], { ownerUserId }, env),
  ) || "en-US";
  return {
    ownerUserId,
    mode,
    webhookToken,
    summaryTo,
    assistantLabel,
    language: normalizeLanguage(options.language || envFirst(env, ["ORKESTR_TWILIO_VOICE_LANGUAGE", "TWILIO_VOICE_LANGUAGE"])),
    englishLanguage,
    publicBaseUrl: publicBaseUrl || publicBaseUrlFromInput(options, env),
    introMessage,
    introMessageEnglish,
    calleGoal,
    calleLanguage,
    calleRegion,
    calleMaxPolls: positiveInteger(options.calleMaxPolls ?? envFirst(env, ["ORKESTR_TWILIO_VOICE_CALLE_MAX_POLLS", "TWILIO_VOICE_CALLE_MAX_POLLS"]), 90),
    callePollIntervalMs: positiveInteger(options.callePollIntervalMs ?? envFirst(env, ["ORKESTR_TWILIO_VOICE_CALLE_POLL_INTERVAL_MS", "TWILIO_VOICE_CALLE_POLL_INTERVAL_MS"]), 10_000, 60_000),
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
  const englishLanguage = normalizeOptionalLanguage(config.englishLanguage) || "en-US";
  const label = clean(config.assistantLabel) || "Orkestr assistant";
  const prompt = sanitizeText(config.introMessage, 2000) || `Hallo, hier ist ${label}. Die gewünschte Person ist gerade nicht direkt am Telefon. Sagen Sie mir bitte kurz Ihren Namen, warum Sie anrufen, und wie sie Sie erreichen kann. Ich notiere Ihre Nachricht.`;
  const englishPrompt = sanitizeText(config.introMessageEnglish, 2000);
  const sayPrompts = [
    `<Say language="${xmlEscape(language)}">${xmlEscape(prompt)}</Say>`,
    englishPrompt ? `<Say language="${xmlEscape(englishLanguage)}">${xmlEscape(englishPrompt)}</Say>` : "",
  ].filter(Boolean).join("");
  return twimlResponse([
    `<Gather input="speech" action="${xmlEscape(urls.gather)}" method="POST" language="${xmlEscape(language)}" speechTimeout="auto" timeout="12" actionOnEmptyResult="true">`,
    sayPrompts,
    "</Gather>",
    `<Say language="${xmlEscape(language)}">Danke. Ich habe den Anruf notiert.</Say>`,
  ].join(""));
}

function twilioVoiceThanksTwiml(config = {}, options = {}) {
  const language = normalizeLanguage(config.language);
  const message = options.hasSpeech
    ? "Danke. Ich habe Ihre Nachricht aufgenommen und leite die Zusammenfassung weiter."
    : "Danke. Ich konnte Ihre Nachricht nicht sicher verstehen, aber ich habe den Anruf notiert und leite ihn weiter.";
  return twimlResponse(
    `<Say language="${xmlEscape(language)}">${xmlEscape(message)}</Say>`,
  );
}

function twilioVoiceUnavailableTwiml(config = {}) {
  const language = normalizeLanguage(config.language);
  return twimlResponse(
    `<Say language="${xmlEscape(language)}">Der Assistent ist gerade nicht erreichbar. Bitte versuchen Sie es später erneut.</Say>`,
  );
}

function twilioVoiceCalleCallbackTwiml(config = {}, callback = {}) {
  const language = normalizeLanguage(config.language);
  const label = clean(config.assistantLabel) || "Orkestr assistant";
  const message = callback?.record?.reason === "caller_phone_not_callable"
    ? `Hallo, hier ist ${label}. Der CALL-E Assistent kann Sie ohne erkannte Telefonnummer gerade nicht zurückrufen. Bitte schreiben Sie der gewünschten Person kurz per Nachricht.`
    : callback?.duplicate
      ? `Hallo, hier ist ${label}. Der CALL-E Assistent wurde für diesen Anruf bereits gestartet. Sie erhalten gleich einen Rückruf.`
      : `Hallo, hier ist ${label}. Mein CALL-E Assistent ruft Sie gleich zurück und nimmt Ihr Anliegen auf. Bitte nehmen Sie den Rückruf an.`;
  return twimlResponse([
    `<Say language="${xmlEscape(language)}">${xmlEscape(message)}</Say>`,
    "<Hangup/>",
  ].join(""));
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
  const hasSpeech = Boolean(speech);
  const reason = speech || "No speech was captured. The caller may have stayed silent, spoken before capture began, or Twilio speech recognition may not have understood the audio.";
  const subject = hasSpeech ? `Call summary: ${caller}` : `Missed assistant call: ${caller}`;
  const body = [
    "A caller reached your Twilio assistant line.",
    "",
    `Caller: ${caller}`,
    `Called line: ${called}`,
    `Call SID: ${callSid}`,
    `Time: ${now}`,
    confidence ? `Speech confidence: ${confidence}` : "",
    "",
    hasSpeech ? "Caller message:" : "Captured message:",
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
    hasSpeech,
  }, env).catch(() => {});
  return {
    ok: true,
    draft: draftResult.draft,
    twiml: twilioVoiceThanksTwiml(config, { hasSpeech }),
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
  if (verified.config.mode === "calle_callback") {
    const callback = await enqueueTwilioCalleCallback(options.body || options.input || options.twilioBody || {}, verified.config, env, options);
    return { ok: true, twiml: twilioVoiceCalleCallbackTwiml(verified.config, callback), config: verified.config, callback };
  }
  return { ok: true, twiml: twilioVoiceIncomingTwiml(verified.config), config: verified.config };
}
