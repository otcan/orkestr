import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import {
  requestThreadInputDelivery,
  threadInputDeliverySchedulerStatus,
} from "../dist/server/packages/core/src/runtime-leases.js";

const testEnvKeys = [
  "ORKESTR_HOME",
  "ORKESTR_RECOVER_RUNNING_ON_START",
  "ORKESTR_WHATSAPP_AUTOSTART",
  "WHATSAPP_LOCAL_AUTOSTART",
];

function snapshotProcessEnv() {
  return new Map(testEnvKeys.map((key) => [key, process.env[key]]));
}

function restoreProcessEnv(snapshot) {
  for (const [key, value] of snapshot.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("embedded server close owns and cancels its scoped thread delivery timers", async () => {
  const prior = snapshotProcessEnv();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-server-storage-lifecycle-"));
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_WHATSAPP_AUTOSTART = "0";
  process.env.WHATSAPP_LOCAL_AUTOSTART = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const env = { ...process.env, ORKESTR_HOME: home };
  try {
    requestThreadInputDelivery("pending-test-thread", env, 60_000);
    assert.equal(threadInputDeliverySchedulerStatus(env).timers, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    restoreProcessEnv(prior);
  }

  assert.deepEqual(threadInputDeliverySchedulerStatus(env), {
    scope: home,
    active: false,
    timers: 0,
    tasks: 0,
    locks: 0,
  });
});
