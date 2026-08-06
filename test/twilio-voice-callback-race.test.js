import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listOrkestrMailDraftsForPrincipal } from "../packages/core/src/mail-drafts.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { setSecureSecret } from "../packages/core/src/secure-secrets.js";
import { listTwilioCalleCallbacks, reserveTwilioCalleCallback, runTwilioCalleCallback } from "../packages/connectors/src/calle-callback.js";
import { recoverTwilioVoiceCalleCallbacks, twilioVoiceAssistantConfig } from "../packages/connectors/src/twilio-voice-assistant.js";

async function voiceEnv(prefix = "orkestr-twilio-voice-race-") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_AUTH_REQUIRED: "1" };
  const principal = adminPrincipal("admin");
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_webhook_token", value: "voice-token" }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_summary_to", value: "owner@example.test" }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_public_url", value: "https://voice.example.test" }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_voice_mode", value: "calle-callback" }, principal, env);
  return env;
}

test("twilio voice CALL-E recovery and runners claim a queued callback once before starting CALL-E", async () => {
  const env = await voiceEnv();
  const config = await twilioVoiceAssistantConfig({}, env);
  const reserved = await reserveTwilioCalleCallback({
    From: "+491701234567",
    To: "+4963316993992",
    CallSid: "CA-calle-claim-race",
  }, config, env);
  const calls = [];
  const execFileAsync = async (command, args) => {
    calls.push({ command, args });
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      stdout: JSON.stringify({
        ok: true,
        run_id: "run-calle-claim-race",
        status_result: { structuredContent: { status: "COMPLETED", post_summary: "Claimed once." } },
      }),
    };
  };
  const runOptions = { execFileAsync, maxPolls: 0 };

  const results = await Promise.all([
    recoverTwilioVoiceCalleCallbacks(env, { awaitRecovery: true, ...runOptions }),
    runTwilioCalleCallback(reserved.record.id, config, env, runOptions),
    runTwilioCalleCallback(reserved.record.id, config, env, runOptions),
    runTwilioCalleCallback(reserved.record.id, config, env, runOptions),
  ]);
  const callbacks = await listTwilioCalleCallbacks(env);
  const drafts = await listOrkestrMailDraftsForPrincipal(adminPrincipal("admin"), {}, env);
  const directResults = results.slice(1);

  assert.equal(calls.length, 1);
  assert.equal(callbacks.callbacks.length, 1);
  assert.equal(callbacks.callbacks[0].callSid, "CA-calle-claim-race");
  assert.equal(callbacks.callbacks[0].status, "completed");
  assert.equal(callbacks.callbacks[0].attempts, 1);
  assert.equal(drafts.drafts.length, 1);
  assert.equal(directResults.filter((result) => result.duplicate || result.alreadyRunning).length >= 2, true);
});
