import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deployDrainActiveSync, deployDrainPath } from "../packages/core/src/deploy-drain.js";
import { formatActiveThreads, summarizeActiveThreads } from "../scripts/deploy-active-work-check.mjs";

test("deploy active-work checker treats live and queued thread work as active", () => {
  const active = summarizeActiveThreads({
    threads: [
      { id: "idle", name: "Idle", state: "ready", pendingCount: 0 },
      { id: "working", name: "Working", state: "working" },
      { id: "queued", name: "Queued", state: "ready", pendingCount: 1 },
      { id: "typing", name: "Typing", typingActive: true },
      { id: "answered", name: "Answered", state: "answer", runningCount: 0 },
    ],
  });

  assert.deepEqual(active.map((thread) => thread.id), ["working", "queued", "typing"]);
  assert.match(formatActiveThreads({ active }), /Working state=working/);
  assert.match(formatActiveThreads({ active }), /Queued state=ready pending=1/);
});

test("deploy drain marker expires instead of permanently pausing delivery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-deploy-drain-"));
  const env = { ORKESTR_HOME: home };
  assert.equal(deployDrainPath(env), path.join(home, "deploy-drain.json"));
  await fs.writeFile(deployDrainPath(env), JSON.stringify({ state: "draining", expiresAt: new Date(Date.now() + 60_000).toISOString() }), "utf8");
  assert.equal(deployDrainActiveSync(env), true);
  await fs.writeFile(deployDrainPath(env), JSON.stringify({ state: "draining", expiresAt: new Date(Date.now() - 60_000).toISOString() }), "utf8");
  assert.equal(deployDrainActiveSync(env), false);
});
