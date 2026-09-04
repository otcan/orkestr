import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeThreadRegistryCache, saveThreadRecords } from "../packages/storage/src/thread-registry.js";

test("node:test cannot replace a thread registry outside the temporary root", async () => {
  const unsafeHome = path.join(process.cwd(), ".thread-registry-isolation-sentinel");
  await assert.rejects(
    saveThreadRecords([{ id: "must-not-be-written", name: "must-not-be-written" }], { ...process.env, ORKESTR_HOME: unsafeHome }),
    (error) => error?.code === "test_thread_store_requires_temp_home",
  );
  await assert.rejects(fs.stat(unsafeHome), { code: "ENOENT" });
});

test("node:test may use an isolated registry under the temporary root", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-registry-isolation-"));
  const env = { ...process.env, ORKESTR_HOME: home, ORKESTR_THREAD_STORE: "sqlite" };
  try {
    await saveThreadRecords([{ id: "isolated-thread", name: "Isolated thread" }], env);
    const stored = JSON.parse(await fs.readFile(path.join(home, "threads.json"), "utf8"));
    assert.deepEqual(stored.map((thread) => thread.id), ["isolated-thread"]);
  } finally {
    await closeThreadRegistryCache(env);
  }
});
