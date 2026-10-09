import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { flakyReport, loadFlakyManifest, planFlakyRetry } from "../scripts/ci-test-flaky.mjs";
import { parseCiTestRunnerArgs, runCiTests } from "../scripts/ci-test-runner.mjs";

const manifest = [{ file: "test/flaky.test.js", reason: "races a fake timer" }];
// Fails on the first run and passes once its marker file exists.
const flakyOnceFile = `import fs from "node:fs";\nimport test from "node:test";\nconst marker = new URL("./flaky.marker", import.meta.url);\ntest("flaky once", () => { if (!fs.existsSync(marker)) { fs.writeFileSync(marker, "1"); throw new Error("first run"); } });\n`;
const failingFile = `import test from "node:test";\ntest("real failure", () => { throw new Error("broken"); });\n`;

async function fixtureRoot(t, files = {}, tests = manifest) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-ci-flaky-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "test"), { recursive: true });
  await fs.writeFile(path.join(root, "test", "test-bootstrap.mjs"), "", "utf8");
  await fs.writeFile(path.join(root, "test", "flaky-tests.json"), JSON.stringify({ tests }), "utf8");
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(root, "test", name), body, "utf8");
  return root;
}

function captureLogger() {
  const out = [];
  return { out, log: (line) => out.push(String(line)), error: (line) => out.push(String(line)) };
}

test("flaky retry is planned only when every failure is in a marked file", () => {
  assert.deepEqual(planFlakyRetry([{ name: "a", file: "test/flaky.test.js" }, { name: "b", file: "test/flaky.test.js" }], manifest), ["test/flaky.test.js"]);
  assert.deepEqual(planFlakyRetry([{ name: "a", file: "test/flaky.test.js" }, { name: "b", file: "test/real.test.js" }], manifest), []);
  assert.deepEqual(planFlakyRetry([{ name: "unattributed", file: "" }], manifest), []);
  assert.deepEqual(planFlakyRetry([{ name: "/ci/test/flaky.test.js", file: "" }], manifest), ["test/flaky.test.js"]);
  assert.deepEqual(planFlakyRetry([{ name: "a", file: "test/flaky.test.js" }], []), []);
  assert.match(flakyReport({ retried: ["test/flaky.test.js"], passed: true, manifest }), /1 file\(s\) retried once, passed on retry[\s\S]*races a fake timer/);
});

test("flaky manifest entries require a test file and a reason", async (t) => {
  const root = await fixtureRoot(t, {}, [{ file: "test/flaky.test.js" }]);
  assert.throws(() => loadFlakyManifest(root), /needs a test\/\*\.test\.js "file" and a "reason"/);
  const committed = loadFlakyManifest(process.cwd());
  assert.ok(Array.isArray(committed));
});

test("runner retries a marked flaky file once and reports it", async (t) => {
  const root = await fixtureRoot(t, { "flaky.test.js": flakyOnceFile, "ok.test.js": `import test from "node:test";\ntest("ok", () => {});\n` });
  const logger = captureLogger();
  assert.deepEqual(await runCiTests(parseCiTestRunnerArgs(["--root", root], {}), logger), { ok: true, code: 0 });
  assert.match(logger.out.join("\n"), /retrying once: test\/flaky\.test\.js[\s\S]*Flaky test report: 1 file\(s\) retried once, passed on retry/);
});

test("runner never retries unmarked failures or a disabled policy", async (t) => {
  const root = await fixtureRoot(t, { "flaky.test.js": flakyOnceFile, "real.test.js": failingFile });
  const logger = captureLogger();
  const result = await runCiTests(parseCiTestRunnerArgs(["--root", root], {}), logger);
  assert.equal(result.ok, false);
  assert.doesNotMatch(logger.out.join("\n"), /retrying once|Flaky test report/);

  const disabledRoot = await fixtureRoot(t, { "flaky.test.js": flakyOnceFile });
  const disabled = captureLogger();
  assert.equal((await runCiTests(parseCiTestRunnerArgs(["--root", disabledRoot], { ORKESTR_TEST_FLAKY_RETRY: "0" }), disabled)).ok, false);
  assert.doesNotMatch(disabled.out.join("\n"), /retrying once/);
});
