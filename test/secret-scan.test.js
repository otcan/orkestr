import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { minimizeFindings, scannerRelease, scanRepository } from "../scripts/security/secret-scan.mjs";

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
  return { binary: "/example/gitleaks", repository, repositoryLabel: "example/repository", reportPath: path.join(root, "report.json") };
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
  assert.equal(JSON.parse(await fs.readFile(options.reportPath, "utf8")).scope, "all_local_refs");
  await assert.rejects(scanRepository(options, runnerFor(0)), { code: "EEXIST" });
});

test("scanner rejects wrong version, execution failure and contradictory report", async t => {
  const options = await fixture(t);
  await assert.rejects(scanRepository(options, runnerFor(0, [], "0.0.0")), /pinned_scanner/);
  await assert.rejects(scanRepository(options, runnerFor(null)), /scanner_failed/);
  await assert.rejects(scanRepository(options, runnerFor(23, [])), /inconsistent_scanner/);
  await assert.rejects(fs.stat(options.reportPath), { code: "ENOENT" });
});

test("scanner disallows evidence in repository and does not persist raw matches", async t => {
  const options = await fixture(t);
  await assert.rejects(scanRepository({ ...options, reportPath: path.join(options.repository, "report.json") }, runnerFor(0)), /private_report/);
  const result = await scanRepository(options, runnerFor(23, [{ Commit: "a".repeat(40), File: "file.js", RuleID: "example", StartLine: 1, Secret: "RAW_VALUE", Match: "RAW_VALUE" }]));
  assert.equal(result.ok, false);
  assert.doesNotMatch(await fs.readFile(options.reportPath, "utf8"), /RAW_VALUE/);
});

test("metadata fingerprints are salted and invalid reports fail closed", () => {
  const finding = { Commit: "b".repeat(40), File: "example.js", RuleID: "example-rule", StartLine: 1 };
  assert.notEqual(minimizeFindings([finding], randomBytes(32))[0].fingerprint, minimizeFindings([finding], randomBytes(32))[0].fingerprint);
  for (const patch of [{ Commit: "bad" }, { File: "bad\npath" }, { RuleID: "raw value" }, { StartLine: 0 }]) assert.throws(() => minimizeFindings([{ ...finding, ...patch }], randomBytes(32)));
  assert.match(scannerRelease.archiveSha256, /^[a-f0-9]{64}$/);
});
