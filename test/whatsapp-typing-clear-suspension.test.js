import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resetLocalWhatsAppBridgeForTest,
  setLocalWhatsAppRuntimeForTest,
  setLocalWhatsAppRuntimeRecoveryHooksForTest,
  startLocalWhatsAppTyping,
  stopLocalWhatsAppTyping,
} from "../packages/connectors/src/whatsapp-local-bridge.js";
import { suspendTypingClear, typingClearSuspendMs, typingClearSuspended, resetTypingClearSuspension } from "../packages/connectors/src/whatsapp-typing-clear-backoff.js";
import { listEvents } from "../packages/storage/src/store.js";

const chatId = "chat-typing-suspend@g.us";

async function fixture(t, extraEnv = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-suspend-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_TYPING_REFRESH_MS: "60000",
    ORKESTR_WHATSAPP_TYPING_OPERATION_TIMEOUT_MS: "500",
    ORKESTR_WHATSAPP_TYPING_STOP_GRACE_MS: "0",
    ORKESTR_WHATSAPP_TYPING_CLEAR_RETRY_MS: "5,10,15",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "5000",
    ...extraEnv,
  };
  const calls = [];
  const control = { failClear: "" };
  const chat = {
    async sendStateTyping() { calls.push("typing"); },
    async clearState() {
      calls.push("clear");
      if (control.failClear) throw new Error(control.failClear);
    },
  };
  const runtime = {
    client: {
      async getChatById() { return chat; },
      async sendPresenceAvailable() {},
      pupPage: { async evaluate() { return true; } },
    },
  };
  setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);
  setLocalWhatsAppRuntimeRecoveryHooksForTest({
    async restartAccount() {},
    async startAccount(accountId) { return { accountId, state: "starting", ready: false }; },
  });
  t.after(async () => {
    await resetLocalWhatsAppBridgeForTest(env);
    await fs.rm(home, { recursive: true, force: true });
  });
  return { env, calls, control };
}

async function typeAndStop(env) {
  await startLocalWhatsAppTyping({ accountId: "responder", chatId, env });
  const result = await stopLocalWhatsAppTyping({ accountId: "responder", chatId, env });
  await new Promise((resolve) => setTimeout(resolve, 40));
  return result;
}

const countEvents = (events, type) => events.filter((event) => event.type === type).length;

test("bare r typing clear failures suspend later clears instead of retrying every stop", async (t) => {
  const { env, calls, control } = await fixture(t);
  control.failClear = "r";
  await typeAndStop(env);
  await typeAndStop(env);
  await typeAndStop(env);

  const events = await listEvents(env, 100);
  assert.equal(calls.filter((call) => call === "clear").length, 1);
  assert.equal(countEvents(events, "whatsapp_local_typing_clear_failed"), 1);
  assert.equal(countEvents(events, "whatsapp_local_typing_clear_retry_failed"), 0);
  assert.equal(countEvents(events, "whatsapp_local_typing_clear_suspended"), 1);
  assert.equal(events.filter((event) => event.type === "whatsapp_local_typing_stopped" && event.clearSkipped === "suspended").length, 2);
  assert.equal(countEvents(events, "whatsapp_local_typing_started"), 3);
});

test("non-deterministic typing clear failures keep the retry path", async (t) => {
  const { env, calls, control } = await fixture(t);
  control.failClear = "typing_clear_state_timeout";
  await typeAndStop(env);

  const events = await listEvents(env, 100);
  assert.equal(calls.filter((call) => call === "clear").length, 4);
  assert.equal(countEvents(events, "whatsapp_local_typing_clear_retry_failed"), 3);
  assert.equal(countEvents(events, "whatsapp_local_typing_clear_suspended"), 0);
});

test("typing clear suspension can be disabled to restore retries", async (t) => {
  const { env, calls, control } = await fixture(t, { ORKESTR_WHATSAPP_TYPING_CLEAR_SUSPEND_MS: "0" });
  control.failClear = "r";
  await typeAndStop(env);

  const events = await listEvents(env, 100);
  assert.equal(calls.filter((call) => call === "clear").length, 4);
  assert.equal(countEvents(events, "whatsapp_local_typing_clear_suspended"), 0);
});

test("typing clear suspension expires after the cooldown and reports once per cooldown", () => {
  resetTypingClearSuspension();
  const env = { ORKESTR_WHATSAPP_TYPING_CLEAR_SUSPEND_MS: "1000" };
  assert.equal(typingClearSuspendMs({}), 600000);
  assert.equal(typingClearSuspendMs({ ORKESTR_WHATSAPP_TYPING_CLEAR_SUSPEND_MS: "off" }), 0);
  assert.ok(suspendTypingClear("acct", env, 0));
  assert.equal(typingClearSuspended("acct", 500), true);
  assert.equal(suspendTypingClear("acct", env, 500), null);
  assert.equal(typingClearSuspended("acct", 1600), false);
  assert.equal(suspendTypingClear("acct", env, 1600).failures, 3);
  resetTypingClearSuspension("acct");
  assert.equal(typingClearSuspended("acct", 1700), false);
});
