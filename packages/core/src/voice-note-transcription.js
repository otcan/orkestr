import { appendEvent } from "../../storage/src/store.js";
import { recordVoiceTranscriptionOutcome } from "./voice-transcription-status.js";
import { correctTranscriptNames } from "./voice-transcription-glossary.js";
import {
  TranscriptionError,
  assertVoiceTranscriptionBudget,
  consumeVoiceTranscriptionRateLimit,
  recordVoiceTranscriptionUsage,
  resolveTranscriptionApiKey,
  transcribeAudioFile,
  transcriptionErrorCode,
  voiceTranscriptionSettings,
} from "./voice-transcription.js";

// Turns audio attachments of one inbound message into thread input text.
// Never throws and never waits longer than the configured timeout in total, so
// the inbound message is always enqueued. Events carry codes and durations
// only, never transcript text, file names, or keys.

const LANGUAGE_NAMES = { en: "English", tr: "Turkish", de: "German" };
const GENERATED_SUMMARY_PREFIX = "WhatsApp attachment received.";

function clean(value) {
  return String(value ?? "").trim();
}

export function isAudioAttachment(attachment = {}) {
  const kind = clean(attachment?.kind).toLowerCase();
  const mimetype = clean(attachment?.mimetype || attachment?.type).toLowerCase();
  return kind === "ptt" || kind === "audio" || mimetype.startsWith("audio/");
}

export function formatVoiceNoteDuration(seconds = 0) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function languageDisplayName(code = "") {
  const normalized = clean(code).toLowerCase();
  return LANGUAGE_NAMES[normalized] || normalized;
}

function knownDurationSeconds(attachment = {}) {
  const seconds = Number(attachment?.transcript?.seconds ?? attachment?.seconds ?? attachment?.duration);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

export function voiceNoteTranscriptLine({ seconds = 0, languages = [], text = "" } = {}) {
  const parts = [formatVoiceNoteDuration(seconds)];
  const language = languageDisplayName(Array.isArray(languages) ? languages[0] : "");
  if (language) parts.push(language);
  return `🎤 Voice note (${parts.join(", ")}): "${clean(text)}"`;
}

export function voiceNoteUnavailableLine({ seconds = 0, code = "transcription_failed" } = {}) {
  const duration = Number(seconds) > 0 ? ` (${formatVoiceNoteDuration(seconds)})` : "";
  return `🎤 Voice note${duration}: transcription unavailable (${code})`;
}

/** Drops the generated "attachment received" summary when every attachment is audio. */
export function voiceNoteCaption(text = "", attachments = []) {
  const value = clean(text);
  if (!value.startsWith(GENERATED_SUMMARY_PREFIX)) return value;
  return attachments.every(isAudioAttachment) ? "" : value;
}

/**
 * @param {{
 *   attachments?: any[]; text?: string; glossary?: string[]; chatKey?: string; tenantId?: string;
 *   threadId?: string; sourceChannel?: string; acceptTranscript?: (text: string) => boolean;
 *   env?: Record<string, string | undefined>; fetchImpl?: typeof fetch;
 * }} options
 * @returns {Promise<null | { text: string; attachments: any[]; outcomes: Array<{ ok: boolean; code?: string }> }>}
 */
export async function transcribeVoiceNoteAttachments({
  attachments = [],
  text = "",
  glossary = [],
  chatKey = "",
  tenantId = "",
  threadId = "",
  sourceChannel = "",
  acceptTranscript = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    const items = Array.isArray(attachments) ? attachments : [];
    if (!items.some(isAudioAttachment)) return null;
    const settings = voiceTranscriptionSettings(env);
    if (settings.mode === "off") return null;
    const { apiKey } = await resolveTranscriptionApiKey(env);
    if (!apiKey && settings.mode === "auto") return null;
    const deadline = Date.now() + settings.timeoutMs;
    const nextAttachments = [...items];
    const lines = [];
    const outcomes = [];
    let attempted = 0;
    for (let index = 0; index < nextAttachments.length; index += 1) {
      const attachment = nextAttachments[index];
      if (!isAudioAttachment(attachment) || attempted >= settings.maxNotesPerMessage) continue;
      attempted += 1;
      try {
        if (!apiKey) throw new TranscriptionError("transcription_no_key");
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new TranscriptionError("transcription_timeout");
        await assertVoiceTranscriptionBudget(env);
        await consumeVoiceTranscriptionRateLimit(chatKey, env);
        const result = await transcribeAudioFile({
          filePath: attachment.path || attachment.saved_path,
          mimetype: attachment.mimetype,
          keywords: glossary,
          languages: settings.languages,
          env,
          fetchImpl,
          apiKey,
          model: settings.model,
          timeoutMs: Math.min(settings.timeoutMs, remainingMs),
        });
        const corrected = correctTranscriptNames(result.text, glossary);
        if (typeof acceptTranscript === "function" && !acceptTranscript(corrected)) {
          throw new TranscriptionError("transcription_policy_blocked", { billedSeconds: result.seconds, billedModel: result.model });
        }
        const transcript = { text: corrected, model: result.model, languages: result.languages, seconds: result.seconds };
        nextAttachments[index] = { ...attachment, transcript };
        lines.push(voiceNoteTranscriptLine(transcript));
        outcomes.push({ ok: true });
        await recordVoiceTranscriptionUsage({ tenantId, threadId, sourceChannel, seconds: result.seconds, model: result.model }, env).catch(() => {});
        await appendEvent({
          type: "voice_transcription_completed",
          threadId,
          seconds: result.seconds,
          model: result.model,
          languages: result.languages,
        }, env).catch(() => {});
        await recordVoiceTranscriptionOutcome({ ok: true, seconds: result.seconds }, env);
      } catch (error) {
        const code = transcriptionErrorCode(error);
        if (error?.billedSeconds) {
          await recordVoiceTranscriptionUsage({ tenantId, threadId, sourceChannel, seconds: error.billedSeconds, model: error.billedModel }, env).catch(() => {});
        }
        lines.push(voiceNoteUnavailableLine({ seconds: knownDurationSeconds(attachment), code }));
        outcomes.push({ ok: false, code });
        await appendEvent({ type: "voice_transcription_failed", threadId, code }, env).catch(() => {});
        await recordVoiceTranscriptionOutcome({ ok: false, code }, env);
      }
    }
    if (!lines.length) return null;
    const caption = voiceNoteCaption(text, items);
    return { text: [caption, ...lines].filter(Boolean).join("\n"), attachments: nextAttachments, outcomes };
  } catch {
    return null;
  }
}
