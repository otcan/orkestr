import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordVoiceTranscriptionOutcome, voiceTranscriptionStatus } from "../packages/core/src/voice-transcription-status.js";
import { recordVoiceTranscriptionUsage } from "../packages/core/src/voice-transcription.js";
import { formatVoiceDoctor } from "../apps/cli/src/doctor-voice-command.js";

async function home(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-voice-status-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("doctor status: missing key is broken; counters, spend and budget are reported without content", async (t) => {
  const env = { ORKESTR_HOME: await home(t), ORKESTR_TRANSCRIPTION_DAILY_BUDGET_USD: "0.01" };
  const missing = await voiceTranscriptionStatus(env);
  assert.equal(missing.ok, false);
  assert.equal(missing.keyConfigured, false);
  assert.match(missing.problems.join(" "), /no OpenAI API key/);

  const keyed = { ...env, ORKESTR_OPENAI_API_KEY: "sk-test-fake-status" };
  await recordVoiceTranscriptionOutcome({ ok: true, seconds: 42 }, keyed);
  await recordVoiceTranscriptionOutcome({ ok: false, code: "transcription_timeout" }, keyed);
  const healthy = await voiceTranscriptionStatus(keyed);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.keySource, "env");
  assert.deepEqual({ completed: healthy.today.completed, failed: healthy.today.failed, seconds: healthy.today.seconds }, { completed: 1, failed: 1, seconds: 42 });
  assert.equal(healthy.today.codes.transcription_timeout, 1);
  assert.equal(healthy.lastFailure.code, "transcription_timeout");

  // 2 minutes of gpt-transcribe ($0.009) is 90% of the $0.01 budget.
  await recordVoiceTranscriptionUsage({ threadId: "thread-a", sourceChannel: "whatsapp", seconds: 120, model: "gpt-transcribe" }, keyed);
  const nearlySpent = await voiceTranscriptionStatus(keyed);
  assert.equal(nearlySpent.status, "degraded");
  assert.match(nearlySpent.warnings.join(" "), /budget almost used/);

  const text = formatVoiceDoctor(nearlySpent);
  assert.match(text, /Voice transcription: DEGRADED/);
  assert.match(text, /API key configured \(env\)/);
  assert.match(text, /transcription_timeout ×1/);
  assert.equal(JSON.stringify(nearlySpent).includes("sk-test-fake-status") || text.includes("sk-test-fake-status"), false);
});
