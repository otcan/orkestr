import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { userDataPaths } from "../packages/storage/src/paths.js";
import { createTimer, listTimers } from "../packages/core/src/timers.js";
import {
  linkUserPrivateIdentity,
  readUserPrivateIdentities,
  upsertUser,
  getUser,
} from "../packages/core/src/users.js";
import {
  buildExternalUserInviteTemplate,
  buildProvisioningChecklist,
  offboardUser,
  readUserOnboardingState,
  recordUserSupportRequest,
  setUserOnboardingState,
} from "../packages/core/src/user-onboarding.js";

function saveEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(prior) {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function json(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}

test("external user invite template and checklist describe the full beta flow", () => {
  const env = {
    ORKESTR_PUBLIC_SITE_URL: "https://orkestr.example",
    ORKESTR_PUBLIC_APP_URL: "https://app.orkestr.example",
  };
  const invite = buildExternalUserInviteTemplate({ name: "Can", inviter: "Oguz" }, env);
  const checklist = buildProvisioningChecklist({
    userId: "can",
    connectionName: "can-test",
    phoneNumber: "+10000000000",
    consented: true,
  }, env);

  assert.equal(invite.channel, "whatsapp");
  assert.match(invite.message, /Hi Can, Oguz invited you to try Orkestr/);
  assert.match(invite.message, /https:\/\/orkestr\.example\/terms/);
  assert.match(invite.message, /I agree to use Orkestr beta with my own accounts/);
  assert.equal(checklist.connectionName, "can-test");
  assert.ok(checklist.steps.find((step) => step.id === "wa-group" && step.label.includes("can-test")));
  assert.ok(checklist.steps.find((step) => step.id === "smoke"));
});

test("support requests and offboarding are user scoped and conservative", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-external-onboarding-"));
  const env = { ORKESTR_HOME: home };
  await upsertUser({ id: "can", role: "user", displayName: "Can", phoneNumber: "+10000000000" }, env);
  await linkUserPrivateIdentity("can", {
    provider: "whatsapp",
    accountId: "wa-1",
    externalId: "+10000000000",
    chatId: "chat-can",
  }, { env, actorUserId: "admin" });
  await linkUserPrivateIdentity("can", {
    provider: "gmail",
    accountId: "can@example.test",
    externalId: "can@example.test",
  }, { env, actorUserId: "admin" });
  await createTimer({
    id: "can-daily",
    label: "Can daily",
    target: "thread-can",
    prompt: "Check in",
    ownerUserId: "can",
  }, env);
  const paths = userDataPaths("can", env);
  await fs.mkdir(paths.secrets, { recursive: true });
  await fs.writeFile(path.join(paths.secrets, "gmail-token.json"), JSON.stringify({ access_token: "secret" }), "utf8");

  const support = await recordUserSupportRequest("can", { type: "pause", message: "Pause me" }, env);
  const onboarding = await setUserOnboardingState("can", { state: "active", invite: { consentedAt: "now" } }, env);
  const offboarded = await offboardUser("can", { action: "pause", revokeConnectors: true, stopTimers: true }, env);
  const afterUser = await getUser("can", env);
  const afterState = await readUserOnboardingState("can", env);
  const identities = await readUserPrivateIdentities("can", env);
  const timers = await listTimers(env);

  assert.equal(support.request.type, "pause");
  assert.match(support.reply, /pause request/);
  assert.equal(onboarding.onboarding.state, "active");
  assert.equal(offboarded.action, "pause");
  assert.equal(afterUser.status, "disabled");
  assert.equal(afterState.state, "paused");
  assert.equal(identities.length, 0);
  assert.deepEqual(timers.map((timer) => timer.id), []);
  await assert.rejects(() => fs.access(path.join(paths.secrets, "gmail-token.json")));
});

test("admin onboarding endpoints expose invite, checklist, and offboarding", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-external-onboarding-api-"));
  const prior = saveEnv([
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_RECOVER_RUNNING_ON_START",
    "ORKESTR_CODEX_BIN",
    "WHATSAPP_BRIDGE_MODE",
    "ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED",
    "ORKESTR_PUBLIC_SITE_URL",
    "ORKESTR_PUBLIC_APP_URL",
  ]);
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "0";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_CODEX_BIN = "__orkestr_codex_disabled_on_macos__";
  process.env.WHATSAPP_BRIDGE_MODE = "external";
  process.env.ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED = "1";
  process.env.ORKESTR_PUBLIC_SITE_URL = "https://orkestr.example";
  process.env.ORKESTR_PUBLIC_APP_URL = "https://app.orkestr.example";
  await upsertUser({ id: "can", role: "user", displayName: "Can", phoneNumber: "+10000000000" }, process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const invite = await json(await fetch(`${baseUrl}/api/users/onboarding/invite-template?name=Can`));
    const checklist = await json(await fetch(`${baseUrl}/api/users/onboarding/provisioning-checklist?userId=can&connectionName=can-test`));
    const paused = await json(await fetch(`${baseUrl}/api/users/can/offboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause", revokeConnectors: false, stopTimers: false }),
    }));

    assert.match(invite.message, /Hi Can/);
    assert.equal(checklist.connectionName, "can-test");
    assert.equal(paused.user.status, "disabled");
    assert.equal(paused.onboarding.state, "paused");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});
