import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { runNextThreadMessage } from "../packages/core/src/executors.js";
import { runtimeStatus } from "../packages/core/src/runtime-leases.js";
import { createThread, enqueueThreadInput, listThreadMessages, listThreads } from "../packages/core/src/threads.js";

test("threads are the primary routable runtime object", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-threads-"));
  const env = { ORKESTR_HOME: home };
  const thread = await createThread({ id: "demo-thread", name: "Demo Thread", executorId: "noop" }, env);
  const input = await enqueueThreadInput("demo-thread", { text: "hello thread" }, env);
  const execution = await runNextThreadMessage("demo-thread", {}, env);
  const threads = await listThreads(env);
  const messages = await listThreadMessages("demo-thread", env);

  assert.equal(thread.id, "demo-thread");
  assert.equal(input.state, "queued");
  assert.equal(execution.state, "completed");
  assert.equal(threads[0].state, "ready");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].state, "completed");
  assert.equal(messages[1].role, "assistant");
});

test("threads default to wake-on-message and sleep without a runtime lease", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-sleeping-"));
  const env = { ORKESTR_HOME: home };
  const thread = await createThread({ id: "sleeping-thread", name: "Sleeping Thread" }, env);
  const status = await runtimeStatus("sleeping-thread", env);

  assert.equal(thread.wakePolicy, "wake-on-message");
  assert.equal(status.state, "sleeping");
  assert.equal(status.promptReady, false);
  assert.equal(status.hibernated, true);
});

test("thread APIs create, queue, run, and list messages", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const created = await fetch(`${baseUrl}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "api-thread", name: "API Thread", executorId: "noop" }),
    });
    const input = await fetch(`${baseUrl}/api/threads/api-thread/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "run this", autoRun: false }),
    });
    const run = await fetch(`${baseUrl}/api/threads/api-thread/run-next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const listed = await fetch(`${baseUrl}/api/threads/api-thread/messages`);

    assert.equal(created.status, 201);
    assert.equal(input.status, 202);
    assert.equal(run.status, 200);
    const payload = await listed.json();
    assert.equal(payload.thread.id, "api-thread");
    assert.equal(payload.messages.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});
