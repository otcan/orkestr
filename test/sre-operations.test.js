import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("SRE audit and posture regressions (isolated, no live control or alert transport)", () => {
  const result = spawnSync("python3", ["-m", "unittest", "discover", "-s", "test", "-p", "sre_*_test.py"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
