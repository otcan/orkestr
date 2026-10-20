import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverCodexAppServerPendingInputs, stopCodexAppServerClients } from "../packages/core/src/codex-app-server.js";
import { deliverPendingThreadInputs, resetThreadInputDeliveryTimersForTest } from "../packages/core/src/runtime-leases.js";
import { processQueuedExecutorCommands } from "../packages/core/src/thread-executor-commands.js";
import { appendThreadMessage, createThread, getThread, getThreadMessage, listThreadMessages, updateThread } from "../packages/core/src/threads.js";

const delegatedBinding = {
  connector: "whatsapp",
  chatId: "example-chat@g.us",
  remoteBackend: "example-backend",
  remoteThreadId: "example-remote-thread",
  remoteRuntimeEnabled: true,
};

async function fixture(t, binding = delegatedBinding) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "remote-dispatch-fence-"));
  const attempts = path.join(home, "executor-attempts");
  const executable = path.join(home, "unavailable-test-executor");
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
    TEST_EXECUTOR_ATTEMPTS: attempts,
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
  }, env);
  t.after(async () => {
    resetThreadInputDeliveryTimersForTest();
    stopCodexAppServerClients();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { env, attempts };
}

async function queued(env, text, state = "queued") {
  return appendThreadMessage("example-thread", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    senderEffectiveRole: "owner",
    text,
    state,
    deliveryState: "remote_forwarding",
    remoteBackend: "example-backend",
    remoteThreadId: "example-remote-thread",
  }, env);
}

async function unchanged(env, rows) {
  for (const row of rows) {
    assert.deepEqual(await getThreadMessage("example-thread", row.id, env), row);
  }
  assert.equal((await listThreadMessages("example-thread", env)).filter(row => row.role === "assistant").length, 0);
  assert.equal((await getThread("example-thread", env)).runtimeKind, "codex-app-server");
}

for (const command of ["/agent", "/claude", "/codex"]) {
  test(`delegated owner ${command} stays untouched despite a stale local thread snapshot`, async t => {
    const { env } = await fixture(t, { connector: "whatsapp" });
    const stale = await getThread("example-thread", env);
    const row = await queued(env, command);
    await updateThread("example-thread", { binding: delegatedBinding }, env);
    assert.deepEqual(await processQueuedExecutorCommands(stale, env), []);
    await unchanged(env, [row]);
  });
}

test("generic dispatch does not execute delegated commands before the native queue hold", async t => {
  const { env } = await fixture(t);
  const row = await queued(env, "/agent");
  await updateThread("example-thread", { queueDispatchHold: { paused: true } }, env);
  assert.deepEqual(await deliverPendingThreadInputs("example-thread", env), []);
  await unchanged(env, [row]);
});

for (const [name, dispatch] of [
  ["generic", async env => deliverPendingThreadInputs("example-thread", env)],
  ["native retry", async env => deliverCodexAppServerPendingInputs(await getThread("example-thread", env), env)],
]) {
  test(`${name} dispatch leaves all delegated pending states intact without a hold or configured backend`, async t => {
    const { env, attempts } = await fixture(t);
    const rows = [];
    for (const state of ["queued", "pending_delivery", "awaiting_ack"]) {
      rows.push(await queued(env, `Example input in ${state}`, state));
    }
    assert.deepEqual(await dispatch(env), []);
    await unchanged(env, rows);
    await assert.rejects(fs.stat(attempts), { code: "ENOENT" });
  });
}

for (const override of [
  { remoteRuntimeEnabled: false },
  { remoteRouterEnabled: false },
  { connector: "example-other-connector" },
]) {
  test(`local execution remains available when delegation does not apply: ${JSON.stringify(override)}`, async t => {
    const { env } = await fixture(t, { ...delegatedBinding, ...override });
    const row = await queued(env, "/agent");
    await deliverPendingThreadInputs("example-thread", env);
    const current = await getThreadMessage("example-thread", row.id, env);
    assert.equal(current.state, "completed");
    assert.equal(current.observedVia, "orkestr_executor_command");
    const replies = (await listThreadMessages("example-thread", env)).filter(item => item.role === "assistant");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].parentMessageId, row.id);
    assert.match(replies[0].text, /Active executor: Codex/);
  });
}

test("explicitly disabling delegation restores the original queued command without creating a replacement", async t => {
  const { env } = await fixture(t);
  const row = await queued(env, "/agent");
  assert.deepEqual(await processQueuedExecutorCommands(await getThread("example-thread", env), env), []);
  await updateThread("example-thread", { binding: { ...delegatedBinding, remoteRuntimeEnabled: false } }, env);
  assert.deepEqual(await processQueuedExecutorCommands(await getThread("example-thread", env), env), [row.id]);
  const messages = await listThreadMessages("example-thread", env);
  assert.equal(messages.filter(item => item.role === "user").length, 1);
  assert.equal((await getThreadMessage("example-thread", row.id, env)).state, "completed");
});
