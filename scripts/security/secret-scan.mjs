import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const scannerRelease = Object.freeze({ version: "8.30.1", archiveSha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb" });

export function scannerLogOptions(baseCommit = "") {
  if (baseCommit && !/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new Error("explicit_scan_scope_required");
  return `--full-history --diff-merges=separate --no-ext-diff --no-textconv ${baseCommit ? `${baseCommit}..HEAD` : "--all"}`;
}

export function minimizeFindings(findings, salt) {
  if (!Array.isArray(findings) || findings.length > 100000 || !Buffer.isBuffer(salt) || salt.length < 32) throw new Error("invalid_scanner_report");
  return findings.map(finding => {
    if (!finding || !/^[a-f0-9]{40,64}$/.test(finding.Commit || "") || typeof finding.File !== "string" || finding.File.length > 4096 ||
        /[\x00-\x1f\x7f]/.test(finding.File) || typeof finding.RuleID !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(finding.RuleID) ||
        !Number.isInteger(finding.StartLine) || finding.StartLine < 1) throw new Error("invalid_scanner_report");
    const location = { commit: finding.Commit, path: finding.File, detector: finding.RuleID, line: finding.StartLine };
    return { ...location, status: "needs_private_triage", fingerprint: createHmac("sha256", salt).update(JSON.stringify(location)).digest("hex") };
  });
}

export async function scanRepository({ binary, repository, repositoryLabel, reportPath, baseCommit = "" }, runner = spawnSync) {
  if (!path.isAbsolute(binary || "") || !path.isAbsolute(repository || "") || !path.isAbsolute(reportPath || "") ||
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repositoryLabel || "") || (baseCommit && !/^[a-f0-9]{40,64}$/.test(baseCommit))) throw new Error("explicit_scan_scope_required");
  const reportTarget = path.resolve(reportPath), repoRoot = await fs.realpath(repository);
  // Evidence belongs outside the repository and must never overwrite a file.
  const reportParent = await fs.realpath(path.dirname(reportTarget));
  if (reportParent === repoRoot || reportParent.startsWith(repoRoot + path.sep)) throw new Error("private_report_path_required");
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const version = runner(binary, ["version"], { env, encoding: "utf8", timeout: 10000, maxBuffer: 4096 });
  if (version.status !== 0 || !new RegExp(`^v?${scannerRelease.version.replaceAll(".", "\\.")}(?:\\s|$)`).test(String(version.stdout || "").trim())) throw new Error("pinned_scanner_required");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-redacted-scan-"));
  try {
    const rawReport = path.join(temporary, "redacted.json"), ignore = path.join(temporary, "empty-ignore");
    await fs.writeFile(ignore, "", { mode: 0o600 });
    const config = fileURLToPath(new URL("./gitleaks.toml", import.meta.url));
    const args = ["git", repoRoot, "--config", config, "--ignore-gitleaks-allow", "--gitleaks-ignore-path", ignore,
      "--log-opts", scannerLogOptions(baseCommit), "--redact=100", "--no-banner", "--no-color",
      "--report-format", "json", "--report-path", rawReport, "--exit-code", "23", "--timeout", "300"];
    // Raw tool output can include commit text and detection context: discard it.
    const scan = runner(binary, args, { env, cwd: repoRoot, timeout: 310000, stdio: "ignore" });
    if (![0, 23].includes(scan.status) || scan.error) throw new Error("scanner_failed_no_coverage_claim");
    const stat = await fs.stat(rawReport);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("invalid_scanner_report");
    const findings = minimizeFindings(JSON.parse(await fs.readFile(rawReport, "utf8")), randomBytes(32));
    if ((scan.status === 0) !== (findings.length === 0)) throw new Error("inconsistent_scanner_exit");
    const report = { schemaVersion: 1, repository: repositoryLabel, scanner: scannerRelease.version,
      scope: baseCommit ? "commit_range" : "all_local_refs", baseCommit: baseCommit || null,
      generatedAt: new Date().toISOString(), findings, fingerprintScope: "per_report_salted_location_not_credential_value" };
    const handle = await fs.open(reportTarget, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(report, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
    return { ok: findings.length === 0, findings: findings.length, scope: report.scope, scanner: scannerRelease.version };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { parseArgs } = await import("node:util");
  try {
    const { values } = parseArgs({ options: Object.fromEntries(["binary", "repository", "label", "report", "base"].map(name => [name, { type: "string" }])) });
    const result = await scanRepository({ binary: values.binary, repository: values.repository, repositoryLabel: values.label, reportPath: values.report, baseCommit: values.base });
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 2;
  } catch { console.error("secret_scan_failed_no_coverage_claim"); process.exitCode = 1; }
}
