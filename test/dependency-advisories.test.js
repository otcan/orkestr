import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { inspectLockfile, minimizeAdvisory, blocksRelease, sha256, validatePolicy } from "../scripts/security/dependency-policy.mjs";
import { osvJson, queryAdvisories, scanDependencies, verifySnapshot } from "../scripts/security/dependency-advisories.mjs";
import { checkLifecycle } from "../scripts/security/dependency-lifecycle.mjs";

const integrity = "sha512-" + Buffer.alloc(64).toString("base64");
const clone = x => structuredClone(x);
const entry = { version: "1.0.0", resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz", integrity };
const manifest = { scripts: { postinstall: "node scripts/patch-whatsapp-media-id.mjs" } };
const policy = { schemaVersion: 1, root: { scripts: manifest.scripts, patchSha256: sha256("// reviewed fixture\n") }, installScripts: [], exceptions: [] };
const lock = { lockfileVersion: 3, packages: { "": {}, "node_modules/example": entry } };
const pkg = { package: "example", version: "1.0.0" };
const advisory = { id: "GHSA-test-1234-abcd", database_specific: { severity: "HIGH" }, affected: [{ package: { ecosystem: "npm", name: "example" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] };
const ref = "a".repeat(40);

test("exact lock inventory includes optional/dev/nested packages and deduplicates versions", () => {
  const input = clone(lock);
  input.packages["node_modules/example"].dev = true;
  input.packages["node_modules/parent/node_modules/example"] = { ...entry, optional: true };
  const result = inspectLockfile(input, manifest, policy);
  assert.equal(result.entries.length, 2); assert.equal(result.packages.length, 1);
  assert.equal(result.packages[0].production, true);
});

test("invalid lock, missing integrity, non-registry source, links and manifest drift fail closed", () => {
  for (const patch of [{ integrity: undefined }, { integrity: "sha512-short" }, { resolved: "http://registry.npmjs.org/example/-/example-1.0.0.tgz" },
    { resolved: "https://registry.npmjs.org.evil.invalid/file.tgz" }, { resolved: entry.resolved + "?token=private" },
    { resolved: "file:../local" }, { resolved: "git+https://example.invalid/repo" }, { link: true }, { inBundle: true }, { version: "latest" }]) {
    const input = clone(lock); Object.assign(input.packages["node_modules/example"], patch);
    assert.throws(() => inspectLockfile(input, manifest, policy));
  }
  assert.throws(() => inspectLockfile({ ...lock, lockfileVersion: 1 }, manifest, policy));
  assert.throws(() => inspectLockfile(lock, { ...manifest, dependencies: { extra: "1.0.0" } }, policy));
  const input = clone(lock); input.packages["../node_modules/example"] = entry;
  assert.throws(() => inspectLockfile(input, manifest, policy));
});

test("unexpected, changed, hidden or root lifecycle scripts require review", () => {
  const input = clone(lock); input.packages["node_modules/example"].hasInstallScript = true;
  assert.throws(() => inspectLockfile(input, manifest, policy), /unreviewed_lifecycle/);
  assert.throws(() => inspectLockfile(lock, { scripts: { postinstall: "unreviewed" } }, policy), /unreviewed_root/);
  const approved = clone(policy); approved.installScripts.push({ package: "example", version: "1.0.0", integrity,
    scriptSha256: sha256(JSON.stringify({ install: "fixture-only" })), rationale: "Test fixture; never execute" });
  assert.equal(inspectLockfile(input, manifest, approved).entries.length, 1);
  assert.throws(() => inspectLockfile(lock, manifest, approved), /lifecycle_flag_mismatch/);
  input.packages["node_modules/example"].integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  assert.throws(() => inspectLockfile(input, manifest, approved), /unreviewed_lifecycle/);
});

test("vulnerable high/critical/unknown block, lower severity is visible, raw text is discarded", () => {
  for (const severity of ["HIGH", "CRITICAL", "unexpected", undefined]) {
    const a = clone(advisory); a.database_specific.severity = severity; a.details = "PRIVATE RAW RESPONSE";
    const row = minimizeAdvisory(pkg, a, policy);
    assert.equal(blocksRelease(row), true);
    assert.deepEqual(Object.keys(row), ["package", "version", "advisoryId", "severity", "status", "fixedVersion"]);
    assert.ok(!JSON.stringify(row).includes("PRIVATE")); assert.equal(row.fixedVersion, "1.0.1");
  }
  const low = clone(advisory); low.database_specific.severity = "MODERATE";
  assert.equal(blocksRelease(minimizeAdvisory(pkg, low, policy)), false);
  const withdrawn = { ...advisory, withdrawn: "2026-01-01T00:00:00Z" };
  assert.equal(minimizeAdvisory(pkg, withdrawn, policy).status, "withdrawn");
  assert.throws(() => minimizeAdvisory(pkg, { ...advisory, affected: [] }, policy));
});

test("exceptions are exact, owner-attributed, bounded to seven days, and expired exceptions fail", () => {
  const now = Date.parse("2026-01-02T00:00:00Z"), approved = clone(policy);
  approved.exceptions.push({ package: "example", version: "1.0.0", advisoryId: advisory.id, approvedBy: "security-owner", reviewRef: "SEC-1",
    approvedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-03T00:00:00Z" });
  assert.equal(minimizeAdvisory(pkg, advisory, approved, now).status, "approved_exception");
  assert.equal(minimizeAdvisory({ ...pkg, version: "1.0.2" }, advisory, approved, now).status, "open");
  assert.throws(() => validatePolicy(approved, Date.parse("2026-01-04T00:00:00Z")));
  approved.exceptions[0].expiresAt = "2027-01-01T00:00:00Z";
  assert.throws(() => validatePolicy(approved, now));
});

test("OSV pagination is exhaustive, deduplicated and detail identity is checked", async () => {
  let batches = 0, details = 0;
  const rows = await queryAdvisories([pkg], policy, async (route, body) => {
    if (route.startsWith("/vulns/")) { details++; return advisory; }
    batches++;
    if (batches === 2) assert.equal(body.queries[0].page_token, "next");
    return { results: [{ vulns: [{ id: advisory.id }], ...(batches === 1 ? { next_page_token: "next" } : {}) }] };
  });
  assert.equal(batches, 2); assert.equal(details, 1); assert.equal(rows.length, 1);
  await assert.rejects(queryAdvisories([pkg], policy, async route => route === "/querybatch" ? { results: [{ vulns: [{ id: advisory.id }] }] } : { ...advisory, id: "wrong" }));
});

test("outages, malformed or truncated results, unexpected IDs and pagination loops never pass", async () => {
  for (const response of [{}, { results: [] }, { results: [null] }, { results: [{ error: "PRIVATE" }] }, { results: [{ unexpected: "shape" }] },
    { results: [{ vulns: {} }] }, { results: [{ vulns: [{ id: "../../private" }] }] }, { results: [{ next_page_token: "repeat" }] }]) {
    await assert.rejects(queryAdvisories([pkg], policy, async () => response));
  }
  await assert.rejects(queryAdvisories([pkg], policy, async () => { throw new Error("network down"); }));
});

test("HTTP client forbids redirects, bounds responses and sends only npm identities", async () => {
  await assert.rejects(osvJson("/querybatch", {}, { fetchImpl: async () => new Response("no", { status: 503 }) }));
  await assert.rejects(osvJson("/querybatch", {}, { fetchImpl: async () => new Response("not-json") }));
  await assert.rejects(osvJson("/querybatch", {}, { fetchImpl: async () => new Response("x".repeat(8 * 1024 * 1024 + 1)) }));
  const result = await osvJson("/querybatch", { queries: [] }, { fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.osv.dev/v1/querybatch"); assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, undefined); assert.ok(options.signal);
    return new Response('{"results":[]}');
  } });
  assert.deepEqual(result, { results: [] });
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-dependency-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "scripts"));
  await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, "scripts/patch-whatsapp-media-id.mjs"), "// reviewed fixture\n");
  const policyPath = path.join(root, "policy.json"); await fs.writeFile(policyPath, JSON.stringify(policy));
  return { root, policyPath, commit: ref, policyCommit: ref, reportPath: path.join(root, "evidence.json"), verify: async () => {} };
}

test("aggregate binds commit/lock/policy and publication failure fails closed", async t => {
  const f = await fixture(t), request = async () => ({ results: [{}] });
  const report = await scanDependencies({ ...f, request });
  assert.equal(report.status, "passed"); assert.equal(report.counts.uniquePackages, 1);
  assert.equal(report.commit, ref); assert.match(report.lockSha256, /^[a-f0-9]{64}$/);
  assert.equal((await fs.stat(f.reportPath)).mode & 0o777, 0o600);
  await assert.rejects(scanDependencies({ ...f, request })); // never silently overwrite evidence
  await assert.rejects(scanDependencies({ ...f, request, reportPath: path.join(f.root, "missing/evidence.json") }));
});

test("unverified snapshot cannot query the service or publish coverage", async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(scanDependencies({ ...f, verify: verifySnapshot, request: async () => { calls++; return { results: [{}] }; } }));
  assert.equal(calls, 0); await assert.rejects(fs.stat(f.reportPath));
});

test("high severity report publishes blocked result; unavailable service produces no green evidence", async t => {
  const f = await fixture(t);
  const report = await scanDependencies({ ...f, request: async route => route === "/querybatch" ? { results: [{ vulns: [{ id: advisory.id }] }] } : advisory });
  assert.equal(report.status, "blocked"); assert.equal(report.counts.blocking, 1);
  const target = path.join(f.root, "outage.json");
  await assert.rejects(scanDependencies({ ...f, reportPath: target, request: async () => { throw new Error("private error"); } }));
  await assert.rejects(fs.stat(target));
});

test("installed inventory catches hidden and implicit lifecycle code without executing it", async t => {
  const f = await fixture(t), target = path.join(f.root, "node_modules/example");
  await fs.mkdir(target, { recursive: true });
  const installed = { name: "example", version: "1.0.0" };
  await fs.writeFile(path.join(target, "package.json"), JSON.stringify(installed));
  assert.equal((await checkLifecycle({ ...f, installed: true })).installedChecked, 1);
  await fs.writeFile(path.join(target, "package.json"), JSON.stringify({ ...installed, scripts: { install: "NEVER EXECUTE" } }));
  await assert.rejects(checkLifecycle({ ...f, installed: true }), /lifecycle_flag_mismatch/);
  await fs.writeFile(path.join(target, "package.json"), JSON.stringify(installed));
  await fs.writeFile(path.join(target, "binding.gyp"), "{}");
  await assert.rejects(checkLifecycle({ ...f, installed: true }), /lifecycle_flag_mismatch/);
});

test("CLI error is minimized and cannot echo invalid credential-bearing input", async () => {
  const file = new URL("../scripts/security/dependency-advisories.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [file.pathname, "--root", "private-secret-value"], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /private-secret-value/);
  assert.match(result.stderr, /failed_no_coverage_claim/);
});

test("workflow gates installs on advisory publication and uses trusted base policy with pinned new actions", async () => {
  const yaml = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(yaml, /pull_request:/); assert.match(yaml, /branches: \[main\]/); assert.match(yaml, /schedule:/); assert.match(yaml, /merge_group:/);
  assert.match(yaml, /POLICY_REF:.*pull_request.base.sha.*merge_group.base_sha/);
  assert.match(yaml, /if-no-files-found: error/); assert.match(yaml, /needs: dependency-advisories/);
  assert.match(yaml, /test "\$RESULT" = success/); assert.match(yaml, /test -n "\$EVIDENCE_DIGEST"/);
  assert.match(yaml, /build:\n    needs: dependency-policy/);
  assert.equal((yaml.match(/npm ci --ignore-scripts --no-audit/g) || []).length, 3);
  assert.equal((yaml.match(/dependency-lifecycle.mjs --root . --installed/g) || []).length, 3);
  assert.equal((yaml.match(/sparse-checkout: scripts\/security\/dependency-\*/g) || []).length, 3);
  assert.doesNotMatch(yaml, /run: npm ci\s*\n/);
  const scan = yaml.slice(yaml.indexOf("  dependency-advisories:"), yaml.indexOf("  secret-scan:"));
  for (const line of scan.split("\n").filter(l => l.includes("uses:"))) assert.match(line, /@[a-f0-9]{40} # v\d/);
  assert.doesNotMatch(scan, /npm ci|pull_request_target|secrets\./);
});
