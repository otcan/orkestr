// V1 "execution retired" guard: with the flag on, V1 never starts a model turn
// on a thread that is neither delegated to the remote (V2) runtime nor
// allowlisted. Synthetic ids, a fake executor and a fake adapter, no network.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resetLocalInputKindsCacheForTest } from "../packages/connectors/src/whatsapp-remote-local-input.js";
import { deliverCodexAppServerPendingInputs, stopCodexAppServerClients } from "../packages/core/src/codex-app-server.js";
import { deliverPendingThreadInputs, resetThreadInputDeliveryTimersForTest } from "../packages/core/src/runtime-leases.js";
import { processApiAgentThreadInput } from "../packages/core/src/tenant-api-agent.js";
import { appendThreadMessage, createThread, getThread, getThreadMessage, listThreadMessages, updateThreadMessage } from "../packages/core/src/threads.js";
import {
  expireV1ExecutionRetiredFileCacheForTest,
  resetV1ExecutionRetiredForTest,
  setV1ExecutionRetiredAlertHook,
  v1ExecutionDecision,
  v1ExecutionRetiredDeliveryState,
  v1ExecutionExpiredDeliveryState,
  v1ExecutionExpiredEvent,
  v1ExecutionRetiredEvent,
} from "../packages/core/src/v1-execution-retired.js";
import { listEvents } from "../packages/storage/src/store.js";

const delegatedBinding = {
  connector: "whatsapp",
  chatId: "example-chat@g.us",
  responderAccountId: "example-account",
  remoteBackend: "example-backend",
  remoteThreadId: "example-remote-thread",
  remoteRuntimeEnabled: true,
  mirrorToWhatsApp: false,
};

async function fixture(t, { binding = { connector: "whatsapp", chatId: "example-chat@g.us" }, extraEnv = {}, threadFields = {} } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "v1-execution-retired-"));
  const attempts = path.join(home, "executor-attempts");
  const executable = path.join(home, "fake-model-executor");
  // Any spawn of the executor counts as a model call attempt.
  await fs.writeFile(executable, `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(process.env.TEST_EXECUTOR_ATTEMPTS, "attempt\\n");
process.exit(1);
`, { mode: 0o700 });
  const env = {
    HOME: home,
    CODEX_HOME: path.join(home, "codex"),
    PATH: process.env.PATH,
    ORKESTR_HOME: home,
    ORKESTR_CODEX_BIN: executable,
    ORKESTR_CLAUDE_CODE_ENABLED: "0",
    ORKESTR_AUTO_RUN_THREAD_INPUT: "0",
    ORKESTR_WATCHER_ALERTS: "0",
    TEST_EXECUTOR_ATTEMPTS: attempts,
    ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify({
      "example-backend": { baseUrl: "http://adapter.example.test", token: "public-test-token" },
    }),
    ...extraEnv,
  };
  await createThread({
    id: "example-thread",
    name: "Example thread",
    ownerUserId: "admin",
    runtimeKind: "codex-app-server",
    executorId: "codex",
    codexThreadId: "example-native-thread",
    runtime: { runtimeKind: "codex-app-server", state: "ready", codexThreadId: "example-native-thread" },
    binding,
    ...threadFields,
  }, env);
  const alerts = [];
  resetV1ExecutionRetiredForTest();
  setV1ExecutionRetiredAlertHook(async (payload) => { alerts.push(payload); });
  resetLocalInputKindsCacheForTest();
  t.after(async () => {
    resetThreadInputDeliveryTimersForTest();
    stopCodexAppServerClients();
    resetV1ExecutionRetiredForTest();
    resetLocalInputKindsCacheForTest();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { env, attempts, alerts, home };
}

const queue = (env, fields) => appendThreadMessage("example-thread", { role: "user", state: "queued", ...fields }, env);
const events = async (env, type) => (await listEvents(env, 500)).filter(e => e.type === type);
const attemptCount = async (attempts) => (await fs.readFile(attempts, "utf8").catch(() => "")).split("\n").filter(Boolean).length;

async function waitForAttempt(attempts, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await attemptCount(attempts)) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

test("flag off by default: the guard allows every thread and the executor is attempted as before", async t => {
  const { env, attempts } = await fixture(t);
  assert.equal((await v1ExecutionDecision(await getThread("example-thread", env), env)).reason, "guard_off");
  const row = await queue(env, { source: "whatsapp_inbound", connector: "whatsapp", text: "Example owner message" });
  await deliverPendingThreadInputs("example-thread", env);
  assert.equal(await waitForAttempt(attempts), true, "the model executor should be attempted with the guard off");
  assert.equal((await events(env, v1ExecutionRetiredEvent)).length, 0);
  assert.notEqual((await getThreadMessage("example-thread", row.id, env))?.deliveryState, v1ExecutionRetiredDeliveryState);
});

for (const [name, extraEnv, writeFile] of [
  ["env flag", { ORKESTR_V1_EXECUTION_RETIRED: "1" }, false],
  ["flag file", {}, true],
]) {
  test(`${name}: a non-delegated thread is refused with no model call, one audit event per input and one alert`, async t => {
    const { env, attempts, alerts, home } = await fixture(t, { extraEnv });
    if (writeFile) await fs.writeFile(path.join(home, "v1-execution-retired.json"), JSON.stringify({ enabled: true, allowlist: [] }));
    const owner = await queue(env, { source: "whatsapp_inbound", connector: "whatsapp", text: "Example owner message" });
    const timer = await queue(env, { source: "timer_due", timerId: "example-timer", text: "Example timer run" });
    const mail = await queue(env, { source: "mailbox_route", connector: "mailbox", text: "Example mail signal" });
    assert.deepEqual(await deliverPendingThreadInputs("example-thread", env), []);
    // The internal app-server retry path and repeated dispatch are refused too,
    // without duplicate audit events or alerts.
    assert.deepEqual(await deliverCodexAppServerPendingInputs(await getThread("example-thread", env), env), []);
    assert.deepEqual(await deliverPendingThreadInputs("example-thread", env), []);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await attemptCount(attempts), 0, "no model executor may be spawned");
    for (const row of [owner, timer, mail]) {
      const current = await getThreadMessage("example-thread", row.id, env);
      assert.equal(current.state, "queued", "intake is kept: the input stays recorded and queued");
      assert.equal(current.deliveryState, v1ExecutionRetiredDeliveryState);
    }
    const refused = await events(env, v1ExecutionRetiredEvent);
    assert.equal(refused.length, 3);
    assert.deepEqual(refused.map(e => e.messageId).sort(), [owner.id, timer.id, mail.id].sort());
    assert.equal(refused.find(e => e.messageId === timer.id).timerId, "example-timer");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].threadId, "example-thread");
    assert.equal((await listThreadMessages("example-thread", env)).filter(m => m.role === "assistant").length, 0);
    // A later input is audited once, but the operator alert stays rate limited.
    await queue(env, { source: "cli", text: "Example API input" });
    await deliverPendingThreadInputs("example-thread", env);
    assert.equal((await events(env, v1ExecutionRetiredEvent)).length, 4);
    assert.equal(alerts.length, 1);
  });
}

test("the env kill switch overrides an enabled flag file", async t => {
  const { env, home } = await fixture(t, { extraEnv: { ORKESTR_V1_EXECUTION_RETIRED: "0" } });
  await fs.writeFile(path.join(home, "v1-execution-retired.json"), JSON.stringify({ enabled: true }));
  assert.equal((await v1ExecutionDecision(await getThread("example-thread", env), env)).allowed, true);
});

test("an allowlisted thread still runs with the guard on", async t => {
  const { env, attempts, alerts } = await fixture(t, {
    extraEnv: { ORKESTR_V1_EXECUTION_RETIRED: "1", ORKESTR_V1_EXECUTION_ALLOWLIST: "other-thread, example-thread" },
  });
  await queue(env, { source: "whatsapp_inbound", connector: "whatsapp", text: "Example owner message" });
  await deliverPendingThreadInputs("example-thread", env);
  assert.equal(await waitForAttempt(attempts), true, "the allowlisted thread reaches the model executor");
  assert.equal((await events(env, v1ExecutionRetiredEvent)).length, 0);
  assert.equal(alerts.length, 0);
});

test("a thread allowlisted by name in the flag file still runs", async t => {
  const { env, attempts, home } = await fixture(t, { extraEnv: { ORKESTR_V1_EXECUTION_RETIRED: "1" } });
  await fs.writeFile(path.join(home, "v1-execution-retired.json"), JSON.stringify({ allowlist: ["Example thread"] }));
  await queue(env, { source: "ui", text: "Example UI message" });
  await deliverPendingThreadInputs("example-thread", env);
  assert.equal(await waitForAttempt(attempts), true);
});

test("a V2-delegated thread still forwards its local input to V2 with the guard on", async t => {
  const { env, attempts, alerts } = await fixture(t, { binding: delegatedBinding, extraEnv: { ORKESTR_V1_EXECUTION_RETIRED: "1" } });
  const posts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.host, "adapter.example.test");
    if (parsed.pathname.endsWith("/health")) return Response.json({ ok: true, state: "enabled", inputKinds: ["whatsapp_inbound", "v1_local"] });
    if (parsed.pathname.endsWith("/input")) {
      const body = JSON.parse(options.body);
      posts.push(body);
      return Response.json({ ok: true, message: { id: `remote-${posts.length}`, role: "user", state: "delivered", deliveryState: "delivered" } }, { status: 202 });
    }
    throw new Error(`unexpected ${parsed.pathname}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const row = await queue(env, { source: "mailbox_route", connector: "mailbox", text: "Example mail signal" });
  assert.deepEqual(await deliverPendingThreadInputs("example-thread", env), []);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].publicMessageId, row.id);
  const current = await getThreadMessage("example-thread", row.id, env);
  assert.equal(current.state, "delivered");
  assert.equal(current.remoteMessageId, "remote-1");
  assert.equal(await attemptCount(attempts), 0);
  assert.equal((await events(env, v1ExecutionRetiredEvent)).length, 0);
  assert.equal(alerts.length, 0);
});

test("api-agent threads are refused at the direct entry point used by WhatsApp, API and voice callers", async t => {
  const { env, alerts } = await fixture(t, {
    extraEnv: { ORKESTR_V1_EXECUTION_RETIRED: "1" },
    threadFields: { runtimeKind: "api-agent", executorId: "api-agent", runtime: { runtimeKind: "api-agent", state: "ready" }, codexThreadId: null },
  });
  const row = await queue(env, { source: "whatsapp_inbound", connector: "whatsapp", text: "Example owner message" });
  const result = await processApiAgentThreadInput("example-thread", env);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "v1_execution_retired");
  const current = await getThreadMessage("example-thread", row.id, env);
  assert.equal(current.state, "queued");
  assert.equal(current.deliveryState, v1ExecutionRetiredDeliveryState);
  assert.equal((await listThreadMessages("example-thread", env)).filter(m => m.role === "assistant").length, 0);
  assert.equal((await events(env, v1ExecutionRetiredEvent)).length, 1);
  assert.equal(alerts.length, 1);
});

test("a flag file that exists but is invalid fails closed, and keeps the last good setting once one was read", async t => {
  const { env, home } = await fixture(t);
  const file = path.join(home, "v1-execution-retired.json");
  await fs.writeFile(file, "{\"enabled\": tru");
  const first = await v1ExecutionDecision(await getThread("example-thread", env), env);
  assert.equal(first.allowed, false, "an unparseable file must not silently turn the guard off");
  assert.equal((await events(env, "v1_execution_retired_config_invalid")).length, 1);
  // A good file that turns the guard off, then a truncated write: the last good
  // value (off) is kept and the same error is logged only once.
  await fs.writeFile(file, JSON.stringify({ enabled: false }));
  expireV1ExecutionRetiredFileCacheForTest();
  assert.equal((await v1ExecutionDecision(await getThread("example-thread", env), env)).allowed, true);
  await fs.writeFile(file, "");
  expireV1ExecutionRetiredFileCacheForTest();
  assert.equal((await v1ExecutionDecision(await getThread("example-thread", env), env)).allowed, true);
  expireV1ExecutionRetiredFileCacheForTest();
  assert.equal((await v1ExecutionDecision(await getThread("example-thread", env), env)).allowed, true);
  assert.equal((await events(env, "v1_execution_retired_config_invalid")).length, 2);
  // The kill switch still wins over an invalid file.
  expireV1ExecutionRetiredFileCacheForTest();
  assert.equal((await v1ExecutionDecision(await getThread("example-thread", env), { ...env, ORKESTR_V1_EXECUTION_RETIRED: "0" })).allowed, true);
  // "enabled": "true" (a string) counts as on.
  await fs.writeFile(file, JSON.stringify({ enabled: "true" }));
  expireV1ExecutionRetiredFileCacheForTest();
  assert.equal((await v1ExecutionDecision(await getThread("example-thread", env), env)).allowed, false);
});

test("a refusal never overwrites in-flight delivery provenance", async t => {
  const { env, attempts } = await fixture(t, { extraEnv: { ORKESTR_V1_EXECUTION_RETIRED: "1" } });
  const uncertain = await queue(env, { state: "pending_delivery", deliveryState: "codex_acceptance_uncertain", text: "Example in-flight input" });
  const plain = await queue(env, { source: "ui", text: "Example UI message" });
  await deliverPendingThreadInputs("example-thread", env);
  const kept = await getThreadMessage("example-thread", uncertain.id, env);
  assert.equal(kept.deliveryState, "codex_acceptance_uncertain");
  assert.ok(kept.v1ExecutionRefusedAt);
  assert.equal((await getThreadMessage("example-thread", plain.id, env)).deliveryState, v1ExecutionRetiredDeliveryState);
  assert.equal((await events(env, v1ExecutionRetiredEvent)).length, 2);
  await deliverPendingThreadInputs("example-thread", env);
  assert.equal((await events(env, v1ExecutionRetiredEvent)).length, 2, "no duplicate audit for an input without the delivery marker");
  assert.equal(await attemptCount(attempts), 0);
});

test("turning the guard off cancels refused inputs older than 24 hours and lets fresh ones run", async t => {
  const { env, attempts, home } = await fixture(t);
  const file = path.join(home, "v1-execution-retired.json");
  await fs.writeFile(file, JSON.stringify({ enabled: true }));
  const old = await queue(env, { source: "timer_due", timerId: "example-timer", text: "Example stale timer run", createdAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() });
  const fresh = await queue(env, { source: "whatsapp_inbound", connector: "whatsapp", text: "Example owner message" });
  await deliverPendingThreadInputs("example-thread", env);
  // While refused, the stale input (already refused once) is expired on the next pass.
  await deliverPendingThreadInputs("example-thread", env);
  const expired = await getThreadMessage("example-thread", old.id, env);
  assert.equal(expired.state, "cancelled");
  assert.equal(expired.deliveryState, v1ExecutionExpiredDeliveryState);
  assert.equal((await events(env, v1ExecutionExpiredEvent)).length, 1);
  assert.equal(await attemptCount(attempts), 0);
  await fs.writeFile(file, JSON.stringify({ enabled: false }));
  expireV1ExecutionRetiredFileCacheForTest();
  await deliverPendingThreadInputs("example-thread", env);
  const cleared = await getThreadMessage("example-thread", fresh.id, env);
  assert.equal(cleared.v1ExecutionRefusedAt ?? null, null);
  assert.notEqual(cleared.deliveryState, v1ExecutionRetiredDeliveryState);
  assert.equal(await waitForAttempt(attempts), true, "the fresh input runs once the guard is off");
});

test("an old refused input left over from before a restart is cancelled, not replayed, when the guard is off", async t => {
  const { env, attempts } = await fixture(t);
  const longAgo = new Date(Date.now() - 30 * 60 * 60_000).toISOString();
  const old = await queue(env, { source: "timer_due", text: "Example stale timer run", createdAt: longAgo });
  await updateThreadMessage("example-thread", old.id, { deliveryState: v1ExecutionRetiredDeliveryState, v1ExecutionRefusedAt: longAgo }, env);
  await deliverPendingThreadInputs("example-thread", env);
  assert.equal((await getThreadMessage("example-thread", old.id, env)).state, "cancelled");
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await attemptCount(attempts), 0);
});
