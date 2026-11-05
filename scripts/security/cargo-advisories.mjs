import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { sha256 } from "./dependency-policy.mjs";
import { osvJson, queryAdvisories } from "./dependency-advisories.mjs";
import { blocksCargoRelease, mergeAliases, minimizeCargoAdvisory, parseCargoLock, validateCargoPolicy } from "./cargo-policy.mjs";

export const scannerVersion = "orkestr-osv-cargo-lock-v1";
export const lockPath = "v2/Cargo.lock";
const policyUrl = new URL("./cargo-policy.json", import.meta.url);

export async function verifyCargoSnapshot(root, commit, policyCommit) {
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const policyRoot = fileURLToPath(new URL("../../", import.meta.url));
  if (git(root, ["rev-parse", "HEAD"]) !== commit || git(policyRoot, ["rev-parse", "HEAD"]) !== policyCommit) throw new Error("scan_commit_mismatch");
  if (!(await fs.lstat(path.join(root, lockPath))).isFile()) throw new Error("scan_regular_file_required");
  git(root, ["diff", "--no-ext-diff", "--no-textconv", "--exit-code", commit, "--", lockPath]);
  if (git(policyRoot, ["status", "--porcelain", "--", "scripts/security/cargo-*", "scripts/security/dependency-*"])) throw new Error("dirty_scanner_policy");
}

// The lock is read as data only: no cargo, no build script and no crate code runs.
export async function scanCargoLock({ root, commit, policyCommit, reportPath, request = osvJson, policyPath = policyUrl, verify = verifyCargoSnapshot }) {
  if (!/^[a-f0-9]{40}$/.test(commit || "") || !/^[a-f0-9]{40}$/.test(policyCommit || "") || !path.isAbsolute(root || "") ||
      !path.isAbsolute(reportPath || "")) throw new Error("explicit_cargo_scan_scope_required");
  await verify(root, commit, policyCommit);
  const raw = await fs.readFile(path.join(root, lockPath));
  const policyRaw = await fs.readFile(policyPath), policy = validateCargoPolicy(JSON.parse(policyRaw));
  const lock = parseCargoLock(raw.toString("utf8"));
  const findings = mergeAliases(await queryAdvisories(lock.crates, policy, request, { ecosystem: "crates.io", minimize: minimizeCargoAdvisory }));
  const blocked = findings.filter(blocksCargoRelease).length;
  const modified = findings.map(row => row.modified).sort().at(-1) || null;
  const report = { schemaVersion: 1, scanner: scannerVersion, commit, policyCommit, lockSha256: sha256(raw), policySha256: sha256(policyRaw),
    generatedAt: new Date().toISOString(), newestAdvisoryModifiedAt: modified, status: blocked ? "blocked" : "passed",
    counts: { lockedEntries: lock.entries, registryCrates: lock.crates.length, workspaceEntries: lock.workspace.length, advisories: findings.length,
      blocking: blocked, exceptions: findings.filter(row => row.status === "approved_exception").length, notices: findings.filter(row => row.status === "notice").length }, findings };
  // Publication is part of the gate, not best-effort logging. No raw service payloads are retained.
  const output = await fs.open(reportPath, "wx", 0o600);
  try { await output.writeFile(JSON.stringify(report, null, 2) + "\n"); await output.sync(); } finally { await output.close(); }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Hard deadline includes the entire scan and publication, not just each HTTP call.
  const deadline = setTimeout(() => { console.error("cargo_scan_deadline_no_coverage_claim"); process.exit(1); }, 300000);
  try {
    const { values } = parseArgs({ options: Object.fromEntries(["root", "commit", "policy-commit", "report"].map(name => [name, { type: "string" }])) });
    const report = await scanCargoLock({ root: values.root, commit: values.commit, policyCommit: values["policy-commit"], reportPath: values.report });
    console.log(JSON.stringify({ status: report.status, counts: report.counts, lockSha256: report.lockSha256,
      blocking: report.findings.filter(blocksCargoRelease).map(row => `${row.package}@${row.version} ${row.advisoryId}`) }));
    process.exitCode = report.status === "passed" ? 0 : 2;
  } catch { console.error("cargo_scan_failed_no_coverage_claim"); process.exitCode = 1; }
  finally { clearTimeout(deadline); }
}
