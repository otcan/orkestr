import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { coverageTracker, requireCoverage } from "../scripts/security/scanner-coverage.mjs";
import { scanEnvironment } from "../scripts/security/secret-scan-scope.mjs";
import { scanRepository, scannerRelease } from "../scripts/security/secret-scan.mjs";
import { runScanner } from "../scripts/security/scanner-process.mjs";

const binary = process.env.ORKESTR_TEST_GITLEAKS_BINARY;
const summary = (count, bytes, error = "") => `${error}12:01AM INF ${count} commits scanned.\n12:01AM INF scanned ~${bytes} bytes (fixture) in 1ms\n`;
function coverage(text) {
  const tracker = coverageTracker();
  for (let index = 0; index < text.length; index += 7) tracker.write(Buffer.from(text.slice(index, index + 7)));
  return tracker.finish();
}

test("coverage requires complete summaries and refuses scanner errors or empty positive scope", () => {
  requireCoverage({ scannableAddedLines: 2 }, coverage(summary(1, 50)));
  requireCoverage({ scannableAddedLines: 0 }, coverage(summary(0, 0)));
  for (const report of [undefined, coverage("unrecognized diagnostic\n"), coverage(summary(1, 50) + summary(1, 50))])
    assert.throws(() => requireCoverage({ scannableAddedLines: 2 }, report), /scanner_coverage_unproven/);
  for (const report of [coverage(summary(0, 0)), coverage(summary(1, 0)), coverage(summary(0, 50))])
    assert.throws(() => requireCoverage({ scannableAddedLines: 2 }, report), /scanner_zero_coverage/);
  const failed = coverage(summary(0, 0, "12:01AM ERR [git] PRIVATE_CONTEXT_MUST_NOT_ESCAPE\n"));
  assert.throws(() => requireCoverage({ scannableAddedLines: 0 }, failed), /scanner_reported_error/);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_CONTEXT/);
});

test("actual child diagnostics are bounded and reduced without raw output", async () => {
  const signal = new AbortController().signal;
  const options = { env: scanEnvironment, stdio: "ignore", captureCoverage: true, maxBuffer: 4096, timeout: 2000 };
  const result = await runScanner(process.execPath, ["-e", "process.stderr.write(process.argv[1])",
    summary(1, 50, "12:01AM INF PRIVATE_CONTEXT_MUST_NOT_ESCAPE\n")], options, signal);
  assert.equal(result.status, 0);
  requireCoverage({ scannableAddedLines: 1 }, result.coverage);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CONTEXT/);
  const overflow = await runScanner(process.execPath, ["-e", "process.stderr.write('x'.repeat(8192))"], options, signal);
  assert.equal(overflow.error.message, "scanner_output_limit");
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-scan-coverage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const repository = path.join(root, "repo");
  await fs.mkdir(repository);
  const git = (args, env = scanEnvironment) => {
    const result = spawnSync("git", ["-C", repository, "-c", "user.name=Example Test",
      "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", ...args],
    { env, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, "isolated coverage fixture Git command failed");
    return result.stdout.trim();
  };
  git(["init", "--quiet", "--template="]);
  const add = async (name, text) => {
    await fs.writeFile(path.join(repository, name), text + "\n", { mode: 0o600 });
    git(["add", name]);
    git(["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Synthetic coverage fixture"]);
    return git(["rev-parse", "HEAD"]);
  };
  return { root, git, add, options: () => ({ binary: binary || "/unused/scanner", repository,
    repositoryLabel: "example/repository", reportPath: path.join(root, "evidence.json"),
    targetRef: "HEAD", expectedCommit: git(["rev-parse", "HEAD"]) }) };
}

test("successful empty JSON from a zero-coverage scanner never becomes clean evidence", async t => {
  const peer = await fixture(t);
  await peer.add("README", "Nonempty text that must pass through the scanner");
  const options = peer.options();
  await assert.rejects(scanRepository(options, async (_binary, args) => {
    if (args[0] === "version") return { status: 0, stdout: scannerRelease.version };
    await fs.writeFile(args[args.indexOf("--report-path") + 1], "[]");
    return { status: 0, coverage: coverage(summary(0, 0)) };
  }), /scanner_zero_coverage/);
  const report = JSON.parse(await fs.readFile(options.reportPath, "utf8"));
  assert.equal(report.scannableAddedLines, 1);
  assert.equal(report.scannerExitStatus, 0);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.equal(report.category, "scanner_zero_coverage");
});

test("real fresh-repo scan reports nonzero coverage without fixture-local advice changes", { skip: !binary }, async t => {
  const peer = await fixture(t);
  await peer.add("README", "A nonempty public example without credentials");
  const options = peer.options();
  const result = await scanRepository(options);
  assert.equal(result.ok, true);
  const report = JSON.parse(await fs.readFile(options.reportPath, "utf8"));
  assert.equal(report.scannerCoverage.reportedCommits, 1);
  assert.ok(report.scannerCoverage.reportedBytes > 0);
  assert.equal(report.scannerCoverage.errorReported, false);
});

test("candidate grafts, replacement refs and advice cannot hide credential-shaped history", { skip: !binary }, async t => {
  const peer = await fixture(t);
  // Balanced hex has entropy 4 and avoids the pinned rule's hex stopwords.
  // This constructed fixture has never been associated with a provider/account.
  const syntheticValue = Array.from({ length: 64 }, (_, index) => ((index * 5 + 3) % 16).toString(16)).join("");
  await peer.add("fixture.txt", `api_key = "${syntheticValue}"`);
  const head = await peer.add("README", "Later harmless content");
  peer.git(["replace", "--graft", head]);
  await fs.mkdir(path.join(peer.root, "repo/.git/info"), { recursive: true });
  await fs.writeFile(path.join(peer.root, "repo/.git/info/grafts"), head + "\n");
  peer.git(["config", "advice.graftFileDeprecated", "true"]);
  const unsafe = { ...scanEnvironment };
  for (const name of ["GIT_GRAFT_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"])
    delete unsafe[name];
  assert.equal(peer.git(["rev-list", "--count", "HEAD"], unsafe), "1", "fixture must hide its ancestor without protection");
  const options = peer.options();
  const result = await scanRepository(options);
  assert.equal(result.ok, false);
  assert.equal(result.unresolved, 1);
  assert.equal(result.detectors["generic-api-key"], 1);
  const report = JSON.parse(await fs.readFile(options.reportPath, "utf8"));
  assert.equal(report.revisionCount, 2);
  assert.equal(report.scannerCoverage.reportedCommits, 2);
  assert.equal(report.scannerCoverage.errorReported, false);
});
