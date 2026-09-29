import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildContentManifest } from "../scripts/release-provenance/content-manifest.mjs";
import { GATE_REJECTED_EXIT_CODE, gateModes, main, runPostGate, runPreGate } from "../scripts/release-provenance/deploy-gate.mjs";
import { loadReleasePolicy } from "../scripts/release-provenance/verify.mjs";
import { API, REPO_URL, SHA, artifact, digestOf, fakeFetch, githubRoutes, makeZip, passingRuns } from "./helpers/release-provenance-fixtures.mjs";

const policy = await loadReleasePolicy();
const env = (extra = {}) => ({ ORKESTR_GITHUB_API_URL: API, ...extra });
const goodArtifacts = [artifact("runtime-dist", { id: 11, digest: `sha256:${"c".repeat(64)}` })];

test("gate modes default to enforce checks and warn artifacts and reject unknown values", () => {
  assert.deepEqual(gateModes({}), { checks: "enforce", artifact: "warn" });
  assert.throws(() => gateModes({ ORKESTR_DEPLOY_REQUIRE_CHECKS: "maybe" }), /REQUIRE_CHECKS/);
  assert.throws(() => gateModes({ ORKESTR_DEPLOY_ARTIFACT_PROVENANCE: "yes" }), /ARTIFACT_PROVENANCE/);
});

test("pre gate passes and records CI run, checks, artifact and attestation lookup", async () => {
  const { fetchImpl } = fakeFetch(githubRoutes({ artifacts: goodArtifacts }));
  const record = await runPreGate({ repoUrl: REPO_URL, sha: SHA, env: env(), fetchImpl, policy });
  assert.equal(record.gate.result, "passed");
  assert.equal(record.repository, "example-org/example-repo");
  assert.equal(record.ci.runId, "900");
  assert.equal(record.ci.checks.length, 11);
  assert.ok(record.ci.checks.every((check) => check.conclusion === "success"));
  assert.equal(record.artifact.runtime.digest, `sha256:${"c".repeat(64)}`);
  assert.equal(record.attestation.status, "attestation_present_unverified");
  assert.equal(record.tokenUsed, false);
});

for (const [name, routes, reason] of [
  ["failed check", githubRoutes({ checkRuns: passingRuns({ build: { conclusion: "failure" } }), artifacts: goodArtifacts }), "required_checks_failed"],
  ["pending check", githubRoutes({ checkRuns: passingRuns({ smoke: { status: "queued" } }), artifacts: goodArtifacts }), "required_checks_pending"],
  ["missing checks", githubRoutes({ checkRuns: [], artifacts: goodArtifacts }), "required_checks_missing"],
  ["API error", { [`/repos/example-org/example-repo/commits/${SHA}/check-runs`]: () => new Response("", { status: 503 }) }, "github_api_unavailable"],
]) {
  test(`pre gate: ${name} rejects in enforce and warns in warn`, async () => {
    const enforce = await runPreGate({ repoUrl: REPO_URL, sha: SHA, env: env({ ORKESTR_DEPLOY_ARTIFACT_PROVENANCE: "off" }), fetchImpl: fakeFetch(routes).fetchImpl, policy });
    assert.equal(enforce.gate.result, "rejected");
    assert.ok(enforce.gate.reasons.includes(reason), enforce.gate.reasons.join(","));
    const warn = await runPreGate({ repoUrl: REPO_URL, sha: SHA, env: env({ ORKESTR_DEPLOY_REQUIRE_CHECKS: "warn", ORKESTR_DEPLOY_ARTIFACT_PROVENANCE: "off" }), fetchImpl: fakeFetch(routes).fetchImpl, policy });
    assert.equal(warn.gate.result, "warned");
  });
}

test("pre gate off does not call GitHub", async () => {
  const { fetchImpl, calls } = fakeFetch({});
  const record = await runPreGate({ repoUrl: REPO_URL, sha: SHA, env: env({ ORKESTR_DEPLOY_REQUIRE_CHECKS: "off", ORKESTR_DEPLOY_ARTIFACT_PROVENANCE: "off" }), fetchImpl, policy });
  assert.equal(record.gate.result, "skipped");
  assert.equal(calls.length, 0);
});

test("pre gate rejects non-GitHub sources only when enforcing", async () => {
  const { fetchImpl } = fakeFetch({});
  const rejected = await runPreGate({ repoUrl: "https://git.example.invalid/example-org/example-repo.git", sha: SHA, env: env(), fetchImpl, policy });
  assert.equal(rejected.gate.result, "rejected");
  assert.ok(rejected.gate.reasons.includes("repository_not_github"));
  const overridden = await runPreGate({ repoUrl: "https://git.example.invalid/mirror.git", sha: SHA, env: env({ ORKESTR_DEPLOY_PROVENANCE_REPO: "example-org/example-repo" }), fetchImpl: fakeFetch(githubRoutes({ artifacts: goodArtifacts })).fetchImpl, policy });
  assert.equal(overridden.gate.result, "passed");
});

for (const [name, artifacts, reason, extraEnv] of [
  ["missing artifact", [], "runtime_artifact_missing", {}],
  ["expired artifact", [artifact("runtime-dist", { id: 11, digest: `sha256:${"c".repeat(64)}`, expired: true })], "runtime_artifact_expired", {}],
  ["missing token for enforce", goodArtifacts, "github_token_required_for_download", {}],
]) {
  test(`pre gate artifact provenance: ${name} rejects in enforce and warns in warn`, async () => {
    const routes = githubRoutes({ artifacts });
    const enforce = await runPreGate({ repoUrl: REPO_URL, sha: SHA, env: env({ ORKESTR_DEPLOY_ARTIFACT_PROVENANCE: "enforce", ...extraEnv }), fetchImpl: fakeFetch(routes).fetchImpl, policy });
    assert.equal(enforce.gate.result, "rejected");
    assert.ok(enforce.gate.reasons.includes(reason), enforce.gate.reasons.join(","));
    const warn = await runPreGate({ repoUrl: REPO_URL, sha: SHA, env: env({ ORKESTR_DEPLOY_ARTIFACT_PROVENANCE: "warn" }), fetchImpl: fakeFetch(routes).fetchImpl, policy });
    assert.notEqual(warn.gate.result, "rejected");
  });
}

test("pre gate artifact enforce rejects a missing attestation", async () => {
  const routes = githubRoutes({ artifacts: goodArtifacts, attestations: [] });
  const record = await runPreGate({ repoUrl: REPO_URL, sha: SHA, env: env({ ORKESTR_DEPLOY_ARTIFACT_PROVENANCE: "enforce", GITHUB_TOKEN: "t" }), fetchImpl: fakeFetch(routes).fetchImpl, policy });
  assert.equal(record.attestation.status, "attestation_missing");
  assert.equal(record.gate.result, "rejected");
});

async function releaseDir(dist) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-prov-release-"));
  for (const [rel, content] of Object.entries(dist)) {
    await fs.mkdir(path.dirname(path.join(dir, "dist", rel)), { recursive: true });
    await fs.writeFile(path.join(dir, "dist", rel), content);
  }
  await fs.writeFile(path.join(dir, "package.json"), "{}\n");
  await fs.mkdir(path.join(dir, "node_modules", "x"), { recursive: true });
  await fs.writeFile(path.join(dir, "node_modules", "x", "index.js"), "ignored");
  await fs.writeFile(path.join(dir, "release-manifest.json"), JSON.stringify({ schemaVersion: 1, releaseId: "main-aaaaaaaaaaaa" }));
  return dir;
}

test("post gate records installed-tree digests and verifies downloaded artifact content", async () => {
  const dist = { "server/app.js": "server", "launcher/index.html": "launcher", "web/main.js": "web" };
  const dir = await releaseDir(dist);
  const zip = makeZip(dist);
  const routes = githubRoutes({ artifacts: [], archives: { 11: zip } });
  const pre = { schemaVersion: 1, repository: "example-org/example-repo", commit: SHA, gate: { requireChecks: "enforce", artifactProvenance: "enforce", result: "passed", reasons: [] }, artifact: { runtime: { id: 11, digest: digestOf(zip) } }, attestation: { status: "attestation_present_unverified" } };
  const record = await runPostGate({ releaseDir: dir, provenance: pre, env: env({ ORKESTR_DEPLOY_ARTIFACT_PROVENANCE: "enforce", GITHUB_TOKEN: "t" }), fetchImpl: fakeFetch(routes).fetchImpl, policy, ghVerify: null });
  assert.equal(record.gate.result, "passed", record.gate.reasons.join(","));
  assert.equal(record.installedTree.dist.treeDigest, (await buildContentManifest(path.join(dir, "dist"))).treeDigest);
  assert.equal(record.installedTree.release.fileCount, 4, "node_modules and release-manifest.json are excluded");
  assert.equal(record.artifact.verification.digestMatch, true);

  const badDigest = { ...pre, artifact: { runtime: { id: 11, digest: `sha256:${"0".repeat(64)}` } } };
  const enforce = await runPostGate({ releaseDir: dir, provenance: badDigest, env: env({ ORKESTR_DEPLOY_ARTIFACT_PROVENANCE: "enforce", GITHUB_TOKEN: "t" }), fetchImpl: fakeFetch(routes).fetchImpl, policy, ghVerify: null });
  assert.equal(enforce.gate.result, "rejected");
  assert.ok(enforce.gate.reasons.includes("artifact_digest_mismatch"));
  const warn = await runPostGate({ releaseDir: dir, provenance: { ...badDigest, gate: { ...badDigest.gate, artifactProvenance: "warn" } }, env: env({ GITHUB_TOKEN: "t" }), fetchImpl: fakeFetch(routes).fetchImpl, policy, ghVerify: null });
  assert.equal(warn.gate.result, "warned");
});

test("gate CLI exits 77 on rejection, 2 on bad config, writes the record, and never logs the token", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-prov-cli-"));
  const output = path.join(dir, "provenance.json");
  let stderrText = "";
  const stderr = { write: (chunk) => { stderrText += chunk; } };
  const failing = fakeFetch(githubRoutes({ checkRuns: passingRuns({ build: { conclusion: "failure" } }) })).fetchImpl;
  const code = await main(["pre", "--repo-url", REPO_URL, "--sha", SHA, "--output", output], { env: env({ GITHUB_TOKEN: "very-secret-token" }), fetchImpl: failing, stderr });
  assert.equal(code, GATE_REJECTED_EXIT_CODE);
  assert.match(stderrText, /Release provenance gate rejected/);
  const record = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(record.gate.result, "rejected");
  assert.doesNotMatch(stderrText + JSON.stringify(record), /very-secret-token/);
  assert.equal(await main(["pre", "--repo-url", REPO_URL, "--sha", SHA, "--output", output], { env: env({ ORKESTR_DEPLOY_REQUIRE_CHECKS: "strict" }), fetchImpl: failing, stderr }), 2);
  assert.equal(await main(["pre", "--repo-url", REPO_URL, "--sha", SHA, "--output", output], { env: env({ ORKESTR_DEPLOY_REQUIRE_CHECKS: "warn" }), fetchImpl: failing, stderr }), 0);
  assert.match(stderrText, /Release provenance warning/);

  const release = await releaseDir({ "server/app.js": "s" });
  assert.equal(await main(["post", "--release-dir", release, "--provenance", output], { env: env({ ORKESTR_DEPLOY_REQUIRE_CHECKS: "warn" }), fetchImpl: failing, stderr }), 0);
  const manifest = JSON.parse(await fs.readFile(path.join(release, "release-manifest.json"), "utf8"));
  assert.equal(manifest.releaseId, "main-aaaaaaaaaaaa", "existing manifest fields are kept");
  assert.match(manifest.provenance.installedTree.dist.treeDigest, /^sha256:/);
});
