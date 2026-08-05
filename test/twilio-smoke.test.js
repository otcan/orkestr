import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setSecureSecret } from "../packages/core/src/secure-secrets.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { formatTwilioSmokeResult, runTwilioSmoke } from "../scripts/twilio-smoke.mjs";

test("twilio smoke uses Orkestr secrets for a read-only account probe and redacts output", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-twilio-smoke-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  const principal = adminPrincipal("admin");
  const accountSid = `AC${"1".repeat(32)}`;
  const apiKeySid = `SK${"2".repeat(32)}`;
  const apiKeySecret = "top-secret-api-key-secret";
  let authorization = "";
  const calls = [];

  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_account_sid", value: accountSid }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_api_key_sid", value: apiKeySid }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_api_key_secret", value: apiKeySecret }, principal, env);

  const result = await runTwilioSmoke({
    userId: "admin",
    env,
    apiBase: "https://twilio.test",
  }, {
    fetchImpl: async (url, options) => {
      calls.push(String(url));
      authorization = options.headers.authorization;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          sid: accountSid,
          status: "active",
          friendly_name: "Test Account",
        }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.account.sid, "AC11...1111");
  assert.equal(result.account.status, "active");
  assert.equal(result.credentials.apiKeySid.sid, "SK22...2222");
  assert.equal(calls.length, 1);
  assert.equal(calls[0], `https://twilio.test/2010-04-01/Accounts/${accountSid}.json`);
  assert.equal(Buffer.from(authorization.replace(/^Basic /, ""), "base64").toString("utf8"), `${apiKeySid}:${apiKeySecret}`);

  const serialized = JSON.stringify(result);
  const formatted = formatTwilioSmokeResult(result);
  assert.equal(serialized.includes(accountSid), false);
  assert.equal(serialized.includes(apiKeySid), false);
  assert.equal(serialized.includes(apiKeySecret), false);
  assert.equal(formatted.includes(accountSid), false);
  assert.equal(formatted.includes(apiKeySid), false);
  assert.equal(formatted.includes(apiKeySecret), false);
});

test("twilio smoke reports missing credentials without creating network calls", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-twilio-smoke-missing-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  let called = false;

  await assert.rejects(
    () => runTwilioSmoke({ userId: "admin", env, apiBase: "https://twilio.test" }, {
      fetchImpl: async () => {
        called = true;
        throw new Error("should_not_fetch");
      },
    }),
    /missing_twilio_credentials:Account SID, API Key SID, API Key Secret/,
  );
  assert.equal(called, false);
});

test("twilio smoke number check reports returned numbers and redacts phone details", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-twilio-smoke-numbers-"));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  const principal = adminPrincipal("admin");
  const accountSid = `AC${"3".repeat(32)}`;
  const apiKeySid = `SK${"4".repeat(32)}`;
  const apiKeySecret = "number-secret";

  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_account_sid", value: accountSid }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_api_key_sid", value: apiKeySid }, principal, env);
  await setSecureSecret({ scope: "user", ownerUserId: "admin", name: "twilio_api_key_secret", value: apiKeySecret }, principal, env);

  const result = await runTwilioSmoke({
    userId: "admin",
    env,
    apiBase: "https://twilio.test",
    includeNumbers: true,
  }, {
    fetchImpl: async (url) => {
      if (String(url).includes("IncomingPhoneNumbers")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            page_size: 20,
            incoming_phone_numbers: [{
              sid: `PN${"5".repeat(32)}`,
              phone_number: "+15551234567",
              friendly_name: "Voice line",
              capabilities: { voice: true, sms: false },
            }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sid: accountSid, status: "active" }),
      };
    },
  });

  assert.equal(result.numbers.checked, true);
  assert.equal(result.numbers.count, 1);
  assert.equal(result.numbers.sample[0].sid, "PN55...5555");
  assert.equal(result.numbers.sample[0].phoneNumber, "********4567");
  assert.equal(JSON.stringify(result).includes("+15551234567"), false);
});
