import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("runtime builds package and verify the launcher in both build modes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-assets-"));
  try {
    await fs.writeFile(path.join(root, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o700 });
    for (const [mode, expected] of [
      ["0", ["run build:server", "run web:verify-static", "run launcher:build", "run launcher:verify-static"]],
      ["1", ["run build", "run launcher:verify-static"]],
    ]) {
      const { stdout } = await exec("bash", ["scripts/build-runtime.sh"], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, ORKESTR_BUILD_WEB_FROM_SOURCE: mode },
      });
      assert.deepEqual(stdout.trim().split("\n"), expected);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CI shares the full runtime artifact with test and smoke jobs", async () => {
  const workflow = await fs.readFile(".github/workflows/ci.yml", "utf8");
  assert.equal([...workflow.matchAll(/name: runtime-dist\s+path: dist\s/g)].length, 3);
  assert.doesNotMatch(workflow, /name: server-dist/);
});
