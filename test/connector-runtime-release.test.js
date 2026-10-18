import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyConnectorProcess } from "../scripts/connector-runtime-release.mjs";

test("connector activation rejects a running process pinned outside the release symlink", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "connector-runtime-release-"));
  const releases = [path.join(root, "old"), path.join(root, "new")];
  const script = "orkestr-wa-worker.mjs";
  for (const dir of releases) {
    await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(dir, "scripts", script), "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n");
  }
  const link = path.join(root, "current");
  await fs.symlink(releases[1], link);
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = once(child, "exit"); child.kill("SIGKILL"); await ended;
    }));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function start(cwd, entry) {
    const child = spawn(process.execPath, [entry], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    children.push(child); await once(child.stdout, "data"); return child;
  }
  const old = await start(releases[0], path.join(releases[0], "scripts", script));
  const input = { unit: "fixture-worker.service", releaseDir: link, script };
  assert.equal((await verifyConnectorProcess(input, { pidForUnit: async () => old.pid })).reason, "process_release_directory_mismatch");
  const wrongEntry = await start(releases[1], path.join(releases[0], "scripts", script));
  assert.equal((await verifyConnectorProcess(input, { pidForUnit: async () => wrongEntry.pid })).reason, "process_entrypoint_mismatch");
  const current = await start(releases[1], path.join(link, "scripts", script));
  assert.equal((await verifyConnectorProcess(input, { pidForUnit: async () => current.pid })).ok, true);
  let reads = 0;
  assert.equal((await verifyConnectorProcess(input, { pidForUnit: async () => ++reads === 1 ? current.pid : old.pid })).reason, "process_changed_during_check");
});
