import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deliverCodexAppServerPendingInputs,
  startCodexAppServerThread,
  stopCodexAppServerClients,
} from "../packages/core/src/codex-app-server.js";
import {
  createThread, enqueueThreadInput, getThread, getThreadMessage,
} from "../packages/core/src/threads.js";
import { CodexAppServerClient } from "../packages/core/src/codex-app-server-client.js";

const fakePath = fileURLToPath(new URL("./conformance/fakes/fake-codex-app-server.mjs", import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(probe) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(10);
  }
  throw new Error("timed out waiting for synthetic runtime state");
}

async function bounded(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 2500); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-accepted-"));
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fakePath}" "$@"\n`, { mode: 0o755 });
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"), HOME: path.join(home, "runtime-home"),
    PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: path.join(home, "codex-state.json"),
    FAKE_CODEX_STEP_MS: "30", ORKESTR_ADMIN_USER_ID: "acceptance-owner",
  };
  const running = [];
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  t.after(async () => {
    unblock();
    await Promise.allSettled(running);
    await client?.drainNotifications();
    stopCodexAppServerClients();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  let client;
  const created = await createThread({
    id: "accepted-thread", name: "Acceptance regression", ownerUserId: "acceptance-owner",
    cwd: home, executorId: "codex", executor: { type: "codex" },
  }, env);
  const started = await startCodexAppServerThread(created, env);
  client = started.client;
  await client.drainNotifications();
  const deliver = async () => {
    const delivery = deliverCodexAppServerPendingInputs(await getThread(created.id, env), env);
    running.push(delivery);
    return delivery;
  };
  return { env, client, threadId: created.id, codexId: started.thread.codexThreadId, blocked, unblock, deliver };
}

test("a scoped notification drain excludes other threads without cancelling their handlers", async t => {
  const client = new CodexAppServerClient({ env: {}, home: os.tmpdir() });
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const handled = [];
  t.after(async () => { unblock(); await client.drainNotifications(); });
  client.trackNotification({ method: "item/completed", params: { threadId: "other" } }, async () => {
    await blocked;
    handled.push("other");
  });
  client.trackNotification({ method: "turn/started", params: { turn: { threadId: "selected" } } }, () => {
    handled.push("selected");
  });
  assert.equal(await bounded(client.drainNotifications({ threadId: "selected" }), "scoped drain waited on another thread"), true);
  assert.deepEqual(handled, ["selected"]);
  assert.equal(await client.drainNotifications({ threadId: "other", timeoutMs: 10 }), false);
  assert.deepEqual(handled, ["selected"]);
  unblock();
  assert.equal(await client.drainNotifications({ threadId: "other" }), true);
  assert.deepEqual(handled, ["selected", "other"]);
});

for (const sameThread of [false, true]) {
  test(`accepted input releases delivery while ${sameThread ? "its own" : "another thread's"} notification is blocked`, async t => {
    const fixture = await setup(t);
    const { env, client, threadId, codexId, blocked, deliver } = fixture;
    let handlerFinished = false;
    client.trackNotification({ method: "item/completed", params: { threadId: sameThread ? codexId : "other-codex-thread" } }, async () => {
      await blocked;
      handlerFinished = true;
    });
    const first = await enqueueThreadInput(threadId, { text: "Work [scenario:slow]", source: "test", clientMessageId: "initial" }, env);
    const delivery = deliver();
    const turnId = await waitFor(async () => (await getThreadMessage(threadId, first.id, env)).codexSubmission?.acceptedTurnId);
    await bounded(delivery, "accepted input is still waiting for notification completion");
    const accepted = await getThreadMessage(threadId, first.id, env);
    assert.equal(accepted.state, "completed");
    assert.equal(accepted.deliveryState, "delivered");
    assert.equal(accepted.deliveryClaimId, null);
    assert.equal(accepted.codexTurnId, turnId);
    assert.equal(handlerFinished, false, "acceptance must not require semantic work to complete");

    const steer = await enqueueThreadInput(threadId, {
      text: "Adjust the current work", source: "test", clientMessageId: "steer",
      codexDeliveryMode: "instant_steer", steerActiveTurn: true,
    }, env);
    await bounded(deliver(), "new steer is blocked behind an acknowledged start");
    const steered = await getThreadMessage(threadId, steer.id, env);
    assert.equal(steered.state, "completed");
    assert.equal(steered.observedVia, "codex_app_server_turn_steer");
    assert.equal(steered.codexTurnId, turnId);
    assert.equal(handlerFinished, false);
    await bounded(deliver(), "empty delivery did not finish");
    const state = JSON.parse(await fs.readFile(env.FAKE_CODEX_STATE, "utf8"));
    assert.equal(state.calls.filter(call => call.method === "turn/start").length, 1);
    assert.equal(state.calls.filter(call => call.method === "turn/steer").length, 1);
  });
}

test("delayed completion still settles the acknowledged turn without replay", async t => {
  const fixture = await setup(t);
  const { env, client, threadId, codexId, blocked, unblock, deliver } = fixture;
  client.trackNotification({ method: "item/completed", params: { threadId: codexId } }, () => blocked);
  const input = await enqueueThreadInput(threadId, { text: "Finish [scenario:echo]", source: "test" }, env);
  await bounded(deliver(), "acknowledged turn waited for its delayed completion handler");
  const accepted = await getThreadMessage(threadId, input.id, env);
  assert.equal(accepted.deliveryState, "delivered");
  unblock();
  await client.drainNotifications();
  await waitFor(async () => (await getThread(threadId, env)).runtime?.lastTurnId === accepted.codexTurnId);
  const done = await getThread(threadId, env);
  assert.equal(done.runtime.state, "ready");
  assert.equal(done.runtime.activeTurnId, null);
  await deliver();
  const state = JSON.parse(await fs.readFile(env.FAKE_CODEX_STATE, "utf8"));
  assert.equal(state.calls.filter(call => call.method === "turn/start").length, 1);
});
