import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { discoverTestFiles } from "../scripts/ci-test-runner.mjs";
import { pendingCases } from "./fixtures/personal-agent-acceptance/fixtures.mjs";

const probe = fileURLToPath(new URL("./fixtures/personal-agent-acceptance/gap-probe.mjs", import.meta.url));

function runProbe(mode, strict = false) {
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", probe], {
    encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH || "", OP22_REPORTER_PROBE: mode, ORKESTR_PERSONAL_AGENT_ACCEPTANCE_STRICT: strict ? "1" : "0" },
  });
}

test("OP-22: only the exact, named gap is a nonblocking TAP TODO", () => {
  const result = runProbe("known");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /KNOWN_GAP fixture OP-22.*# TODO/);
  assert.match(result.stdout, /# todo 1/);
});

for (const mode of ["wrong-case", "unrelated", "error", "pass"]) {
  test(`OP-22: ${mode} is a regression, never hidden as a known failure`, () => {
    const result = runProbe(mode);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /KNOWN_GAP.*# TODO/);
    if (mode === "pass") assert.match(result.stdout, /UNEXPECTED_PASS fixture/);
  });
}

test("OP-22: release/strict mode fails a still-reproduced known gap", () => {
  const result = runProbe("known", true);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /KNOWN_GAP.*# TODO/);
});

test("OP-22: cleanup failures remain blocking even when the known-gap child is TODO", () => {
  const result = runProbe("cleanup");
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /KNOWN_GAP fixture OP-22.*# TODO/);
  assert.match(result.stdout, /fixture_cleanup_failed/);
});

test("OP-22: normal CI discovers every acceptance test; pending cases have OP owners", () => {
  const discovered = discoverTestFiles();
  for (const name of ["personal-agent-acceptance", "personal-agent-acceptance-gaps", "personal-agent-acceptance-harness"]) {
    assert.ok(discovered.includes(`test/${name}.test.js`));
  }
  assert.equal(new Set(pendingCases.map(([id]) => id)).size, pendingCases.length);
  for (const [id, ops, reason] of pendingCases) {
    assert.match(id, /^PA-\d{2}$/);
    assert.ok(ops.length && ops.every((op) => /^OP-\d{2}$/.test(op)));
    assert.ok(reason.length > 30);
  }
});
