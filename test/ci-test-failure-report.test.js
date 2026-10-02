import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { failedTests, failureAnnotations, failureSummaryMarkdown, publishFailedTests } from "../scripts/ci-test-failure-report.mjs";

const root = "/repo";
const tap = [
  "ok 1 - passes",
  "not ok 2 - deploy guard treats queued work: as safe, really",
  "  ---",
  "  duration_ms: 12",
  "  location: '/repo/test/deploy-active-work-check.test.js:16:1'",
  "  failureType: 'testCodeFailure'",
  "  error: 'Expected values to be strictly equal'",
  "  ...",
  "not ok 3 - multiline error",
  "  ---",
  "  location: '/repo/test/other.test.js:40:3'",
  "  error: |-",
  "    connect ECONNREFUSED 127.0.0.1:3000",
  "  ...",
  "# tests 3",
];

test("failed TAP blocks become name, file, line and first error line", () => {
  assert.deepEqual(failedTests(tap, root), [
    { name: "deploy guard treats queued work: as safe, really", file: "test/deploy-active-work-check.test.js", line: 16, error: "Expected values to be strictly equal" },
    { name: "multiline error", file: "test/other.test.js", line: 40, error: "connect ECONNREFUSED 127.0.0.1:3000" },
  ]);
});

test("annotations escape workflow-command syntax and summaries escape table pipes", () => {
  const [first] = failureAnnotations(failedTests(tap, root));
  assert.equal(first, "::error file=test/deploy-active-work-check.test.js,line=16,title=Test failed::deploy guard treats queued work: as safe, really: Expected values to be strictly equal");
  assert.match(failureAnnotations([{ name: "a\nb", file: "x,y.js", line: 1, error: "" }])[0], /file=x%2Cy\.js.*::a%0Ab$/);
  assert.match(failureSummaryMarkdown([{ name: "a|b", file: "t.js", line: 2, error: "e" }]), /\| a\\\|b \| t\.js:2 \| e \|/);
  assert.match(failureSummaryMarkdown([]), /No TAP failure block/);
});

test("publishing only happens inside GitHub Actions", async () => {
  const written = [];
  assert.deepEqual(publishFailedTests(tap, { env: {}, root, write: (text) => written.push(text) }), []);
  assert.equal(written.length, 0);
  const summary = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ci-summary-")), "summary.md");
  const failures = publishFailedTests(tap, { env: { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary }, root, write: (text) => written.push(text) });
  assert.equal(failures.length, 2);
  assert.equal(written.length, 2);
  assert.match(await fs.readFile(summary, "utf8"), /### 2 failed tests/);
});
