import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setSecureSecret } from "../packages/core/src/secure-secrets.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { authorizeHttpRequest } from "../packages/core/src/security.js";
import { listOrkestrMailDraftsForPrincipal } from "../packages/core/src/mail-drafts.js";
import { listTwilioCalleCallbacks } from "../packages/connectors/src/calle-callback.js";
import {
  createTwilioVoiceSummaryDraft,
  twilioVoiceAssistantConfig,
  twilioVoiceIncomingResponse,
} from "../packages/connectors/src/twilio-voice-assistant.js";

async function voiceEnv(prefix = "orkestr-twilio-voice-") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_AUTH_REQUIRED: "1" };
  const principal = adminPrincipal("admin");
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_webhook_token", value: "voice-token" }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_summary_to", value: "owner@example.test" }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_public_url", value: "https://voice.example.test" }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_assistant_label", value: "Account owner's <assistant>" }, principal, env);
  return env;
}

test("twilio voice webhook routes are reachable before browser pairing but other connector routes stay blocked", async () => {
  const env = await voiceEnv();
  const incoming = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/twilio/voice/voice-token/incoming",
    headers: {},
  }, env);
  const gather = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/twilio/voice/voice-token/gather",
    headers: {},
  }, env);
  const other = await authorizeHttpRequest({
    method: "POST",
    url: "/api/connectors/twilio/voice/voice-token/delete",
    headers: {},
  }, env);

  assert.equal(incoming.ok, true);
  assert.equal(gather.ok, true);
  assert.equal(other.ok, false);
  assert.equal(other.error, "browser_pairing_required");
});

test("twilio voice incoming returns German speech gather TwiML with escaped assistant label", async () => {
  const env = await voiceEnv();
  const result = await twilioVoiceIncomingResponse("voice-token", {}, env);

  assert.equal(result.ok, true);
  assert.match(result.twiml, /^<\?xml version="1\.0" encoding="UTF-8"\?><Response>/);
  assert.match(result.twiml, /<Gather input="speech"/);
  assert.match(result.twiml, /language="de-DE"/);
  assert.match(result.twiml, /timeout="12"/);
  assert.match(result.twiml, /actionOnEmptyResult="true"/);
  assert.match(result.twiml, /https:\/\/voice\.example\.test\/api\/connectors\/twilio\/voice\/voice-token\/gather/);
  assert.match(result.twiml, /Account owner&apos;s &lt;assistant&gt;/);
  assert.match(result.twiml, /gewünschte Person ist gerade nicht direkt am Telefon/);
  assert.doesNotMatch(result.twiml, /Ich habe leider nichts gehört/);
  assert.doesNotMatch(result.twiml, /Account owner's <assistant>/);
});

test("twilio voice incoming can use configured bilingual prompt messages", async () => {
  const env = await voiceEnv();
  const principal = adminPrincipal("admin");
  await setSecureSecret({
    scope: "user",
    ownerUserId: "admin",
    name: "twilio_voice_intro_message",
    value: "Hallo, hier ist der Telefonassistent von Example Owner. Bitte nennen Sie Ihren Namen und den Grund Ihres Anrufs.",
  }, principal, env);
  await setSecureSecret({
    scope: "user",
    ownerUserId: "admin",
    name: "twilio_voice_intro_message_en",
    value: "Hello, this is Example Owner's phone assistant. Please say your name and why you are calling.",
  }, principal, env);
  await setSecureSecret({
    scope: "user",
    ownerUserId: "admin",
    name: "twilio_voice_english_language",
    value: "en-US",
  }, principal, env);

  const result = await twilioVoiceIncomingResponse("voice-token", {}, env);

  assert.equal(result.ok, true);
  assert.match(result.twiml, /Telefonassistent von Example Owner/);
  assert.match(result.twiml, /language="en-US"/);
  assert.match(result.twiml, /Example Owner&apos;s phone assistant/);
  assert.match(result.twiml, /<Gather input="speech"/);
  assert.match(result.twiml, /language="de-DE"/);
});

test("twilio voice CALL-E live mode bridges the inbound call to a configured media stream", async () => {
  const env = await voiceEnv();
  const principal = adminPrincipal("admin");
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_mode", value: "calle-live" }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_calle_live_stream_url", value: "wss://calle-live.example.test/twilio/stream?token=secret" }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_calle_goal", value: "Ask the caller why they called and summarize the next action." }, principal, env);

  const result = await twilioVoiceIncomingResponse("voice-token", {
    body: {
      From: "+491701234567",
      To: "+49301234567",
      CallSid: "CA-live-1",
    },
  }, env);

  assert.equal(result.ok, true);
  assert.equal(result.config.mode, "calle_live");
  assert.match(result.twiml, /<Connect><Stream url="wss:\/\/calle-live\.example\.test\/twilio\/stream\?token=secret">/);
  assert.match(result.twiml, /<Parameter name="assistant_label" value="Account owner&apos;s &lt;assistant&gt;"\/>/);
  assert.match(result.twiml, /<Parameter name="call_sid" value="CA-live-1"\/>/);
  assert.match(result.twiml, /<Parameter name="caller" value="\+491701234567"\/>/);
  assert.match(result.twiml, /<Parameter name="goal" value="Ask the caller why they called and summarize the next action\."\/>/);
  assert.doesNotMatch(result.twiml, /<Gather input="speech"/);
  assert.doesNotMatch(result.twiml, /Rückruf/);
  assert.doesNotMatch(result.twiml, /<Hangup\/>/);
});

test("twilio voice CALL-E live mode fails closed when the media stream is not configured", async () => {
  const env = await voiceEnv();
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_mode", value: "calle-live" }, adminPrincipal("admin"), env);

  const result = await twilioVoiceIncomingResponse("voice-token", {
    body: {
      From: "+491701234567",
      To: "+49301234567",
      CallSid: "CA-live-missing",
    },
  }, env);

  assert.equal(result.ok, true);
  assert.equal(result.error, "twilio_voice_calle_live_stream_url_missing");
  assert.match(result.twiml, /CALL-E Live-Assistent ist noch nicht verbunden/);
  assert.match(result.twiml, /<Hangup\/>/);
  assert.doesNotMatch(result.twiml, /<Gather input="speech"/);
  assert.doesNotMatch(result.twiml, /Rückruf/);
});

test("twilio voice invalid webhook token is rejected without exposing config", async () => {
  const env = await voiceEnv();
  const result = await twilioVoiceIncomingResponse("wrong-token", {}, env);

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, "twilio_voice_webhook_token_invalid");
  assert.equal(JSON.stringify(result).includes("owner@example.test"), false);
});

test("twilio voice gather creates an Orkestr email draft from speech input", async () => {
  const env = await voiceEnv();
  const config = await twilioVoiceAssistantConfig({}, env);
  const result = await createTwilioVoiceSummaryDraft({
    SpeechResult: "I am calling about the contract renewal tomorrow.",
    Confidence: "0.92",
    From: "+491701234567",
    To: "+49301234567",
    CallSid: "CA-call-1",
  }, config, env);
  const drafts = await listOrkestrMailDraftsForPrincipal(adminPrincipal("admin"), {}, env);

  assert.equal(result.ok, true);
  assert.equal(drafts.drafts.length, 1);
  assert.deepEqual(drafts.drafts[0].to, ["owner@example.test"]);
  assert.match(drafts.drafts[0].subject, /\+491701234567/);
  assert.match(drafts.drafts[0].body, /contract renewal tomorrow/);
  assert.match(drafts.drafts[0].body, /Speech confidence: 0\.92/);
  assert.match(result.twiml, /Danke/);
});

test("twilio voice gather creates a missed-call draft when no speech is captured", async () => {
  const env = await voiceEnv();
  const config = await twilioVoiceAssistantConfig({}, env);
  const result = await createTwilioVoiceSummaryDraft({
    From: "+491701234567",
    To: "+49301234567",
    CallSid: "CA-silent-1",
  }, config, env);
  const drafts = await listOrkestrMailDraftsForPrincipal(adminPrincipal("admin"), {}, env);

  assert.equal(result.ok, true);
  assert.equal(drafts.drafts.length, 1);
  assert.match(drafts.drafts[0].subject, /Missed assistant call/);
  assert.match(drafts.drafts[0].body, /No speech was captured/);
  assert.match(result.twiml, /nicht sicher verstehen/);
});

test("twilio voice CALL-E mode starts callback call and drafts terminal summary", async () => {
  const env = await voiceEnv();
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_mode", value: "calle-callback" }, adminPrincipal("admin"), env);
  const calls = [];
  const execFileAsync = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return {
      stdout: JSON.stringify({
        ok: true,
        run_id: "run-calle-1",
        status_result: {
          structuredContent: {
            status: "COMPLETED",
            post_summary: "The caller wants to discuss a contract renewal.",
            transcript: "Caller asked for a call back tomorrow.",
            call_id: "call-calle-1",
            extracted: {
              calling: {
                duration_seconds: 42,
                started_at: "2026-06-01T10:00:00Z",
                ended_at: "2026-06-01T10:00:42Z",
              },
            },
          },
        },
      }),
    };
  };
  const result = await twilioVoiceIncomingResponse("voice-token", {
    body: {
      From: "+491701234567",
      To: "+4963316993992",
      CallSid: "CA-calle-1",
    },
    awaitCallback: true,
    execFileAsync,
    maxPolls: 0,
  }, env);
  const drafts = await listOrkestrMailDraftsForPrincipal(adminPrincipal("admin"), {}, env);
  const callbacks = await listTwilioCalleCallbacks(env);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "calle");
  assert.deepEqual(calls[0].args.slice(0, 4), ["call", "start", "--to-phone", "+491701234567"]);
  assert.equal(calls[0].env.CALLE_SOURCE, "skills_sh");
  assert.match(calls[0].args.join(" "), /--language German/);
  assert.match(calls[0].args.join(" "), /--region DE/);
  assert.match(result.twiml, /CALL-E Assistent/);
  assert.match(result.twiml, /Rückruf/);
  assert.match(result.twiml, /<Hangup\/>/);
  assert.doesNotMatch(result.twiml, /<Gather input="speech"/);
  assert.equal(drafts.drafts.length, 1);
  assert.match(drafts.drafts[0].subject, /CALL-E call summary/);
  assert.match(drafts.drafts[0].body, /contract renewal/);
  assert.match(drafts.drafts[0].body, /Caller asked for a call back/);
  assert.equal(callbacks.callbacks.length, 1);
  assert.equal(callbacks.callbacks[0].status, "completed");
  assert.equal(callbacks.callbacks[0].runId, "run-calle-1");
});

test("twilio voice CALL-E mode dedupes repeated Twilio incoming webhooks", async () => {
  const env = await voiceEnv();
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_mode", value: "calle-callback" }, adminPrincipal("admin"), env);
  const calls = [];
  const execFileAsync = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return {
      stdout: JSON.stringify({
        ok: true,
        run_id: "run-calle-dupe",
        status_result: { structuredContent: { status: "COMPLETED", post_summary: "Done." } },
      }),
    };
  };

  await twilioVoiceIncomingResponse("voice-token", {
    body: { From: "+491701234567", To: "+4963316993992", CallSid: "CA-calle-dupe" },
    awaitCallback: true,
    execFileAsync,
    maxPolls: 0,
  }, env);
  const second = await twilioVoiceIncomingResponse("voice-token", {
    body: { From: "+491701234567", To: "+4963316993992", CallSid: "CA-calle-dupe" },
    awaitCallback: true,
    execFileAsync,
    maxPolls: 0,
  }, env);
  const drafts = await listOrkestrMailDraftsForPrincipal(adminPrincipal("admin"), {}, env);
  const callbacks = await listTwilioCalleCallbacks(env);

  assert.equal(calls.length, 1);
  assert.equal(second.callback.duplicate, true);
  assert.match(second.twiml, /bereits gestartet/);
  assert.equal(drafts.drafts.length, 1);
  assert.equal(callbacks.callbacks.length, 1);
});

test("twilio voice CALL-E mode skips callback when Twilio hides caller number", async () => {
  const env = await voiceEnv();
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_mode", value: "calle-callback" }, adminPrincipal("admin"), env);
  const result = await twilioVoiceIncomingResponse("voice-token", {
    body: { From: "anonymous", To: "+4963316993992", CallSid: "CA-calle-anon" },
    awaitCallback: true,
    execFileAsync: async () => {
      throw new Error("should_not_call_calle");
    },
  }, env);
  const drafts = await listOrkestrMailDraftsForPrincipal(adminPrincipal("admin"), {}, env);
  const callbacks = await listTwilioCalleCallbacks(env);

  assert.equal(result.callback.ok, false);
  assert.equal(callbacks.callbacks[0].status, "skipped");
  assert.equal(callbacks.callbacks[0].reason, "caller_phone_not_callable");
  assert.match(result.twiml, /ohne erkannte Telefonnummer/);
  assert.equal(drafts.drafts.length, 0);
});

test("twilio voice CALL-E mode records start failures as owner-visible drafts", async () => {
  const env = await voiceEnv();
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_mode", value: "calle-callback" }, adminPrincipal("admin"), env);
  const execFileAsync = async () => {
    const error = new Error("Command failed");
    error.stdout = JSON.stringify({
      ok: false,
      error: { code: "auth_required", message: "A usable CALL-E auth token is required." },
    });
    throw error;
  };

  const result = await twilioVoiceIncomingResponse("voice-token", {
    body: { From: "+491701234567", To: "+4963316993992", CallSid: "CA-calle-auth" },
    awaitCallback: true,
    execFileAsync,
    maxPolls: 0,
  }, env);
  const drafts = await listOrkestrMailDraftsForPrincipal(adminPrincipal("admin"), {}, env);
  const callbacks = await listTwilioCalleCallbacks(env);

  assert.equal(result.ok, true);
  assert.match(result.twiml, /CALL-E Assistent/);
  assert.equal(callbacks.callbacks[0].status, "failed");
  assert.equal(callbacks.callbacks[0].error, "auth_required");
  assert.equal(drafts.drafts.length, 1);
  assert.match(drafts.drafts[0].subject, /CALL-E callback failed/);
  assert.match(drafts.drafts[0].body, /auth_required/);
});
