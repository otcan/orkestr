import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { setSecureSecret } from "../packages/core/src/secure-secrets.js";
import { listTwilioCalleCallbacks, reserveTwilioCalleCallback } from "../packages/connectors/src/calle-callback.js";
import { recoverTwilioVoiceCalleCallbacks, twilioVoiceAssistantConfig, twilioVoiceIncomingResponse } from "../packages/connectors/src/twilio-voice-assistant.js";
import { configureOwnedNumber, status as twilioVoiceStatus } from "../scripts/twilio-voice-assistant.mjs";

async function callbackEnv(prefix = "orkestr-twilio-voice-readiness-") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_AUTH_REQUIRED: "1" };
  const principal = adminPrincipal("admin");
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_webhook_token", value: "voice-token" }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_summary_to", value: "owner@example.test" }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_public_url", value: "https://voice.example.test" }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_mode", value: "calle-callback" }, principal, env);
  return env;
}

test("twilio voice CALL-E callback mode fails closed when signature auth is not configured", async () => {
  const env = await callbackEnv();
  const result = await twilioVoiceIncomingResponse("voice-token", {
    body: { From: "+491701234567", To: "+4963316993992", CallSid: "CA-no-signature-auth" },
    awaitCallback: true,
    execFileAsync: async () => {
      throw new Error("should_not_call_calle");
    },
  }, env);
  const callbacks = await listTwilioCalleCallbacks(env);

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
  assert.equal(result.error, "twilio_voice_signature_auth_token_required");
  assert.match(result.twiml, /Der Assistent ist gerade nicht erreichbar/);
  assert.equal(callbacks.callbacks.length, 0);
});

test("twilio voice CALL-E recovery skips queued callbacks without signature auth", async () => {
  const env = await callbackEnv();
  const config = await twilioVoiceAssistantConfig({}, env);
  await reserveTwilioCalleCallback({
    From: "+491701234567",
    To: "+4963316993992",
    CallSid: "CA-no-signature-recovery",
  }, config, env);
  const recovery = await recoverTwilioVoiceCalleCallbacks(env, {
    awaitRecovery: true,
    execFileAsync: async () => {
      throw new Error("should_not_call_calle");
    },
  });
  const callbacks = await listTwilioCalleCallbacks(env);

  assert.equal(recovery.ok, false);
  assert.equal(recovery.skipped, true);
  assert.equal(recovery.reason, "twilio_voice_signature_auth_token_required");
  assert.equal(callbacks.callbacks[0].status, "queued");
  assert.equal(callbacks.callbacks[0].attempts, 0);
});

test("twilio voice status separates code readiness from missing callback operator config", async () => {
  const env = await callbackEnv();
  const before = await twilioVoiceStatus({ userId: "admin" }, env);
  assert.equal(before.ok, false);
  assert.equal(before.callback.enabled, true);
  assert.equal(before.callback.configured, false);
  assert.equal(before.readiness.code.calleCallback, true);
  assert.equal(before.readiness.operatorConfig.callbackSignatureAuthTokenConfigured, false);
  assert.deepEqual(before.readiness.blockers, ["twilio_voice_signature_auth_token_required"]);

  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_auth_token", value: "twilio-auth-secret" }, adminPrincipal("admin"), env);
  const after = await twilioVoiceStatus({ userId: "admin" }, env);
  assert.equal(after.ok, true);
  assert.equal(after.callback.configured, true);
  assert.equal(after.readiness.ready, true);
  assert.deepEqual(after.readiness.blockers, []);
});

test("twilio number configuration refuses callback mode before signature auth is configured", async () => {
  const env = await callbackEnv();
  await assert.rejects(
    () => configureOwnedNumber({
      yes: true,
      userId: "admin",
      publicUrl: "https://voice.example.test",
      phoneNumber: "+49301234567",
    }, env),
    /twilio_voice_signature_auth_token_required/,
  );
});
