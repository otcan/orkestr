import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listCreditUsageRecords } from "../packages/core/src/credit-usage.js";
import {
  formatVoiceNoteDuration,
  isAudioAttachment,
  transcribeVoiceNoteAttachments,
  voiceNoteCaption,
} from "../packages/core/src/voice-note-transcription.js";
import {
  buildTranscriptionGlossary,
  correctTranscriptNames,
  phoneticKey,
} from "../packages/core/src/voice-transcription-glossary.js";
import {
  resolveTranscriptionApiKey,
  transcribeAudioFile,
  voiceTranscriptionSettings,
} from "../packages/core/src/voice-transcription.js";
import { dataPaths } from "../packages/storage/src/paths.js";

const FAKE_KEY = "sk-test-voice-fake-key-0000";

async function fixture(prefix, extra = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-voice-${prefix}-`));
  const audioPath = path.join(home, "inbound-note.ogg");
  await fs.writeFile(audioPath, Buffer.from("OggS-fake-audio"));
  const env = { ORKESTR_HOME: home, OPENAI_API_KEY: FAKE_KEY, ...extra };
  return { home, env, audioPath };
}

function okFetch(payload, calls = []) {
  return async (url, init) => {
    // The automatic translation check answers "already understood".
    if (String(url).endsWith("/responses")) {
      return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "NO_TRANSLATION" }] }], usage: { input_tokens: 40, output_tokens: 3 } }), { status: 200 });
    }
    calls.push({ url, init });
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
}

const SAMPLE = { text: "Please ask Modex about the Orchestr demo on Monday.", languages: [{ code: "en" }], usage: { type: "duration", seconds: 7 } };

async function readEvents(env) {
  const raw = await fs.readFile(dataPaths(env).events, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("transcribeAudioFile sends the documented multipart request", async () => {
  const { env, audioPath } = await fixture("request", { OPENAI_BASE_URL: "https://llm.example.com/v1/" });
  const calls = [];
  const result = await transcribeAudioFile({
    filePath: audioPath,
    mimetype: "audio/ogg; codecs=opus",
    keywords: ["Orkestr", "Modeks"],
    languages: ["en", "tr", "de"],
    env,
    fetchImpl: okFetch(SAMPLE, calls),
  });
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, "https://llm.example.com/v1/audio/transcriptions");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, `Bearer ${FAKE_KEY}`);
  const form = init.body;
  assert.equal(form.get("model"), "gpt-transcribe");
  assert.equal(form.get("response_format"), "json");
  assert.deepEqual(form.getAll("keywords[]"), ["Orkestr", "Modeks"]);
  assert.deepEqual(form.getAll("languages[]"), ["en", "tr", "de"]);
  const file = form.get("file");
  assert.equal(file.name, "voice-note.ogg");
  assert.equal(file.type, "audio/ogg");
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "OggS-fake-audio");
  assert.deepEqual(result, { text: SAMPLE.text, languages: ["en"], seconds: 7, model: "gpt-transcribe" });
});

test("transcribeAudioFile maps failures to value-free codes", async () => {
  const { env, audioPath, home } = await fixture("errors", { ORKESTR_TRANSCRIPTION_TIMEOUT_MS: "150" });
  const run = (fetchImpl, extra = {}) => transcribeAudioFile({ filePath: audioPath, mimetype: "audio/ogg", env, fetchImpl, ...extra });
  await assert.rejects(run(async () => new Response("secret body", { status: 500 })), (error) => error.code === "transcription_http_500" && !error.message.includes("secret"));
  await assert.rejects(run((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  })), { code: "transcription_timeout" });
  await assert.rejects(run(okFetch({ text: "  " })), { code: "transcription_empty" });
  const noKeyEnv = { ORKESTR_HOME: home };
  await assert.rejects(transcribeAudioFile({ filePath: audioPath, env: noKeyEnv, fetchImpl: okFetch(SAMPLE) }), { code: "transcription_no_key" });
  const big = path.join(home, "big.ogg");
  await fs.writeFile(big, Buffer.alloc(0));
  await fs.truncate(big, 25 * 1024 * 1024 + 1);
  await assert.rejects(transcribeAudioFile({ filePath: big, env, fetchImpl: okFetch(SAMPLE) }), { code: "transcription_too_large" });
});

test("settings and key resolution follow env precedence without exposing the key", async () => {
  const { home } = await fixture("settings");
  const settings = voiceTranscriptionSettings({});
  assert.equal(settings.mode, "auto");
  assert.equal(settings.model, "gpt-transcribe");
  assert.deepEqual(settings.languages, ["en", "tr", "de"]);
  assert.equal(settings.timeoutMs, 30000);
  assert.equal(settings.dailyBudgetUsd, 5);
  assert.equal(settings.chatHourlyLimit, 60);
  assert.equal(settings.pricePerMinuteUsd, 0.0045);
  assert.equal(voiceTranscriptionSettings({ ORKESTR_VOICE_TRANSCRIPTION: "off" }).mode, "off");
  assert.equal(voiceTranscriptionSettings({ ORKESTR_VOICE_TRANSCRIPTION: "0" }).mode, "off");
  assert.equal(voiceTranscriptionSettings({ ORKESTR_TRANSCRIPTION_PRICE_PER_MINUTE_USD: "0.01" }).pricePerMinuteUsd, 0.01);
  const resolved = await resolveTranscriptionApiKey({ ORKESTR_HOME: home, ORKESTR_OPENAI_API_KEY: "sk-orkestr-fake", OPENAI_API_KEY: "sk-openai-fake" });
  assert.deepEqual(resolved, { apiKey: "sk-orkestr-fake", source: "env" });
  assert.deepEqual(await resolveTranscriptionApiKey({ ORKESTR_HOME: home }), { apiKey: "", source: "" });
});

test("name correction snaps phonetic spellings to glossary names only", () => {
  const glossary = ["Orkestr", "Modeks", "Make"];
  assert.equal(phoneticKey("Modex"), phoneticKey("Modeks"));
  assert.equal(correctTranscriptNames("Ask Modex, then Orchestr.", glossary), "Ask Modeks, then Orkestr.");
  assert.equal(correctTranscriptNames("\"Modex!\" (Orchestr)", glossary), "\"Modeks!\" (Orkestr)");
  assert.equal(correctTranscriptNames("Model Monday Make Mode Motel", glossary), "Model Monday Make Mode Motel");
  assert.equal(correctTranscriptNames("Models Modes Modem Monitor Orkan", glossary), "Models Modes Modem Monitor Orkan");
  assert.equal(correctTranscriptNames("Orkester", glossary), "Orkestr");
  assert.equal(correctTranscriptNames("ask motex later", glossary), "ask motex later");
  assert.equal(correctTranscriptNames("Orkestr stays", glossary), "Orkestr stays");
});

test("glossary includes defaults, thread names and overlay keywords with caps", () => {
  const glossary = buildTranscriptionGlossary({
    threadName: "Demo Thread",
    bindingName: "demo thread",
    ownerDisplayName: "Example Owner",
    env: { ORKESTR_TRANSCRIPTION_KEYWORDS: "Modeks, orkestr ," + "x".repeat(41) },
  });
  assert.deepEqual(glossary, ["Orkestr", "Demo Thread", "Example Owner", "Modeks"]);
  const many = buildTranscriptionGlossary({ env: { ORKESTR_TRANSCRIPTION_KEYWORDS: Array.from({ length: 60 }, (_, i) => `Name${i}`).join(",") } });
  assert.equal(many.length, 40);
});

test("formatting helpers", () => {
  assert.equal(formatVoiceNoteDuration(7), "0:07");
  assert.equal(formatVoiceNoteDuration(125.4), "2:05");
  assert.equal(isAudioAttachment({ kind: "ptt" }), true);
  assert.equal(isAudioAttachment({ mimetype: "audio/mpeg" }), true);
  assert.equal(isAudioAttachment({ kind: "image", mimetype: "image/png" }), false);
  assert.equal(voiceNoteCaption("WhatsApp attachment received.\n\nAttachment 1: x", [{ kind: "ptt" }]), "");
  assert.equal(voiceNoteCaption("see this", [{ kind: "ptt" }]), "see this");
});

test("voice notes become input text, keep the attachment, record credits and safe events", async () => {
  const { env, audioPath } = await fixture("notes");
  const attachment = { path: audioPath, filename: "inbound-note.ogg", mimetype: "audio/ogg; codecs=opus", kind: "ptt", size: 15 };
  const result = await transcribeVoiceNoteAttachments({
    attachments: [attachment],
    text: "Context first",
    glossary: ["Orkestr", "Modeks"],
    chatKey: "whatsapp:chat-1@g.us",
    tenantId: "admin",
    threadId: "thread-voice-1",
    sourceChannel: "whatsapp",
    env,
    fetchImpl: okFetch(SAMPLE),
  });
  const corrected = "Please ask Modeks about the Orkestr demo on Monday.";
  assert.equal(result.text, `Context first\n🎤 Voice note (0:07, English): "${corrected}"`);
  assert.equal(result.attachments[0].path, audioPath);
  assert.deepEqual(result.attachments[0].transcript, { text: corrected, model: "gpt-transcribe", languages: ["en"], seconds: 7 });
  const usage = (await listCreditUsageRecords(env)).filter((record) => record.callKind === "voice_transcription");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].sourceChannel, "whatsapp");
  assert.equal(usage[0].estimatedCostUsd, 0.000525);
  const events = await readEvents(env);
  const completed = events.find((event) => event.type === "voice_transcription_completed");
  assert.deepEqual({ threadId: completed.threadId, seconds: completed.seconds, model: completed.model, languages: completed.languages },
    { threadId: "thread-voice-1", seconds: 7, model: "gpt-transcribe", languages: ["en"] });
  const serialized = JSON.stringify(events);
  for (const forbidden of ["Modeks about", "Modex", "inbound-note", FAKE_KEY]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("failures keep the attachment and add an unavailable line", async () => {
  const cases = [
    ["http", {}, async () => new Response("{}", { status: 500 }), "transcription_http_500"],
    ["budget", { ORKESTR_TRANSCRIPTION_DAILY_BUDGET_USD: "0" }, okFetch(SAMPLE), "transcription_budget_exceeded"],
    ["rate", { ORKESTR_TRANSCRIPTION_CHAT_HOURLY_LIMIT: "1" }, okFetch(SAMPLE), "transcription_rate_limited", 2],
    ["nokey", { OPENAI_API_KEY: "", ORKESTR_VOICE_TRANSCRIPTION: "on" }, okFetch(SAMPLE), "transcription_no_key"],
  ];
  for (const [name, extra, fetchImpl, code, notes = 1] of cases) {
    const { env, audioPath } = await fixture(`fail-${name}`, extra);
    const attachments = Array.from({ length: notes }, () => ({ path: audioPath, mimetype: "audio/ogg", kind: "ptt" }));
    const result = await transcribeVoiceNoteAttachments({ attachments, text: "", glossary: [], chatKey: "c", threadId: "t", env, fetchImpl });
    const last = result.text.split("\n").at(-1);
    assert.equal(last, `🎤 Voice note: transcription unavailable (${code})`, name);
    assert.equal(result.attachments.at(-1).transcript, undefined, name);
    assert.equal(result.attachments.at(-1).path, audioPath, name);
    const failed = (await readEvents(env)).filter((event) => event.type === "voice_transcription_failed");
    assert.deepEqual(failed.map((event) => event.code).at(-1), code, name);
  }
});

test("auto mode without a key and disabled mode leave the message untouched", async () => {
  const { env, audioPath } = await fixture("auto", { OPENAI_API_KEY: "" });
  const attachments = [{ path: audioPath, kind: "ptt" }];
  assert.equal(await transcribeVoiceNoteAttachments({ attachments, env, fetchImpl: okFetch(SAMPLE) }), null);
  const off = await fixture("off", { ORKESTR_VOICE_TRANSCRIPTION: "off" });
  assert.equal(await transcribeVoiceNoteAttachments({ attachments, env: off.env, fetchImpl: okFetch(SAMPLE) }), null);
});

test("total wait is bounded by the timeout across several notes", async () => {
  const { env, audioPath } = await fixture("deadline", { ORKESTR_TRANSCRIPTION_TIMEOUT_MS: "200" });
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const started = Date.now();
  const attachments = [1, 2, 3, 4].map(() => ({ path: audioPath, kind: "ptt" }));
  const result = await transcribeVoiceNoteAttachments({ attachments, env, fetchImpl: hang });
  assert.ok(Date.now() - started < 1500);
  assert.equal(result.outcomes.length, 3);
  assert.ok(result.outcomes.every((outcome) => outcome.code === "transcription_timeout"));
});
