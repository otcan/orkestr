import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { normalizeWhatsAppPersistentBinding } from "../packages/connectors/src/whatsapp-binding-registry.js";
import { routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { whatsappVoiceNoteTranscriptionAllowed } from "../packages/connectors/src/whatsapp-voice-notes.js";
import { dataPaths } from "../packages/storage/src/paths.js";

const TRANSCRIPT = "Remind me to call Modex tomorrow.";

async function setup(prefix, { binding = {}, extraEnv = {}, thread = {} } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-wa-voice-${prefix}-`));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
    OPENAI_API_KEY: "sk-test-fake-wa-voice",
    ORKESTR_TRANSCRIPTION_KEYWORDS: "Modeks",
    ...extraEnv,
  };
  const mediaDir = path.join(home, "whatsapp-media");
  await fs.mkdir(mediaDir, { recursive: true });
  const audioPath = path.join(mediaDir, "note-1.ogg");
  await fs.writeFile(audioPath, Buffer.from("OggS-fake"));
  await createThread({
    id: "voice-thread",
    name: "Voice Thread",
    ...thread,
    binding: {
      connector: "whatsapp",
      chatId: "voice-chat@g.us",
      enabled: true,
      senderAccountId: "main",
      responderAccountId: "main",
      outboundAccountId: "main",
      senderContactId: "15550000001@c.us",
      ...binding,
    },
  }, env);
  return { home, env, audioPath };
}

function mockFetch(calls, { status = 200 } = {}) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    if (status !== 200) return new Response("{}", { status });
    return new Response(JSON.stringify({ text: TRANSCRIPT, languages: [{ code: "en" }], usage: { type: "duration", seconds: 7 } }), { status: 200 });
  };
}

function voiceInput(audioPath, overrides = {}) {
  return {
    eventId: `wa-voice-${Math.random().toString(16).slice(2)}`,
    chatId: "voice-chat@g.us",
    accountId: "main",
    from: "15550000001@c.us",
    text: `WhatsApp attachment received.\n\nAttachment 1: ${audioPath}\nmimetype: audio/ogg; codecs=opus`,
    attachments: [{ path: audioPath, filename: "note-1.ogg", mimetype: "audio/ogg; codecs=opus", kind: "ptt", size: 9 }],
    ...overrides,
  };
}

async function eventsText(env) {
  return fs.readFile(dataPaths(env).events, "utf8").catch(() => "");
}

test("owner/self voice note is transcribed into the enqueued thread input", async () => {
  const { env, audioPath } = await setup("owner");
  const calls = [];
  const routed = await routeWhatsAppInbound(voiceInput(audioPath, { fromMe: true }), env, mockFetch(calls));
  assert.equal(routed.threadId, "voice-thread");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/audio\/transcriptions$/);
  assert.deepEqual(calls[0].init.body.getAll("keywords[]"), ["Orkestr", "Voice Thread", "Admin", "Modeks"]);
  const messages = await listThreadMessages("voice-thread", env);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, '🎤 Voice note (0:07, English): "Remind me to call Modeks tomorrow."');
  const attachment = (messages[0].attachments || [])[0];
  assert.ok(attachment, "audio attachment kept");
  assert.equal(attachment.transcript.text, "Remind me to call Modeks tomorrow.");
  assert.equal(attachment.transcript.seconds, 7);
  const events = await eventsText(env);
  assert.match(events, /voice_transcription_completed/);
  assert.equal(events.includes("Remind me"), false);
  assert.equal(events.includes("sk-test-fake-wa-voice"), false);
});

test("owner admin number from ORKESTR_WHATSAPP_OWNER_CONTACT_IDS is treated as owner/self", async () => {
  const { env, audioPath } = await setup("owner-contact", { extraEnv: { ORKESTR_WHATSAPP_OWNER_CONTACT_IDS: "15550000001@c.us" } });
  const calls = [];
  await routeWhatsAppInbound(voiceInput(audioPath, { text: "listen to this" }), env, mockFetch(calls));
  const [message] = await listThreadMessages("voice-thread", env);
  assert.equal(calls.length, 1);
  assert.equal(message.text, 'listen to this\n🎤 Voice note (0:07, English): "Remind me to call Modeks tomorrow."');
});

test("external sender (binding owner contact, not owner/self) is not transcribed by default", async () => {
  const { env, audioPath } = await setup("external");
  const calls = [];
  await routeWhatsAppInbound(voiceInput(audioPath), env, mockFetch(calls));
  const [message] = await listThreadMessages("voice-thread", env);
  assert.equal(calls.length, 0);
  assert.match(message.text, /^WhatsApp attachment received\./);
  assert.equal(message.text.includes("🎤"), false);
});

test("binding flag true enables external chats and false disables owner chats", async () => {
  const enabled = await setup("flag-true", { binding: { transcribeVoiceNotes: true } });
  const enabledCalls = [];
  await routeWhatsAppInbound(voiceInput(enabled.audioPath), enabled.env, mockFetch(enabledCalls));
  assert.equal(enabledCalls.length, 1);
  assert.match((await listThreadMessages("voice-thread", enabled.env))[0].text, /🎤 Voice note \(0:07, English\)/);

  const disabled = await setup("flag-false", { binding: { transcribeVoiceNotes: false } });
  const disabledCalls = [];
  await routeWhatsAppInbound(voiceInput(disabled.audioPath, { fromMe: true }), disabled.env, mockFetch(disabledCalls));
  assert.equal(disabledCalls.length, 0);
  assert.equal((await listThreadMessages("voice-thread", disabled.env))[0].text.includes("🎤"), false);
});

test("owner LID aliases (ORKESTR_WHATSAPP_OWNER_ALIASES) match group messages sent by LID", () => {
  const env = { ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_WHATSAPP_OWNER_CONTACT_IDS: "15550000001@c.us", ORKESTR_WHATSAPP_OWNER_ALIASES: "100000000000001@lid" };
  const thread = { ownerUserId: "admin" };
  assert.equal(whatsappVoiceNoteTranscriptionAllowed({ inboundSecurity: {}, from: "100000000000001@lid", thread, env }), true);
  assert.equal(whatsappVoiceNoteTranscriptionAllowed({ inboundSecurity: {}, from: "100000000000002@lid", thread, env }), false);
  // A phone-number entry alone does not match the same person's LID.
  assert.equal(whatsappVoiceNoteTranscriptionAllowed({ inboundSecurity: {}, from: "100000000000001@lid", thread, env: { ...env, ORKESTR_WHATSAPP_OWNER_ALIASES: "" } }), false);
});

test("threads owned by another user are not owner/self chats", () => {
  const env = { ORKESTR_ADMIN_USER_ID: "admin" };
  const fromMe = { participant: { fromMe: true }, effectiveRole: "owner" };
  assert.equal(whatsappVoiceNoteTranscriptionAllowed({ inboundSecurity: fromMe, thread: { ownerUserId: "admin" }, env }), true);
  assert.equal(whatsappVoiceNoteTranscriptionAllowed({ inboundSecurity: fromMe, thread: { ownerUserId: "friend-example" }, env }), false);
  assert.equal(whatsappVoiceNoteTranscriptionAllowed({ binding: { transcribeVoiceNotes: true }, inboundSecurity: {}, thread: { ownerUserId: "friend-example" }, env }), true);
});

test("transcription failure still enqueues the message with the unavailable line", async () => {
  const { env, audioPath } = await setup("failure");
  const calls = [];
  const routed = await routeWhatsAppInbound(voiceInput(audioPath, { fromMe: true }), env, mockFetch(calls, { status: 500 }));
  assert.ok(routed.message?.id || routed.messageId || routed.threadId);
  const [message] = await listThreadMessages("voice-thread", env);
  assert.equal(message.text, "🎤 Voice note: transcription unavailable (transcription_http_500)");
  assert.equal(message.attachments?.[0]?.transcript, undefined);
  assert.match(await eventsText(env), /"code":"transcription_http_500"/);
});

test("binding normalizer keeps transcribeVoiceNotes as a tri-state flag", () => {
  const base = { chatId: "voice-chat@g.us", responderAccountId: "main", threadId: "voice-thread" };
  const unset = normalizeWhatsAppPersistentBinding(base, {}, {});
  assert.equal(Object.hasOwn(unset, "transcribeVoiceNotes"), false);
  const on = normalizeWhatsAppPersistentBinding({ ...base, transcribeVoiceNotes: "true" }, {}, {});
  assert.equal(on.transcribeVoiceNotes, true);
  const preserved = normalizeWhatsAppPersistentBinding({ chatId: "voice-chat@g.us", responderAccountId: "main" }, on, {});
  assert.equal(preserved.transcribeVoiceNotes, true);
  const off = normalizeWhatsAppPersistentBinding({ ...base, transcribeVoiceNotes: false }, on, {});
  assert.equal(off.transcribeVoiceNotes, false);
  const cleared = normalizeWhatsAppPersistentBinding({ ...base, transcribeVoiceNotes: null }, on, {});
  assert.equal(Object.hasOwn(cleared, "transcribeVoiceNotes"), false);
});
