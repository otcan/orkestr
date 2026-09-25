import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveScope, validateScopeRequest, scanEnvironment, immutableCommit } from "./secret-scan-scope.mjs";
import { createEvidence, aggregateFindings } from "./secret-scan-evidence.mjs";
export { scannerLogOptions } from "./secret-scan-scope.mjs";

export const scannerRelease = Object.freeze({ version: "8.30.1", archiveSha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb" });

export function minimizeFindings(findings, salt) {
  if (!Array.isArray(findings) || findings.length > 100000 || !Buffer.isBuffer(salt) || salt.length < 32) throw new Error("invalid_scanner_report");
  return findings.map(finding => {
    if (!finding || !immutableCommit(finding.Commit) || typeof finding.File !== "string" || finding.File.length > 4096 ||
        /[\x00-\x1f\x7f]/.test(finding.File) || typeof finding.RuleID !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(finding.RuleID) ||
        !Number.isInteger(finding.StartLine) || finding.StartLine < 0) throw new Error("invalid_scanner_report");
    const location = { commit: finding.Commit, path: finding.File, detector: finding.RuleID, line: finding.StartLine };
    return { ...location, status: "needs_private_triage", fingerprint: createHmac("sha256", salt).update(JSON.stringify(location)).digest("hex") };
  });
}

export function applyReviewedFindings(findings, policy, now = Date.now()) {
  if (policy?.schemaVersion !== 1 || policy.scanner !== scannerRelease.version || !Array.isArray(policy.findings) ||
      policy.findings.length > 1000 || !Number.isFinite(now)) throw new Error("invalid_finding_review_policy");
  const key = row => JSON.stringify([row.commit, row.path, row.detector, row.line]);
  const reviews = new Map();
  for (const row of policy.findings) {
    if (!/^[a-f0-9]{40,64}$/.test(row.commit || "") || typeof row.path !== "string" || !row.path || /[\x00-\x1f*?]/.test(row.path) ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(row.detector || "") || !Number.isSafeInteger(row.line) || row.line < 1 ||
        !["synthetic_fixture", "nonsecret_syntax"].includes(row.classification) || !/^[A-Z]+-\d+$/.test(row.reviewRef || "") ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(row.reviewedBy || "") || !Number.isFinite(Date.parse(row.expiresAt)) || reviews.has(key(row))) throw new Error("invalid_finding_review_policy");
    if (Date.parse(row.expiresAt) > now) reviews.set(key(row), row);
  }
  return findings.map(row => reviews.has(key(row)) ? { ...row, status: "reviewed_nonsecret", reviewRef: reviews.get(key(row)).reviewRef,
    classification: reviews.get(key(row)).classification } : row);
}

export async function scanRepository({ binary, repository, repositoryLabel, reportPath, baseCommit = "", targetRef, expectedCommit, approvedRefs = [] }, runner = spawnSync) {
  if (!path.isAbsolute(binary || "") || !path.isAbsolute(repository || "") || !path.isAbsolute(reportPath || "") ||
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repositoryLabel || "") || (baseCommit && !/^[a-f0-9]{40,64}$/.test(baseCommit))) throw new Error("explicit_scan_scope_required");
  const reportTarget = path.resolve(reportPath), repoRoot = await fs.realpath(repository);
  // Evidence belongs outside the repository and must never overwrite a file.
  const reportParent = await fs.realpath(path.dirname(reportTarget));
  if (reportParent === repoRoot || reportParent.startsWith(repoRoot + path.sep)) throw new Error("private_report_path_required");
  const evidence = await createEvidence(reportTarget, { repository: repositoryLabel, scanner: scannerRelease.version });
  const env = scanEnvironment;
  let temporary;
  try {
    const scopeOptions = { repository: repoRoot, targetRef, expectedCommit, baseCommit, approvedRefs };
    await evidence.checkpoint({ ...validateScopeRequest(scopeOptions), scopeVerified: false });
    const scope = resolveScope(scopeOptions);
    const { logOptions: _logOptions, ...scopeEvidence } = scope;
    await evidence.checkpoint({ ...scopeEvidence, scopeVerified: true });
    const version = runner(binary, ["version"], { env, encoding: "utf8", timeout: 10000, maxBuffer: 4096 });
    if (version.status !== 0 || !new RegExp(`^v?${scannerRelease.version.replaceAll(".", "\\.")}(?:\\s|$)`).test(String(version.stdout || "").trim())) throw new Error("pinned_scanner_required");
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-redacted-scan-"));
    const rawReport = path.join(temporary, "redacted.json"), ignore = path.join(temporary, "empty-ignore");
    await fs.writeFile(ignore, "", { mode: 0o600 });
    const config = fileURLToPath(new URL("./gitleaks.toml", import.meta.url));
    const args = ["git", repoRoot, "--config", config, "--ignore-gitleaks-allow", "--gitleaks-ignore-path", ignore,
      "--log-opts", scope.logOptions, "--redact=100", "--no-banner", "--no-color",
      "--report-format", "json", "--report-path", rawReport, "--exit-code", "23", "--timeout", "300"];
    // Raw tool output can include commit text and detection context: discard it.
    const scan = runner(binary, args, { env, cwd: repoRoot, timeout: 310000, stdio: "ignore" });
    evidence.report.scannerExitStatus = Number.isInteger(scan.status) ? scan.status : null;
    if (![0, 23].includes(scan.status) || scan.error) throw new Error("scanner_failed_no_coverage_claim");
    const stat = await fs.lstat(rawReport);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("invalid_scanner_report");
    const rawFindings = minimizeFindings(JSON.parse(await fs.readFile(rawReport, "utf8")), randomBytes(32));
    if ((scan.status === 0) !== (rawFindings.length === 0)) throw new Error("inconsistent_scanner_exit");
    const policy = JSON.parse(await fs.readFile(new URL("./reviewed-secret-findings.json", import.meta.url), "utf8"));
    const findings = applyReviewedFindings(rawFindings, policy);
    if (JSON.stringify(resolveScope(scopeOptions)) !== JSON.stringify(scope)) throw new Error("scan_refs_changed");
    const aggregate = aggregateFindings(findings);
    // Delete even redacted transient payload before marking evidence complete.
    await fs.rm(temporary, { recursive: true, force: true });
    temporary = null;
    await evidence.finish({ ...aggregate, complete: true, ok: aggregate.unresolved === 0,
      category: aggregate.unresolved ? "needs_private_triage" : "clean" });
    return { ok: evidence.report.ok, ...aggregate, scope: scope.scope, scanner: scannerRelease.version, runId: evidence.report.runId };
  } catch (error) {
    const safeCodes = new Set(["explicit_scan_scope_required", "scan_revision_unavailable", "scan_history_incomplete", "scan_target_mismatch",
      "scan_stale_checkout", "scan_base_mismatch", "scan_revision_count_invalid", "pinned_scanner_required", "scanner_failed_no_coverage_claim",
      "invalid_scanner_report", "inconsistent_scanner_exit", "invalid_finding_review_policy", "scan_refs_changed"]);
    await evidence.finish({ complete: false, ok: false, category: safeCodes.has(error.message) ? error.message : "scan_collection_failed" });
    throw new Error(safeCodes.has(error.message) ? error.message : "scan_collection_failed");
  } finally {
    try { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
    finally { await evidence.close(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { parseArgs } = await import("node:util");
  try {
    const { values } = parseArgs({ options: { ...Object.fromEntries(["binary", "repository", "label", "report", "base", "target-ref", "expected-commit"].map(name => [name, { type: "string" }])), "approved-ref": { type: "string", multiple: true } } });
    const result = await scanRepository({ binary: values.binary, repository: values.repository, repositoryLabel: values.label, reportPath: values.report,
      baseCommit: values.base, targetRef: values["target-ref"], expectedCommit: values["expected-commit"], approvedRefs: values["approved-ref"] });
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 2;
  } catch { console.error("secret_scan_failed_no_coverage_claim"); process.exitCode = 1; }
}
