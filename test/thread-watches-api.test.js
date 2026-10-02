import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { appendThreadMessage, createThread, listThreadMessages } from "../packages/core/src/threads.js";

const envKeys = ["ORKESTR_HOME", "ORKESTR_ADMIN_USER_ID", "ORKESTR_AUTH_REQUIRED", "ORKESTR_HOST_BOUNDARIES", "ORKESTR_AUTO_RUN_THREAD_INPUT", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_WHATSAPP_AUTOSTART", "WHATSAPP_LOCAL_AUTOSTART"];

function capture() {
  let text = "";
  return { write: (value) => { text += String(value); }, text: () => text };
}

test("orkestr watch creates, lists, reads and cancels watches through the API", async (t) => {
  const { startServer } = await import("../apps/server/src/server.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-watches-api-"));
  const prior = new Map(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_AUTH_REQUIRED: "0", ORKESTR_HOST_BOUNDARIES: "0",
    ORKESTR_AUTO_RUN_THREAD_INPUT: "0", ORKESTR_RECOVER_RUNNING_ON_START: "0", ORKESTR_WHATSAPP_AUTOSTART: "0", WHATSAPP_LOCAL_AUTOSTART: "0",
  });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of prior) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5 });
  });
  const env = { ...process.env, ORKESTR_API_BASE: `http://127.0.0.1:${server.address().port}`, ORKESTR_THREAD_ID: "" };
  await createThread({ id: "api-parent", ownerUserId: "admin" }, process.env);
  await createThread({ id: "api-worker", name: "Worker 9", ownerUserId: "admin" }, process.env);
  const cli = async (argv) => {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(argv, { stdout, stderr, env, cwd: home });
    return { code, out: stdout.text(), err: stderr.text() };
  };

  const missing = await cli(["watch", "api-worker", "--no-thread"]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.err, /Cannot tell which thread is watching/);

  const created = await cli(["watch", "api-worker", "--from", "api-parent", "--continuous", "--payload", "none", "--json"]);
  assert.equal(created.code, 0, created.err);
  const { watch } = JSON.parse(created.out);
  assert.equal(watch.mode, "continuous");
  assert.equal(watch.payload, "none");
  assert.equal(watch.watcherThreadId, "api-parent");

  const listed = await cli(["watch", "list", "api-parent"]);
  assert.match(listed.out, new RegExp(`${watch.id} api-parent <- api-worker continuous`));

  const done = await appendThreadMessage("api-worker", { role: "assistant", phase: "final_answer", state: "completed", source: "claude-code", text: "DONE over the API" }, process.env);
  const run = await fetch(`${env.ORKESTR_API_BASE}/api/threads/api-parent/watches/run`, { method: "POST" });
  assert.equal(run.status, 200);
  const delivered = (await listThreadMessages("api-parent", process.env)).filter((message) => message.source === "thread_watch");
  assert.equal(delivered.length, 1);
  assert.doesNotMatch(delivered[0].text, /DONE over the API/);

  const read = await cli(["watch", "read", "api-worker", "--message", done.id]);
  assert.match(read.out, /DONE over the API/);
  const latest = await cli(["watch", "read", "api-worker", "--json"]);
  assert.equal(JSON.parse(latest.out).message.id, done.id);

  const cancelled = await cli(["watch", "cancel", watch.id, "--from", "api-parent"]);
  assert.match(cancelled.out, /Cancelled .* \(cancelled\)/);
  assert.match((await cli(["watch", "list", "api-parent"])).out, /No thread watches/);
});
