// server.close() must not resolve while background work it started (startup
// pumps, interval runs) can still write into ORKESTR_HOME; otherwise callers
// that remove or reuse the home after close race those writers (ENOTEMPTY).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThread } from "../packages/core/src/threads.js";
// Compiled by build:server; tests import the dist build like other server helpers.
import { createBackgroundTasks } from "../dist/server/apps/server/src/background-tasks.js";

const envKeys = ["ORKESTR_HOME", "ORKESTR_AUTO_RUN_THREAD_INPUT", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_WHATSAPP_AUTOSTART",
  "WHATSAPP_LOCAL_AUTOSTART", "ORKESTR_HOST_BOUNDARIES", "ORKESTR_AUTH_REQUIRED"];

async function snapshot(root) {
  const files = {};
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const stat = await fs.stat(full).catch(() => null);
        if (stat) files[path.relative(root, full)] = `${stat.mtimeMs}:${stat.size}`;
      }
    }
  }
  await walk(root);
  return files;
}

test("background drain waits for tracked work and is bounded", async () => {
  const tasks = createBackgroundTasks();
  let finished = false;
  tasks.track(new Promise((resolve) => setTimeout(() => { finished = true; resolve(); }, 150)));
  tasks.track(Promise.reject(new Error("synthetic")).catch(() => {}));
  const result = await tasks.drain(5_000);
  assert.deepEqual(result, { drained: true, pending: 0 });
  assert.equal(finished, true);

  const stuck = createBackgroundTasks();
  stuck.track(new Promise(() => {}));
  const started = Date.now();
  const timedOut = await stuck.drain(100);
  assert.equal(timedOut.drained, false);
  assert.equal(timedOut.pending, 1);
  assert.ok(Date.now() - started < 2_000, "a stuck task cannot block shutdown");
});

test("nothing writes into ORKESTR_HOME after server.close resolves", async (t) => {
  const { startServer } = await import("../apps/server/src/server.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-close-drain-"));
  const prior = new Map(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { ORKESTR_HOME: home, ORKESTR_AUTO_RUN_THREAD_INPUT: "0", ORKESTR_RECOVER_RUNNING_ON_START: "0",
    ORKESTR_WHATSAPP_AUTOSTART: "0", WHATSAPP_LOCAL_AUTOSTART: "0", ORKESTR_HOST_BOUNDARIES: "0", ORKESTR_AUTH_REQUIRED: "0" });
  t.after(async () => {
    for (const [key, value] of prior) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(home, { recursive: true, force: true });
  });
  // Workers make the startup backfill (ensureExistingWorkerWatches) write
  // watch records and events while the server is already being closed.
  await createThread({ id: "close-parent", name: "Parent" }, process.env);
  for (let index = 0; index < 20; index += 1) {
    await createThread({ id: `close-worker-${index}`, name: "Worker", threadKind: "worker", parentThreadId: "close-parent" }, process.env);
  }
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  const atClose = await snapshot(home);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const later = await snapshot(home);
  const changed = Object.keys(later).filter((file) => atClose[file] !== later[file]);
  assert.deepEqual(changed, [], "no file is created or changed after close() resolved");
});
