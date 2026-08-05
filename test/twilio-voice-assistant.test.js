import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setSecureSecret } from "../packages/core/src/secure-secrets.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { authorizeHttpRequest } from "../packages/core/src/security.js";
import { listOrkestrMailDraftsForPrincipal } from "../packages/core/src/mail-drafts.js";
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
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_assistant_label", value: "Can's <assistant>" }, principal, env);
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
  assert.match(result.twiml, /https:\/\/voice\.example\.test\/api\/connectors\/twilio\/voice\/voice-token\/gather/);
  assert.match(result.twiml, /Can&apos;s &lt;assistant&gt;/);
  assert.doesNotMatch(result.twiml, /Can's <assistant>/);
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
