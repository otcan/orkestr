import fs from "node:fs/promises";
import { readConnectorConfig } from "../../storage/src/config.js";
import { listCreditUsageRecords, recordCreditUsage } from "./credit-usage.js";
import { consumeDurableRateLimit, positiveIntegerEnv } from "./durable-rate-limit.js";
import { resolveSecureSecretValue } from "./secure-secrets.js";
import { splitCommaList } from "./voice-transcription-glossary.js";

// OpenAI speech-to-text for inbound voice notes. Errors are reported as short
// value-free codes only: never a key, transcript, file name, or response body.

export const TRANSCRIPTION_CALL_KIND = "voice_transcription";
export const TRANSCRIPTION_SECRET_NAME = "openai_api_key";
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;
const DEFAULT_MODEL = "gpt-transcribe";
const DEFAULT_LANGUAGES = "en,tr,de";
const DEFAULT_PRICE_PER_MINUTE_USD = { "gpt-transcribe": 0.0045, "gpt-4o-transcribe-diarize": 0.006 };
// Translation of accepted transcripts shares the voice-transcription budget.
export const TRANSLATION_CALL_KIND = "voice_translation";
const BUDGET_CALL_KINDS = new Set([TRANSCRIPTION_CALL_KIND, TRANSLATION_CALL_KIND]);

function clean(value) {
  return String(value ?? "").trim();
}

function finiteNumber(value, fallback) {
  if (value === undefined || value === null || clean(value) === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseJsonMap(value = "") {
  try {
    const parsed = JSON.parse(clean(value) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export class TranscriptionError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "TranscriptionError";
    this.code = code;
    Object.assign(this, details);
  }
}

export function transcriptionErrorCode(error) {
  const code = clean(error?.code);
  return /^transcription_[a-z0-9_]+$/.test(code) ? code : "transcription_failed";
}

/** "off" when disabled, "on" when explicitly enabled, "auto" when unset (on if a key exists). */
export function voiceTranscriptionMode(env = process.env) {
  const raw = clean(env.ORKESTR_VOICE_TRANSCRIPTION).toLowerCase();
  if (["0", "off", "false", "no", "disabled"].includes(raw)) return "off";
  if (["1", "on", "true", "yes", "enabled"].includes(raw)) return "on";
  return "auto";
}

export function transcriptionPricePerMinuteUsd(model = DEFAULT_MODEL, env = process.env) {
  // The single-price override applies to the configured transcription model only.
  const configuredModel = clean(env.ORKESTR_TRANSCRIPTION_MODEL) || DEFAULT_MODEL;
  const override = finiteNumber(env.ORKESTR_TRANSCRIPTION_PRICE_PER_MINUTE_USD, null);
  if (override !== null && model === configuredModel) return override;
  const configured = parseJsonMap(env.ORKESTR_TRANSCRIPTION_PRICES_JSON);
  return finiteNumber(configured[model], finiteNumber(DEFAULT_PRICE_PER_MINUTE_USD[model], 0));
}

export function voiceTranscriptionSettings(env = process.env) {
  const model = clean(env.ORKESTR_TRANSCRIPTION_MODEL) || DEFAULT_MODEL;
  const languages = splitCommaList(env.ORKESTR_TRANSCRIPTION_LANGUAGES ?? DEFAULT_LANGUAGES)
    .map((code) => code.toLowerCase())
    .filter((code) => /^[a-z]{2,3}$/.test(code));
  return {
    mode: voiceTranscriptionMode(env),
    model,
    languages,
    timeoutMs: positiveIntegerEnv(env.ORKESTR_TRANSCRIPTION_TIMEOUT_MS, 30_000, 100),
    dailyBudgetUsd: finiteNumber(env.ORKESTR_TRANSCRIPTION_DAILY_BUDGET_USD, 5),
    chatHourlyLimit: positiveIntegerEnv(env.ORKESTR_TRANSCRIPTION_CHAT_HOURLY_LIMIT, 60),
    maxNotesPerMessage: 3,
    pricePerMinuteUsd: transcriptionPricePerMinuteUsd(model, env),
    baseUrl: clean(env.ORKESTR_TRANSCRIPTION_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/g, ""),
  };
}

/**
 * Resolution order: secure secret "openai_api_key" (user/admin -> global),
 * ORKESTR_OPENAI_API_KEY, OPENAI_API_KEY, then the openai connector config.
 * Returns only the key and a source label; callers must never log the key.
 */
export async function resolveTranscriptionApiKey(env = process.env) {
  try {
    const secret = await resolveSecureSecretValue(TRANSCRIPTION_SECRET_NAME, { usedBy: TRANSCRIPTION_CALL_KIND }, env);
    const value = clean(secret?.value);
    if (value) return { apiKey: value, source: "secure_secret" };
  } catch {
    // Secure store unavailable or locked: fall through to env/config keys.
  }
  if (clean(env.ORKESTR_OPENAI_API_KEY)) return { apiKey: clean(env.ORKESTR_OPENAI_API_KEY), source: "env" };
  if (clean(env.OPENAI_API_KEY)) return { apiKey: clean(env.OPENAI_API_KEY), source: "env" };
  try {
    const config = await readConnectorConfig("openai", env);
    if (clean(config?.openaiApiKey)) return { apiKey: clean(config.openaiApiKey), source: "connector_config" };
  } catch {
    // No connector config.
  }
  return { apiKey: "", source: "" };
}

function uploadFileName(mimetype = "") {
  const type = clean(mimetype).toLowerCase();
  if (type.includes("ogg") || type.includes("opus")) return "voice-note.ogg";
  if (type.includes("mpeg") || type.includes("mp3")) return "voice-note.mp3";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return "voice-note.m4a";
  if (type.includes("wav")) return "voice-note.wav";
  if (type.includes("webm")) return "voice-note.webm";
  return "voice-note.ogg";
}

function responseLanguages(payload = {}) {
  const list = Array.isArray(payload.languages) ? payload.languages : [];
  const codes = list.map((item) => clean(typeof item === "string" ? item : item?.code).toLowerCase()).filter(Boolean);
  if (!codes.length && clean(payload.language)) codes.push(clean(payload.language).toLowerCase());
  return [...new Set(codes)];
}

function responseSeconds(payload = {}) {
  const usage = payload.usage || {};
  const seconds = Number(usage.type === "duration" || usage.seconds !== undefined ? usage.seconds : payload.duration);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/** Reads a local audio file for upload; throws value-free codes. */
export async function readAudioForUpload(filePath = "") {
  const stats = await fs.stat(String(filePath || "")).catch(() => null);
  if (!stats?.isFile()) throw new TranscriptionError("transcription_file_missing");
  if (stats.size > MAX_TRANSCRIPTION_BYTES) throw new TranscriptionError("transcription_too_large");
  const bytes = await fs.readFile(filePath).catch(() => null);
  if (!bytes) throw new TranscriptionError("transcription_file_missing");
  return bytes;
}

export function audioUploadBlob(bytes, mimetype = "") {
  return { blob: new Blob([bytes], { type: clean(mimetype).split(";")[0] || "audio/ogg" }), name: uploadFileName(mimetype) };
}

/** POSTs a multipart form to {base}/audio/transcriptions and returns the JSON payload. */
export async function postTranscriptionForm({ form, apiKey, baseUrl, timeoutMs, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 1));
  try {
    const response = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!response?.ok) throw new TranscriptionError(`transcription_http_${Number(response?.status) || 0}`);
    return await response.json().catch(() => {
      throw new TranscriptionError("transcription_invalid_response");
    });
  } catch (error) {
    if (error instanceof TranscriptionError) throw error;
    if (controller.signal.aborted || error?.name === "AbortError") throw new TranscriptionError("transcription_timeout");
    throw new TranscriptionError("transcription_network_error");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one audio file to POST {base}/audio/transcriptions.
 * @returns {Promise<{ text: string; languages: string[]; seconds: number; model: string }>}
 */
export async function transcribeAudioFile({
  filePath,
  mimetype = "",
  keywords = [],
  languages,
  env = process.env,
  fetchImpl = globalThis.fetch,
  apiKey = "",
  model = "",
  timeoutMs = 0,
} = {}) {
  const settings = voiceTranscriptionSettings(env);
  const key = clean(apiKey) || (await resolveTranscriptionApiKey(env)).apiKey;
  if (!key) throw new TranscriptionError("transcription_no_key");
  const bytes = await readAudioForUpload(filePath);
  const chosenModel = clean(model) || settings.model;
  const form = new FormData();
  form.append("model", chosenModel);
  const upload = audioUploadBlob(bytes, mimetype);
  form.append("file", upload.blob, upload.name);
  for (const keyword of Array.isArray(keywords) ? keywords : []) {
    if (clean(keyword)) form.append("keywords[]", clean(keyword));
  }
  for (const language of Array.isArray(languages) ? languages : settings.languages) {
    if (clean(language)) form.append("languages[]", clean(language));
  }
  form.append("response_format", "json");
  const payload = await postTranscriptionForm({
    form,
    apiKey: key,
    baseUrl: settings.baseUrl,
    timeoutMs: Number(timeoutMs) || settings.timeoutMs,
    fetchImpl,
  });
  const text = clean(payload?.text);
  if (!text) throw new TranscriptionError("transcription_empty");
  return { text, languages: responseLanguages(payload), seconds: responseSeconds(payload), model: chosenModel };
}

function todayPrefix() {
  return new Date().toISOString().slice(0, 10);
}

/** Today's spend on voice transcription plus voice translation. */
export async function voiceTranscriptionSpentTodayUsd(env = process.env) {
  const today = todayPrefix();
  const records = await listCreditUsageRecords(env).catch(() => []);
  return records
    .filter((record) => BUDGET_CALL_KINDS.has(record.callKind) && String(record.createdAt || "").startsWith(today))
    .reduce((sum, record) => sum + (Number(record.estimatedCostUsd) || 0), 0);
}

export async function assertVoiceTranscriptionBudget(env = process.env) {
  const { dailyBudgetUsd } = voiceTranscriptionSettings(env);
  if (await voiceTranscriptionSpentTodayUsd(env) >= dailyBudgetUsd) throw new TranscriptionError("transcription_budget_exceeded");
}

export async function consumeVoiceTranscriptionRateLimit(chatKey = "", env = process.env) {
  const { chatHourlyLimit } = voiceTranscriptionSettings(env);
  const result = await consumeDurableRateLimit({
    bucket: "voice-transcription",
    key: clean(chatKey) || "unknown-chat",
    limit: chatHourlyLimit,
    windowMs: 60 * 60 * 1000,
  }, env);
  if (!result.ok) throw new TranscriptionError("transcription_rate_limited");
}

export function voiceTranscriptionCostUsd(seconds = 0, model = DEFAULT_MODEL, env = process.env) {
  return (Math.max(0, Number(seconds) || 0) / 60) * transcriptionPricePerMinuteUsd(model, env);
}

export async function recordVoiceTranscriptionUsage({ tenantId = "", threadId = "", sourceChannel = "", seconds = 0, model = DEFAULT_MODEL } = {}, env = process.env) {
  return recordCreditUsage({
    tenantId,
    threadId,
    runtimeKind: TRANSCRIPTION_CALL_KIND,
    sourceChannel,
    callKind: TRANSCRIPTION_CALL_KIND,
    model,
    estimatedCostUsd: voiceTranscriptionCostUsd(seconds, model, env),
    status: "completed",
  }, env);
}
