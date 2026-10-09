import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctorRuntimeResources } from "../packages/core/src/runtime-leases.js";
import { installFakePs } from "./helpers/fake-process-list.mjs";

async function fakeRuntimeBin(home) {
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  const tmuxPath = path.join(bin, "tmux");
  await fs.writeFile(tmuxPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await fs.chmod(tmuxPath, 0o755);
  await installFakePs(bin);
  return bin;
}

test("runtime resource doctor only sees the injected process listing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-doctor-process-scan-"));
  const bin = await fakeRuntimeBin(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr-home"),
    PATH: `${bin}:${process.env.PATH || ""}`,
  };

  const empty = await doctorRuntimeResources({ env, repair: false });
  assert.equal(empty.counts.tempCodexProcesses, 0);
  assert.equal(empty.issues.some((issue) => /temp_codex_process/.test(issue.code)), false);

  const psOutput = path.join(home, "ps.out");
  await fs.writeFile(psOutput, "424242 1 424242 codex codex exec --cd /work/mode-test\n", "utf8");
  // repair stays false: the fake pid must never be signalled.
  const seeded = await doctorRuntimeResources({ env: { ...env, FAKE_PS_OUTPUT: psOutput }, repair: false });
  assert.equal(seeded.counts.tempCodexProcesses, 1);
  assert.ok(seeded.issues.some((issue) => issue.code === "orphan_temp_codex_process" && issue.pid === 424242));
  assert.deepEqual(seeded.actions, []);
});
