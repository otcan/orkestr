import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  logoutLocalWhatsAppAccount,
  resetLocalWhatsAppBridgeForTest,
  startLocalWhatsAppAccount,
} from "../packages/connectors/src/whatsapp-local-bridge.js";
import { evaluateWhatsAppInboundSecurity } from "../packages/connectors/src/whatsapp-inbound-security.js";
import { createAndBindWhatsAppThreadGroup } from "../packages/connectors/src/whatsapp-thread-groups.js";
import { createThread, getThread } from "../packages/core/src/threads.js";
import {
  clearWhatsAppAccountPaired,
  markWhatsAppAccountPaired,
  pairedAccountsPath,
  pairedAutostartBlocker,
  readPairedWhatsAppAccounts,
  startPairedLocalWhatsAppAccounts,
} from "../packages/connectors/src/whatsapp-paired-accounts.js";

// Self-hosted WhatsApp (mode A) in docs/whatsapp-docker-onboarding-plan.md.
// Synthetic only: fake whatsapp-web.js client, temporary ORKESTR_HOME.
const run = promisify(execFile);

async function tempHome(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("paired markers are stored privately, hold no credentials, and survive re-reads", async () => {
  const env = { ORKESTR_HOME: await tempHome("orkestr-wa-paired-") };
  assert.deepEqual(await readPairedWhatsAppAccounts(env), {});
  await Promise.all([
    markWhatsAppAccountPaired("account-1", env, new Date("2026-10-11T10:00:00Z")),
    markWhatsAppAccountPaired("account-2", env, new Date("2026-10-11T10:00:01Z")),
  ]);
  await markWhatsAppAccountPaired("account-1", env, new Date("2026-10-11T11:00:00Z"));
  const accounts = await readPairedWhatsAppAccounts(env);
  assert.deepEqual(Object.keys(accounts).sort(), ["account-1", "account-2"], "concurrent marks are not lost");
  assert.equal(accounts["account-1"].pairedAt, "2026-10-11T10:00:00.000Z");
  assert.equal(accounts["account-1"].lastReadyAt, "2026-10-11T11:00:00.000Z");
  const raw = await fs.readFile(pairedAccountsPath(env), "utf8");
  assert.doesNotMatch(raw, /token|secret|session|key/i);
  assert.equal((await fs.stat(pairedAccountsPath(env))).mode & 0o777, 0o600);
  assert.equal(await markWhatsAppAccountPaired("../evil", env), false, "unsafe account ids are ignored");
  assert.equal(await clearWhatsAppAccountPaired("account-2", env), true);
  assert.deepEqual(Object.keys(await readPairedWhatsAppAccounts(env)), ["account-1"]);
});

test("paired auto-start only runs when the built-in bridge is the active transport", async () => {
  const home = await tempHome("orkestr-wa-paired-guard-");
  const local = async () => ({});
  assert.equal(await pairedAutostartBlocker({ ORKESTR_HOME: home }, { readConfig: local }), "");
  assert.equal(await pairedAutostartBlocker({ ORKESTR_HOME: home, ORKESTR_WHATSAPP_AUTOSTART: "0" }, { readConfig: local }), "autostart_disabled");
  assert.equal(await pairedAutostartBlocker({ ORKESTR_HOME: home, ORKESTR_WHATSAPP_AUTOSTART: "1" }, { readConfig: local }), "explicit_autostart_configured");
  assert.equal(await pairedAutostartBlocker({ ORKESTR_HOME: home, ORKESTR_WA_WORKER_SOCKET: "/run/x.sock" }, { readConfig: local }), "dedicated_worker_configured");
  assert.equal(await pairedAutostartBlocker({ ORKESTR_HOME: home, ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1" }, { readConfig: local }), "external_bridge_configured");
  assert.equal(await pairedAutostartBlocker({ ORKESTR_HOME: home, WHATSAPP_BRIDGE_MODE: "relay" }, { readConfig: local }), "bridge_not_local");
  assert.equal(await pairedAutostartBlocker({ ORKESTR_HOME: home }, { readConfig: async () => ({ bridgeMode: "external" }) }), "bridge_not_local");

  const env = { ORKESTR_HOME: home };
  const started = [];
  await markWhatsAppAccountPaired("account-1", env);
  await markWhatsAppAccountPaired("account-2", env);
  const result = await startPairedLocalWhatsAppAccounts(env, {
    readConfig: local,
    startAccount: async (accountId) => {
      started.push(accountId);
      if (accountId === "account-2") throw new Error("chrome missing");
      return { state: "starting" };
    },
  });
  assert.deepEqual(started, ["account-1", "account-2"]);
  assert.deepEqual(result.accounts, [{ accountId: "account-1", state: "starting" }, { accountId: "account-2", state: "failed", error: "chrome missing" }]);
  const blocked = await startPairedLocalWhatsAppAccounts({ ...env, ORKESTR_WA_WORKER_URL: "http://127.0.0.1:1" }, { readConfig: local, startAccount: async () => assert.fail("must not start") });
  assert.equal(blocked.reason, "dedicated_worker_configured");
});

function fakeWhatsAppWeb(calls) {
  const clients = [];
  class LocalAuth {
    constructor(options) {
      calls.push(["local-auth", options.clientId, options.dataPath]);
    }
  }
  class Client {
    constructor() {
      this.handlers = new Map();
      this.info = { wid: { _serialized: "15550000001@c.us", user: "15550000001" }, pushname: "Test" };
      clients.push(this);
    }
    on(event, handler) {
      this.handlers.set(event, handler);
      return this;
    }
    async emit(event, ...args) {
      await this.handlers.get(event)?.(...args);
    }
    initialize() {
      calls.push("initialize");
      return Promise.resolve();
    }
    async getState() {
      return "CONNECTED";
    }
    async logout() {
      calls.push("logout");
    }
    async destroy() {
      calls.push("destroy");
    }
  }
  const options = {
    listChromeProcesses: async () => [],
    loadBridgeDependencies: async () => ({ whatsapp: { Client, LocalAuth }, qrcode: { toString: async () => "<svg/>", toFile: async () => {} } }),
  };
  return { clients, options };
}

async function waitFor(check, label) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("a QR-paired account is remembered, reconnects after a restart without a QR, and logout forgets it", async () => {
  const home = await tempHome("orkestr-wa-self-hosted-");
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "account-1" };
  const calls = [];
  const fake = fakeWhatsAppWeb(calls);
  try {
    assert.equal((await startLocalWhatsAppAccount("account-1", env, fake.options)).state, "starting");
    await waitFor(() => fake.clients.length === 1, "client");
    await fake.clients[0].emit("qr", "synthetic-qr-payload");
    await fake.clients[0].emit("ready");
    await waitFor(async () => Boolean((await readPairedWhatsAppAccounts(env))["account-1"]), "paired marker");
    const sessionPath = calls.find((call) => Array.isArray(call) && call[0] === "local-auth")[2];
    assert.ok(sessionPath.startsWith(home), "the WhatsApp session stays inside this instance's data directory");
    assert.equal((await fs.stat(sessionPath)).mode & 0o777, 0o700, "session root is private");

    // Simulated container restart: the in-memory bridge is gone, the volume stays.
    await resetLocalWhatsAppBridgeForTest(env);
    const restart = await startPairedLocalWhatsAppAccounts(env, {
      readConfig: async () => ({}),
      startAccount: (accountId, startEnv) => startLocalWhatsAppAccount(accountId, startEnv, fake.options),
    });
    assert.deepEqual(restart.accounts.map((item) => item.accountId), ["account-1"]);
    await waitFor(() => fake.clients.length === 2, "client after restart");
    const authCalls = calls.filter((call) => Array.isArray(call) && call[0] === "local-auth");
    assert.equal(authCalls[1][2], sessionPath, "the restarted client reuses the same session directory");
    await fake.clients[1].emit("ready");

    await logoutLocalWhatsAppAccount("account-1", env);
    assert.deepEqual(await readPairedWhatsAppAccounts(env), {}, "logout clears the paired marker");
    const after = await startPairedLocalWhatsAppAccounts(env, { readConfig: async () => ({}), startAccount: async () => assert.fail("must not start after logout") });
    assert.deepEqual(after.accounts, []);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("an auth failure forgets the pairing so a broken session is not restarted in a loop", async () => {
  const home = await tempHome("orkestr-wa-auth-failure-");
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "account-1" };
  const fake = fakeWhatsAppWeb([]);
  try {
    await markWhatsAppAccountPaired("account-1", env);
    await startLocalWhatsAppAccount("account-1", env, fake.options);
    await waitFor(() => fake.clients.length === 1, "client");
    await fake.clients[0].emit("auth_failure", "synthetic");
    await waitFor(async () => !(await readPairedWhatsAppAccounts(env))["account-1"], "marker cleared");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("the Docker entrypoint points puppeteer at the system Chromium and no longer forces relay", async () => {
  const home = await tempHome("orkestr-entrypoint-");
  const bin = path.join(home, "bin");
  await fs.mkdir(bin);
  const fakeChromium = path.join(bin, "chromium");
  await fs.writeFile(fakeChromium, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const baseEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ORKESTR_HOME: path.join(home, "data") };
  const printEnv = ["-c", "printf '%s|%s' \"${PUPPETEER_EXECUTABLE_PATH:-}\" \"${ORKESTR_WHATSAPP_ACCESS_MODE:-}\""];
  const { stdout } = await run("bash", ["docker-entrypoint.sh", "sh", ...printEnv], { env: baseEnv });
  assert.equal(stdout, `${fakeChromium}|`);
  const custom = await run("bash", ["docker-entrypoint.sh", "sh", ...printEnv], { env: { ...baseEnv, WA_CHROME_PATH: "/opt/chrome" } });
  assert.equal(custom.stdout, "|", "an explicit WA_CHROME_PATH is respected");
  const explicit = await run("bash", ["docker-entrypoint.sh", "sh", ...printEnv], { env: { ...baseEnv, PUPPETEER_EXECUTABLE_PATH: "/opt/other", ORKESTR_WHATSAPP_ACCESS_MODE: "relay" } });
  assert.equal(explicit.stdout, "/opt/other|relay");
  const script = await fs.readFile("docker-entrypoint.sh", "utf8");
  assert.match(script, /ORKESTR_DEMO_WHATSAPP_NUMBER[\s\S]*ORKESTR_WHATSAPP_ACCESS_MODE:-relay/, "demo VMs keep relay");
});

test("onboarding binds one private single-account group to the default thread, owner-only", async () => {
  const env = { ORKESTR_HOME: await tempHome("orkestr-wa-onboarding-bind-") };
  const thread = await createThread({ id: "orkest", name: "orkest" }, env);
  const created = [];
  const createChat = async (input) => {
    created.push(input);
    await input.onGroupCreated({ chatId: "120363000000000001@g.us", resultKind: "group_id", resultFingerprint: "synthetic" });
    return { chat: { id: "120363000000000001@g.us", name: input.name, isGroup: true }, responderAccountId: "account-1" };
  };
  const options = { name: "orkest", senderAccountId: "account-1", responderAccountId: "account-1", outboundAccountId: "account-1", participantIds: [] };
  const result = await createAndBindWhatsAppThreadGroup(thread, options, env, { createChat });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].participantIds || [], [], "no other people are added by default");
  assert.equal(result.binding.chatId, "120363000000000001@g.us");
  assert.equal(result.binding.generated, true);
  assert.equal(result.binding.senderAccountId, "account-1");
  assert.equal((await getThread("orkest", env)).binding.chatId, "120363000000000001@g.us");

  // Repeating the onboarding step reuses the binding instead of creating a second group.
  const again = await createAndBindWhatsAppThreadGroup(await getThread("orkest", env), options, env, { createChat });
  assert.equal(again.reused, true);
  assert.equal(created.length, 1);

  const own = evaluateWhatsAppInboundSecurity({
    binding: result.binding,
    input: { chatId: "120363000000000001@g.us", from: "15550000001@c.us", fromMe: true, text: "hi" },
    env,
  });
  assert.equal(own.allowed, true);
  assert.equal(own.trustLevel, "owner");
  assert.equal(own.policyMode, "owner-only", "the onboarding binding is not legacy-open");
});
