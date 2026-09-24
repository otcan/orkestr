import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { advisoryId, blocksRelease, inspectLockfile, minimizeAdvisory, sha256 } from "./dependency-policy.mjs";

export const scannerVersion = "orkestr-osv-lockfile-v1";
const policyUrl = new URL("./dependency-policy.json", import.meta.url);

export async function verifySnapshot(root, commit, policyCommit) {
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const policyRoot = fileURLToPath(new URL("../../", import.meta.url));
  if (git(root, ["rev-parse", "HEAD"]) !== commit || git(policyRoot, ["rev-parse", "HEAD"]) !== policyCommit) throw new Error("scan_commit_mismatch");
  for (const file of ["package-lock.json", "package.json", "scripts/patch-whatsapp-media-id.mjs"]) {
    if (!(await fs.lstat(path.join(root, file))).isFile()) throw new Error("scan_regular_file_required");
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--exit-code", commit, "--", file]);
  }
  if (git(policyRoot, ["status", "--porcelain", "--", "scripts/security/dependency-*"])) throw new Error("dirty_scanner_policy");
}

export async function osvJson(route, body, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  if (route !== "/querybatch" && !/^\/vulns\/[A-Za-z0-9._-]+$/.test(route)) throw new Error("invalid_advisory_route");
  const response = await fetchImpl("https://api.osv.dev/v1" + route, {
    method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok || !response.body) throw new Error("advisory_service_unavailable");
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("advisory_response_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function queryAdvisories(packages, policy, request = osvJson) {
  const findings = [], details = new Map();
  for (let offset = 0; offset < packages.length; offset += 100) {
    let pending = packages.slice(offset, offset + 100).map(pkg => ({ pkg, token: "", seen: new Set() }));
    for (let page = 0; pending.length; page++) {
      if (page >= 10) throw new Error("advisory_pagination_incomplete");
      const response = await request("/querybatch", { queries: pending.map(({ pkg, token }) => ({
        package: { ecosystem: "npm", name: pkg.package }, version: pkg.version, ...(token ? { page_token: token } : {}),
      })) });
      if (!Array.isArray(response?.results) || response.results.length !== pending.length) throw new Error("advisory_coverage_incomplete");
      const next = [];
      for (let i = 0; i < pending.length; i++) {
        const row = response.results[i], item = pending[i];
        if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(key => !["vulns", "next_page_token"].includes(key)) ||
            (row.vulns !== undefined && !Array.isArray(row.vulns)) || (row.vulns || []).length > 3000) throw new Error("invalid_advisory_response");
        for (const vuln of row.vulns || []) {
          if (!advisoryId(vuln?.id)) throw new Error("invalid_advisory_response");
          if (!details.has(vuln.id)) {
            if (details.size >= 10000) throw new Error("advisory_limit_exceeded");
            const detail = await request("/vulns/" + vuln.id);
            if (detail?.id !== vuln.id) throw new Error("advisory_identity_mismatch");
            details.set(vuln.id, detail);
          }
          findings.push(minimizeAdvisory(item.pkg, details.get(vuln.id), policy));
        }
        if (row.next_page_token !== undefined) {
          const token = row.next_page_token;
          if (typeof token !== "string" || token.length > 4096) throw new Error("invalid_advisory_pagination");
          if (token) {
            if (item.seen.has(token)) throw new Error("advisory_pagination_loop");
            item.seen.add(token); next.push({ ...item, token });
          }
        }
      }
      pending = next;
    }
  }
  return [...new Map(findings.map(row => [JSON.stringify([row.package, row.version, row.advisoryId]), row])).values()];
}

export async function scanDependencies({ root, commit, policyCommit, reportPath, request = osvJson, policyPath = policyUrl, verify = verifySnapshot }) {
  if (!/^[a-f0-9]{40}$/.test(commit || "") || !/^[a-f0-9]{40}$/.test(policyCommit || "") || !path.isAbsolute(root || "") ||
      !path.isAbsolute(reportPath || "")) throw new Error("explicit_dependency_scan_scope_required");
  await verify(root, commit, policyCommit);
  const raw = await fs.readFile(path.join(root, "package-lock.json"));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const policyRaw = await fs.readFile(policyPath), policy = JSON.parse(policyRaw);
  const { entries, packages } = inspectLockfile(JSON.parse(raw), manifest, policy);
  const rootScript = await fs.readFile(path.join(root, "scripts/patch-whatsapp-media-id.mjs"));
  if (sha256(rootScript) !== policy.root?.patchSha256) throw new Error("unreviewed_root_lifecycle");
  const findings = await queryAdvisories(packages, policy, request);
  const blocked = findings.filter(blocksRelease).length;
  const report = { schemaVersion: 1, scanner: scannerVersion, commit, policyCommit, lockSha256: sha256(raw), policySha256: sha256(policyRaw),
    generatedAt: new Date().toISOString(), status: blocked ? "blocked" : "passed",
    counts: { lockedEntries: entries.length, uniquePackages: packages.length, productionPackages: packages.filter(p => p.production).length,
      installScriptEntries: entries.filter(p => p.hasInstallScript).length, advisories: findings.length, blocking: blocked }, findings };
  // Publication is part of the gate, not best-effort logging. No raw service payloads are retained.
  const output = await fs.open(reportPath, "wx", 0o600);
  try { await output.writeFile(JSON.stringify(report, null, 2) + "\n"); await output.sync(); } finally { await output.close(); }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Hard deadline includes the entire scan and publication, not just each HTTP call.
  const deadline = setTimeout(() => { console.error("dependency_scan_deadline_no_coverage_claim"); process.exit(1); }, 300000);
  try {
    const { values } = parseArgs({ options: Object.fromEntries(["root", "commit", "policy-commit", "report"].map(name => [name, { type: "string" }])) });
    const report = await scanDependencies({ root: values.root, commit: values.commit, policyCommit: values["policy-commit"], reportPath: values.report });
    console.log(JSON.stringify({ status: report.status, counts: report.counts, lockSha256: report.lockSha256 }));
    process.exitCode = report.status === "passed" ? 0 : 2;
  } catch { console.error("dependency_scan_failed_no_coverage_claim"); process.exitCode = 1; }
  finally { clearTimeout(deadline); }
}
