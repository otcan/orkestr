import { correctTranscriptNames } from "./voice-transcription-glossary.js";
import {
  TranscriptionError,
  audioUploadBlob,
  postTranscriptionForm,
  readAudioForUpload,
  voiceTranscriptionSettings,
} from "./voice-transcription.js";

// Speaker-labelled transcription ("diarization") for forwarded recordings.
// The diarize model accepts no prompt, keywords or language hints and returns
// no language, so diarized transcripts get name correction only and are never
// translated. Cost is billed per audio minute from the response `duration`.

export const DEFAULT_DIARIZE_MODEL = "gpt-4o-transcribe-diarize";

function clean(value) {
  return String(value ?? "").trim();
}

/** "auto" (forwarded recordings, kind "audio"), "always" (all audio) or "off". */
export function voiceDiarizationMode(env = process.env) {
  const raw = clean(env.ORKESTR_TRANSCRIPTION_DIARIZE).toLowerCase();
  if (["0", "off", "false", "no", "disabled"].includes(raw)) return "off";
  if (raw === "always") return "always";
  return "auto";
}

export function voiceDiarizationSettings(env = process.env) {
  return {
    mode: voiceDiarizationMode(env),
    model: clean(env.ORKESTR_TRANSCRIPTION_DIARIZE_MODEL) || DEFAULT_DIARIZE_MODEL,
  };
}

/** Voice notes ("ptt") keep the normal model; forwarded recordings are diarized. */
export function shouldDiarizeAttachment(attachment = {}, env = process.env) {
  const { mode } = voiceDiarizationSettings(env);
  if (mode === "off") return false;
  if (mode === "always") return true;
  return clean(attachment?.kind).toLowerCase() === "audio";
}

/** Merges consecutive segments of the same speaker into turns. */
export function mergeDiarizedSegments(segments = []) {
  const turns = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const text = clean(segment?.text);
    if (!text) continue;
    const speaker = clean(segment?.speaker) || "?";
    const last = turns.at(-1);
    if (last && last.speaker === speaker) {
      last.text = `${last.text} ${text}`;
      continue;
    }
    const start = Number(segment?.start);
    turns.push({ speaker, start: Number.isFinite(start) && start >= 0 ? start : 0, text });
  }
  return turns;
}

/**
 * Sends one audio file to the diarize model.
 * @returns {Promise<{ text: string; languages: string[]; seconds: number; model: string; speakers: number; turns: Array<{ speaker: string; start: number; text: string }> }>}
 */
export async function diarizeAudioFile({
  filePath,
  mimetype = "",
  glossary = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
  apiKey = "",
  model = "",
  timeoutMs = 0,
} = {}) {
  const settings = voiceTranscriptionSettings(env);
  if (!clean(apiKey)) throw new TranscriptionError("transcription_no_key");
  const bytes = await readAudioForUpload(filePath);
  const chosenModel = clean(model) || voiceDiarizationSettings(env).model;
  const form = new FormData();
  form.append("model", chosenModel);
  const upload = audioUploadBlob(bytes, mimetype);
  form.append("file", upload.blob, upload.name);
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");
  const payload = await postTranscriptionForm({
    form,
    apiKey: clean(apiKey),
    baseUrl: settings.baseUrl,
    timeoutMs: Number(timeoutMs) || settings.timeoutMs,
    fetchImpl,
  });
  let turns = mergeDiarizedSegments(payload?.segments).map((turn) => ({ ...turn, text: correctTranscriptNames(turn.text, glossary) }));
  if (!turns.length && clean(payload?.text)) turns = [{ speaker: "A", start: 0, text: correctTranscriptNames(clean(payload.text), glossary) }];
  if (!turns.length) throw new TranscriptionError("transcription_empty");
  const duration = Number(payload?.duration);
  return {
    text: turns.map((turn) => turn.text).join(" "),
    languages: [],
    seconds: Number.isFinite(duration) && duration > 0 ? duration : 0,
    model: chosenModel,
    speakers: new Set(turns.map((turn) => turn.speaker)).size,
    turns,
  };
}

/** Lines for a recording with 2+ speakers: a header, then one line per turn. */
export function diarizedRecordingLines({ seconds = 0, speakers = 0, turns = [] } = {}, formatDuration = String) {
  return [
    `🎤 Recording (${formatDuration(seconds)}, ${speakers} speakers):`,
    ...turns.map((turn) => `Speaker ${turn.speaker}: "${clean(turn.text)}"`),
  ];
}
