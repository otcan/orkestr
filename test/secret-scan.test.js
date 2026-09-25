import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { minimizeFindings, scannerRelease, scanRepository, applyReviewedFindings } from "../scripts/security/secret-scan.mjs";
import { createEvidence } from "../scripts/security/secret-scan-evidence.mjs";

test("secret evidence excludes matches, values, messages, authors and original fingerprints", () => {
  const finding = { Commit: "a".repeat(40), File: "example.js", RuleID: "example-rule", StartLine: 2,
    Secret: "PRIVATE", Match: "PRIVATE", Message: "PRIVATE", Author: "PRIVATE", Fingerprint: "PRIVATE" };
  const report = minimizeFindings([finding], randomBytes(32));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|Secret|Match|Message|Author/);
  assert.match(report[0].fingerprint, /^[a-f0-9]{64}$/);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secret-scan-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repo");
  await fs.mkdir(repository);
  const git = args => {
    const result = spawnSync("git", ["-C", repository, "-c", "user.name=Example", "-c", "user.email=test@example.invalid",
      "-c", "commit.gpgSign=false", ...args], { encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    assert.equal(result.status, 0);
    return result.stdout.trim();
  };
  git(["init", "--quiet", "--template="]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "Synthetic test"]);
  return { binary: "/example/gitleaks", repository, repositoryLabel: "example/repository", reportPath: path.join(root, "report.json"),
    targetRef: "HEAD", expectedCommit: git(["rev-parse", "HEAD"]), git };
}

function runnerFor(status, findings = [], version = scannerRelease.version) {
  return (_binary, args, options) => {
    assert.equal(options.env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(options.env.HOME, undefined);
    if (args[0] === "version") return { status: 0, stdout: version };
    assert.equal(options.stdio, "ignore");
    assert.ok(args.includes("--redact=100"));
    assert.ok(args.includes("--ignore-gitleaks-allow"));
    writeFileSync(args[args.indexOf("--report-path") + 1], JSON.stringify(findings));
    return { status };
  };
}

test("scanner persists private minimized evidence and refuses overwrite", async t => {
  const options = await fixture(t);
  const result = await scanRepository(options, runnerFor(0));
  assert.equal(result.ok, true);
  assert.equal((await fs.stat(options.reportPath)).mode & 0o777, 0o600);
  const report = JSON.parse(await fs.readFile(options.reportPath, "utf8"));
  assert.equal(report.scope, "target_history");
  assert.equal(report.targetCommit, options.expectedCommit);
  assert.equal(report.refCount, 1);
  assert.equal(report.revisionCount, 1);
  assert.equal(report.complete, true);
  assert.equal(report.scannerExitStatus, 0);
  assert.ok(report.startedAt && report.endedAt && report.runId);
  await assert.rejects(scanRepository(options, runnerFor(0)), { code: "EEXIST" });
});

test("scanner rejects wrong version, execution failure and contradictory report", async t => {
  const options = await fixture(t);
  for (const [index, runner, category] of [[0, runnerFor(0, [], "0.0.0"), "pinned_scanner_required"],
    [1, runnerFor(null), "scanner_failed_no_coverage_claim"], [2, runnerFor(23, []), "inconsistent_scanner_exit"]]) {
    const reportPath = options.reportPath + index;
    await assert.rejects(scanRepository({ ...options, reportPath }, runner), new RegExp(category));
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    assert.equal(report.ok, false);
    assert.equal(report.complete, false);
    assert.equal(report.category, category);
  }
});

test("scanner disallows evidence in repository and does not persist raw matches", async t => {
  const options = await fixture(t);
  await assert.rejects(scanRepository({ ...options, reportPath: path.join(options.repository, "report.json") }, runnerFor(0)), /private_report/);
  const result = await scanRepository(options, runnerFor(23, [{ Commit: "a".repeat(40), File: "file.js", RuleID: "example", StartLine: 1, Secret: "RAW_VALUE", Match: "RAW_VALUE" }]));
  assert.equal(result.ok, false);
  assert.doesNotMatch(await fs.readFile(options.reportPath, "utf8"), /RAW_VALUE|file.js|fingerprint|StartLine/);
  assert.deepEqual(result.detectors, Object.assign(Object.create(null), { example: 1 }));
});

test("metadata fingerprints are salted and invalid reports fail closed", () => {
  const finding = { Commit: "b".repeat(40), File: "example.js", RuleID: "example-rule", StartLine: 1 };
  assert.notEqual(minimizeFindings([finding], randomBytes(32))[0].fingerprint, minimizeFindings([finding], randomBytes(32))[0].fingerprint);
  for (const patch of [{ Commit: "bad" }, { File: "bad\npath" }, { RuleID: "raw value" }, { StartLine: -1 }]) assert.throws(() => minimizeFindings([{ ...finding, ...patch }], randomBytes(32)));
  assert.match(scannerRelease.archiveSha256, /^[a-f0-9]{64}$/);
});

test("missing scope, unexpected revision and stale HEAD never execute scanner", async t => {
  const options = await fixture(t);
  const old = options.expectedCommit;
  options.git(["update-ref", "refs/heads/approved-old", old]);
  options.git(["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "New synthetic commit"]);
  for (const [index, patch, error] of [[0, { targetRef: undefined }, "explicit_scan_scope_required"],
    [1, {}, "scan_target_mismatch"], [2, { targetRef: "refs/heads/approved-old" }, "scan_stale_checkout"]]) {
    const reportPath = options.reportPath + index;
    await assert.rejects(scanRepository({ ...options, ...patch, reportPath }, () => { assert.fail("must not execute scanner"); }), new RegExp(error));
    assert.equal(JSON.parse(await fs.readFile(reportPath, "utf8")).complete, false);
  }
});

test("approved ref history is snapshotted explicitly and unrelated refs are excluded", async t => {
  const options = await fixture(t);
  options.git(["update-ref", "refs/heads/approved", options.expectedCommit]);
  options.git(["update-ref", "refs/heads/unapproved", options.expectedCommit]);
  const result = await scanRepository({ ...options, approvedRefs: ["refs/heads/approved"] }, runnerFor(0));
  const report = JSON.parse(await fs.readFile(options.reportPath, "utf8"));
  assert.equal(result.scope, "approved_reachable_refs");
  assert.equal(report.refCount, 2);
  assert.equal(report.revisionCount, 1);
  assert.deepEqual(report.refs.map(row => row.ref), ["HEAD", "refs/heads/approved"]);
  assert.doesNotMatch(JSON.stringify(report), /unapproved/);
});

test("changed refs during execution invalidate coverage", async t => {
  const options = await fixture(t);
  options.git(["update-ref", "refs/heads/approved", options.expectedCommit]);
  await assert.rejects(scanRepository({ ...options, approvedRefs: ["refs/heads/approved"] }, (binary, args, config) => {
    const result = runnerFor(0)(binary, args, config);
    if (args[0] !== "version") options.git(["update-ref", "-d", "refs/heads/approved"]);
    return result;
  }), /scan_revision_unavailable/);
  assert.equal(JSON.parse(await fs.readFile(options.reportPath, "utf8")).ok, false);
});

test("path-only detectors block with aggregate counts, never path or contents", async t => {
  const options = await fixture(t);
  const result = await scanRepository(options, runnerFor(23, [{ Commit: options.expectedCommit, File: "private-name.example",
    RuleID: "path-only", StartLine: 0, Secret: "INERT_EXAMPLE_NO_SECRET" }]));
  assert.equal(result.unresolved, 1);
  assert.equal(result.detectors["path-only"], 1);
  const report = await fs.readFile(options.reportPath, "utf8");
  assert.doesNotMatch(report, /private-name|INERT_EXAMPLE|StartLine|fingerprint/);
  assert.equal(JSON.parse(report).category, "needs_private_triage");
});

test("interrupted aggregation retains incomplete evidence and discards transient payload", async t => {
  const options = await fixture(t);
  let transient;
  await assert.rejects(scanRepository(options, (binary, args, config) => {
    if (args[0] === "version") return runnerFor(0)(binary, args, config);
    transient = args[args.indexOf("--report-path") + 1];
    writeFileSync(transient, "truncated INVALID_EXAMPLE_PAYLOAD");
    return { status: 0 };
  }), /scan_collection_failed/);
  const report = await fs.readFile(options.reportPath, "utf8");
  assert.equal(JSON.parse(report).complete, false);
  assert.doesNotMatch(report, /INVALID_EXAMPLE/);
  await assert.rejects(fs.stat(transient), { code: "ENOENT" });
});

test("lost evidence publication cannot return a passing scan", async t => {
  const options = await fixture(t);
  await assert.rejects(scanRepository(options, (binary, args, config) => {
    const result = runnerFor(0)(binary, args, config);
    if (args[0] !== "version") unlinkSync(options.reportPath);
    return result;
  }));
});

test("unfinished evidence is explicitly nonpassing even before scanner starts", async t => {
  const options = await fixture(t);
  const evidence = await createEvidence(options.reportPath, { repository: "example/repository" });
  await evidence.close();
  const report = JSON.parse(await fs.readFile(options.reportPath, "utf8"));
  assert.equal(report.ok, false);
  assert.equal(report.complete, false);
  assert.equal(report.category, "scan_incomplete");
});

test("pinned real scanner accepts the explicit inert history", { skip: !process.env.ORKESTR_TEST_GITLEAKS_BINARY }, async t => {
  const options = await fixture(t);
  const result = await scanRepository({ ...options, binary: process.env.ORKESTR_TEST_GITLEAKS_BINARY });
  assert.equal(result.ok, true);
  assert.equal(result.findings, 0);
});

test("nonsecret reviews bind exact immutable locations, scanner and expiry", () => {
  const finding = { commit: "a".repeat(40), path: "test/example.js", detector: "example-rule", line: 1, status: "needs_private_triage" };
  const review = { ...finding, classification: "synthetic_fixture", reviewRef: "ORK-478", reviewedBy: "operator", expiresAt: "2026-12-01" };
  const policy = { schemaVersion: 1, scanner: scannerRelease.version, findings: [review] };
  const now = Date.parse("2026-09-20");
  assert.equal(applyReviewedFindings([finding], policy, now)[0].status, "reviewed_nonsecret");
  for (const patch of [{ commit: "b".repeat(40) }, { path: "test/other.js" }, { line: 2 }, { detector: "other" }]) {
    assert.equal(applyReviewedFindings([{ ...finding, ...patch }], policy, now)[0].status, "needs_private_triage");
  }
  assert.equal(applyReviewedFindings([finding], policy, Date.parse("2027-01-01"))[0].status, "needs_private_triage");
  assert.throws(() => applyReviewedFindings([finding], { ...policy, scanner: "0.0.0" }, now), /invalid_finding/);
  assert.throws(() => applyReviewedFindings([finding], { ...policy, findings: [{ ...review, path: "test/*" }] }, now), /invalid_finding/);
});

test("injected asynchronous runner interruption cleans residue and restores signal listeners", async t => {
  const options = await fixture(t);
  const before = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
  let transient;
  await assert.rejects(scanRepository(options, async (binary, args, config) => {
    const result = runnerFor(0)(binary, args, config);
    if (args[0] !== "version") {
      transient = args[args.indexOf("--report-path") + 1];
      process.emit("SIGINT");
      process.emit("SIGTERM");
    }
    return result;
  }), /scan_interrupted/);
  assert.deepEqual([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")], before);
  await assert.rejects(fs.stat(path.dirname(transient)), { code: "ENOENT" });
  const report = JSON.parse(await fs.readFile(options.reportPath, "utf8"));
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.equal(report.category, "scan_interrupted");
});
