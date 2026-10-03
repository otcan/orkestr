import { appendEvent } from "../../storage/src/store.js";
import { recordVoiceTranscriptionOutcome, recordVoiceTranslationOutcome } from "./voice-transcription-status.js";
import { correctTranscriptNames } from "./voice-transcription-glossary.js";
import { diarizeAudioFile, diarizedRecordingLines, shouldDiarizeAttachment } from "./voice-diarization.js";
import {
  languageNeedingTranslation,
  recordVoiceTranslationUsage,
  translateText,
  translationErrorCode,
  voiceTranslationSettings,
} from "./voice-translation.js";
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
  if (!normalized || LANGUAGE_NAMES[normalized]) return LANGUAGE_NAMES[normalized] || "";
  try {
    return new Intl.DisplayNames(["en"], { type: "language", fallback: "code" }).of(normalized) || normalized;
  } catch {
    return normalized;
  }
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

export function voiceNoteTranslationLine({ language = "", text = "" } = {}) {
  return `↳ ${languageDisplayName(language)}: "${clean(text)}"`;
}

export function voiceNoteTranslationUnavailableLine(code = "translation_failed") {
  return `↳ translation unavailable (${code})`;
}

/** Thread input lines for one accepted transcript (plus its translation, if any). */
export function voiceNoteTranscriptLines(transcript = {}) {
  const lines = Number(transcript.speakers) >= 2
    ? diarizedRecordingLines(transcript, formatVoiceNoteDuration)
    : [voiceNoteTranscriptLine(transcript)];
  if (transcript.translation) lines.push(voiceNoteTranslationLine(transcript.translation));
  return lines;
}

/** Drops the generated "attachment received" summary when every attachment is audio. */
export function voiceNoteCaption(text = "", attachments = []) {
  const value = clean(text);
  if (!value.startsWith(GENERATED_SUMMARY_PREFIX)) return value;
  return attachments.every(isAudioAttachment) ? "" : value;
}

async function transcribeOneAttachment({ attachment, glossary, settings, deadline, apiKey, threadId, env, fetchImpl }) {
  const request = { filePath: attachment.path || attachment.saved_path, mimetype: attachment.mimetype, env, fetchImpl, apiKey };
  if (shouldDiarizeAttachment(attachment, env)) {
    try {
      return await diarizeAudioFile({ ...request, glossary, timeoutMs: Math.min(settings.timeoutMs, deadline - Date.now()) });
    } catch (error) {
      // Fall back to the normal model once for this attachment.
      await appendEvent({ type: "voice_diarization_failed", threadId, code: transcriptionErrorCode(error) }, env).catch(() => {});
    }
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new TranscriptionError("transcription_timeout");
  return transcribeAudioFile({
    ...request,
    keywords: glossary,
    languages: settings.languages,
    model: settings.model,
    timeoutMs: Math.min(settings.timeoutMs, remainingMs),
  });
}

/**
 * Translates an accepted transcript whose language is not understood.
 * Never throws: returns `{ translation }`, `{ code }` on failure, or `{}`.
 */
async function translateAcceptedTranscript({ transcript, apiKey, deadline, settings, tenantId, threadId, sourceChannel, env, fetchImpl }) {
  const translationSettings = voiceTranslationSettings(env);
  const from = languageNeedingTranslation(transcript.languages, translationSettings);
  if (!from) return {};
  const to = translationSettings.target;
  try {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw Object.assign(new Error("timeout"), { code: "translation_timeout" });
    await assertVoiceTranscriptionBudget(env).catch(() => {
      throw Object.assign(new Error("budget"), { code: "translation_budget_exceeded" });
    });
    const result = await translateText({
      text: transcript.text,
      targetName: languageDisplayName(to),
      model: translationSettings.model,
      apiKey,
      timeoutMs: Math.min(settings.timeoutMs, remainingMs),
      env,
      fetchImpl,
    });
    await recordVoiceTranslationUsage({ tenantId, threadId, sourceChannel, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens }, env).catch(() => {});
    await appendEvent({ type: "voice_translation_completed", threadId, from, to, model: result.model }, env).catch(() => {});
    await recordVoiceTranslationOutcome({ ok: true }, env);
    return { translation: { language: to, text: result.text, model: result.model } };
  } catch (error) {
    const code = translationErrorCode(error);
    await appendEvent({ type: "voice_translation_failed", threadId, code }, env).catch(() => {});
    await recordVoiceTranslationOutcome({ ok: false, code }, env);
    return { code };
  }
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
        const result = await transcribeOneAttachment({ attachment, glossary, settings, deadline, apiKey, threadId, env, fetchImpl });
        const corrected = correctTranscriptNames(result.text, glossary);
        if (typeof acceptTranscript === "function" && !acceptTranscript(corrected)) {
          throw new TranscriptionError("transcription_policy_blocked", { billedSeconds: result.seconds, billedModel: result.model });
        }
        const transcript = result.turns
          ? { text: corrected, model: result.model, seconds: result.seconds, speakers: result.speakers, turns: result.turns }
          : { text: corrected, model: result.model, languages: result.languages, seconds: result.seconds };
        const translated = await translateAcceptedTranscript({ transcript, apiKey, deadline, settings, tenantId, threadId, sourceChannel, env, fetchImpl });
        if (translated.translation && typeof acceptTranscript === "function" && !acceptTranscript(translated.translation.text)) {
          // The classifier is English-pattern based: a foreign-language
          // injection only shows up in the translation, so block the note.
          throw new TranscriptionError("transcription_policy_blocked", { billedSeconds: result.seconds, billedModel: result.model });
        }
        if (translated.translation) transcript.translation = translated.translation;
        nextAttachments[index] = { ...attachment, transcript };
        lines.push(...voiceNoteTranscriptLines(transcript));
        if (translated.code) lines.push(voiceNoteTranslationUnavailableLine(translated.code));
        outcomes.push({ ok: true });
        await recordVoiceTranscriptionUsage({ tenantId, threadId, sourceChannel, seconds: result.seconds, model: result.model }, env).catch(() => {});
        await appendEvent({
          type: "voice_transcription_completed",
          threadId,
          seconds: result.seconds,
          model: result.model,
          languages: result.languages,
          ...(result.speakers ? { speakers: result.speakers } : {}),
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
