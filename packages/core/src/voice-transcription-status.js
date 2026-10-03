// Health of voice-note transcription for `orkestr doctor voice` and the admin
// status API: settings, key presence (never the key), today's spend against
// the daily budget, and per-day outcome counters. Counters hold numbers and
// error codes only — never transcript text, file names or chat ids.
import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import {
  resolveTranscriptionApiKey,
  voiceTranscriptionMode,
  voiceTranscriptionSettings,
  voiceTranscriptionSpentTodayUsd,
} from "./voice-transcription.js";
import { voiceDiarizationSettings } from "./voice-diarization.js";
import { voiceTranslationSettings } from "./voice-translation.js";

const RETAINED_DAYS = 14;

function statsPath(env = process.env) {
  return path.join(dataPaths(env).home, "voice-transcription-stats.json");
}

function day(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function emptyDay() {
  return { completed: 0, failed: 0, seconds: 0, translated: 0, translationFailed: 0, codes: {} };
}

export async function readVoiceTranscriptionStats(env = process.env) {
  const raw = await readJson(statsPath(env), {}).catch(() => ({}));
  return { days: raw?.days && typeof raw.days === "object" ? raw.days : {}, lastSuccessAt: raw?.lastSuccessAt || null, lastFailure: raw?.lastFailure || null };
}

function errorKey(code = "", fallback = "transcription_failed") {
  return String(code || fallback).replace(/[^a-z0-9_]/gi, "").slice(0, 60) || fallback;
}

async function updateToday(env, apply) {
  try {
    await ensureDataDirs(env);
    const filePath = statsPath(env);
    await withStorageFileLock(filePath, async () => {
      const stats = await readVoiceTranscriptionStats(env);
      const now = new Date();
      const today = { ...emptyDay(), ...(stats.days[day(now)] || {}) };
      apply(today, stats, now);
      stats.days[day(now)] = today;
      const keep = new Set(Array.from({ length: RETAINED_DAYS }, (_, index) => day(new Date(now.getTime() - index * 86_400_000))));
      for (const key of Object.keys(stats.days)) if (!keep.has(key)) delete stats.days[key];
      await writeJson(filePath, stats);
    });
  } catch {
    // Stats are diagnostics only; never fail a transcription over them.
  }
}

/** Counts one transcription outcome. Never throws. */
export async function recordVoiceTranscriptionOutcome({ ok = false, code = "", seconds = 0 } = {}, env = process.env) {
  await updateToday(env, (today, stats, now) => {
    if (ok) {
      today.completed += 1;
      today.seconds += Math.max(0, Number(seconds) || 0);
      stats.lastSuccessAt = now.toISOString();
    } else {
      const key = errorKey(code);
      today.failed += 1;
      today.codes[key] = (today.codes[key] || 0) + 1;
      stats.lastFailure = { at: now.toISOString(), code: key };
    }
  });
}

/** Counts one translation outcome (codes share the per-day code map). Never throws. */
export async function recordVoiceTranslationOutcome({ ok = false, code = "" } = {}, env = process.env) {
  await updateToday(env, (today) => {
    if (ok) {
      today.translated += 1;
      return;
    }
    const key = errorKey(code, "translation_failed");
    today.translationFailed += 1;
    today.codes[key] = (today.codes[key] || 0) + 1;
  });
}

function sumDays(days = {}, keys = []) {
  const total = emptyDay();
  for (const key of keys) {
    const entry = days[key];
    if (!entry) continue;
    total.completed += Number(entry.completed) || 0;
    total.failed += Number(entry.failed) || 0;
    total.seconds += Number(entry.seconds) || 0;
    total.translated += Number(entry.translated) || 0;
    total.translationFailed += Number(entry.translationFailed) || 0;
    for (const [code, count] of Object.entries(entry.codes || {})) total.codes[code] = (total.codes[code] || 0) + (Number(count) || 0);
  }
  return total;
}

export async function voiceTranscriptionStatus(env = process.env) {
  const settings = voiceTranscriptionSettings(env);
  const { apiKey, source } = await resolveTranscriptionApiKey(env);
  const mode = voiceTranscriptionMode(env);
  const spentTodayUsd = await voiceTranscriptionSpentTodayUsd(env).catch(() => 0);
  const stats = await readVoiceTranscriptionStats(env);
  const now = new Date();
  const today = sumDays(stats.days, [day(now)]);
  const week = sumDays(stats.days, Array.from({ length: 7 }, (_, index) => day(new Date(now.getTime() - index * 86_400_000))));
  const problems = [];
  const warnings = [];
  if (mode === "off") warnings.push("voice transcription is turned off (ORKESTR_VOICE_TRANSCRIPTION)");
  if (!apiKey) problems.push("no OpenAI API key: store one with `orkestr secret set openai_api_key --global --stdin`");
  if (spentTodayUsd >= settings.dailyBudgetUsd) problems.push(`daily budget reached ($${spentTodayUsd.toFixed(2)} of $${settings.dailyBudgetUsd.toFixed(2)}); notes arrive untranscribed until tomorrow`);
  else if (spentTodayUsd >= settings.dailyBudgetUsd * 0.8) warnings.push(`daily budget almost used ($${spentTodayUsd.toFixed(2)} of $${settings.dailyBudgetUsd.toFixed(2)})`);
  if (today.failed >= 3 && today.failed > today.completed) problems.push(`most transcriptions failed today (${today.failed} failed, ${today.completed} completed)`);
  return {
    ok: problems.length === 0,
    status: problems.length ? "broken" : warnings.length ? "degraded" : "ok",
    enabled: mode !== "off" && Boolean(apiKey),
    mode,
    model: settings.model,
    languages: settings.languages,
    diarization: voiceDiarizationSettings(env),
    translation: voiceTranslationSettings(env),
    keyConfigured: Boolean(apiKey),
    keySource: source || null,
    dailyBudgetUsd: settings.dailyBudgetUsd,
    spentTodayUsd: Number(spentTodayUsd.toFixed(4)),
    chatHourlyLimit: settings.chatHourlyLimit,
    today,
    last7Days: week,
    lastSuccessAt: stats.lastSuccessAt,
    lastFailure: stats.lastFailure,
    problems,
    warnings,
  };
}
