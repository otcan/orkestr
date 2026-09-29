import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildContentManifest, compareContentManifests, manifestFromEntries } from "../scripts/release-provenance/content-manifest.mjs";
import { parseGithubRepository, githubTokenFromEnv } from "../scripts/release-provenance/github-api.mjs";
import { describeRunArtifacts, evaluateCheckRuns, loadReleasePolicy, verifyArtifactContent, verifyRequiredChecks } from "../scripts/release-provenance/verify.mjs";
import { zipEntries } from "../scripts/release-provenance/zip-entries.mjs";
import { API, OTHER_SHA, SHA, artifact, checkRun, digestOf, fakeFetch, githubRoutes, makeZip, passingRuns } from "./helpers/release-provenance-fixtures.mjs";

const policy = await loadReleasePolicy();
const owner = "example-org";
const repo = "example-repo";

async function tree(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-prov-tree-"));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  return root;
}

test("content manifest is deterministic, sorted, and subtree-aware", async () => {
  const files = { "server/b.js": "b", "server/a.js": "a", "launcher/index.html": "<html>", "web/main.js": "w" };
  const first = await buildContentManifest(await tree(files), { label: "dist" });
  const reversed = Object.fromEntries(Object.entries(files).reverse());
  const second = await buildContentManifest(await tree(reversed), { label: "dist" });
  assert.equal(first.treeDigest, second.treeDigest);
  assert.deepEqual(first.files.map((file) => file.path), ["launcher/index.html", "server/a.js", "server/b.js", "web/main.js"]);
  assert.match(first.treeDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(first.subtrees), ["launcher", "server", "web"]);
  const changedWeb = await buildContentManifest(await tree({ ...files, "web/main.js": "changed" }), { label: "dist" });
  assert.notEqual(changedWeb.treeDigest, first.treeDigest);
  assert.equal(compareContentManifests(first, changedWeb, { subtrees: ["server", "launcher"] }).match, true);
  assert.deepEqual(compareContentManifests(first, changedWeb).mismatched, ["*"]);
  const changedServer = await buildContentManifest(await tree({ ...files, "server/a.js": "evil" }), { label: "dist" });
  assert.deepEqual(compareContentManifests(first, changedServer, { subtrees: ["server", "launcher"] }).mismatched, ["server"]);
  const excluded = await buildContentManifest(await tree({ ...files, "node_modules/x/index.js": "x" }), { exclude: ["node_modules"], label: "dist" });
  assert.equal(excluded.treeDigest, first.treeDigest);
});

test("zip reader rebuilds the same manifest as the directory walk", async () => {
  const files = { "server/app.js": "console.log(1)\n".repeat(50), "launcher/index.html": "<html></html>" };
  const fromDir = await buildContentManifest(await tree(files), { label: "dist" });
  const fromZip = manifestFromEntries(zipEntries(makeZip(files)), { root: "dist" });
  assert.equal(fromZip.treeDigest, fromDir.treeDigest);
  assert.throws(() => manifestFromEntries([{ path: "../escape", sha256: "0", size: 0 }]), /unsafe_path/);
});

test("github remotes are parsed from ssh and https forms", () => {
  assert.deepEqual(parseGithubRepository("git@github.com:example-org/example-repo.git"), { owner, repo });
  assert.deepEqual(parseGithubRepository("https://github.com/example-org/example-repo.git"), { owner, repo });
  assert.deepEqual(parseGithubRepository("https://github.com/example-org/example-repo"), { owner, repo });
  assert.deepEqual(parseGithubRepository("ssh://git@github.com/example-org/example-repo.git"), { owner, repo });
  assert.equal(parseGithubRepository("https://git.example.invalid/example-org/example-repo.git"), null);
  assert.equal(githubTokenFromEnv({ GITHUB_TOKEN: "t1", ORKESTR_GITHUB_TOKEN: "t0" }), "t0");
});

test("required checks pass for a complete successful run and paginate", async () => {
  const runs = passingRuns();
  const pageOne = { total_count: runs.length, check_runs: runs.slice(0, 6) };
  const pageTwo = { total_count: runs.length, check_runs: runs.slice(6) };
  const { fetchImpl, calls } = fakeFetch({
    [`/repos/${owner}/${repo}/commits/${SHA}/check-runs`]: (url) => new Response(JSON.stringify(url.searchParams.get("page") === "1" ? pageOne : pageTwo)),
  });
  const client = (await import("../scripts/release-provenance/github-api.mjs")).createGithubClient({ fetchImpl, apiBase: API });
  const listed = await client.list(`/repos/${owner}/${repo}/commits/${SHA}/check-runs`, "check_runs", { perPage: 6 });
  assert.equal(listed.length, runs.length);
  const result = await verifyRequiredChecks({ owner, repo, sha: SHA, policy, fetchImpl, apiBase: API, token: "secret-token" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "passed");
  assert.equal(result.runId, "900");
  assert.equal(result.runUrl, `https://github.com/${owner}/${repo}/actions/runs/900`);
  assert.equal(result.headShaMatch, true);
  assert.equal(result.checks.length, 11);
  assert.equal(calls.at(-1).headers.Authorization, "Bearer secret-token");
});

for (const [name, runs, reason, status] of [
  ["missing checks", passingRuns().filter((run) => run.name !== "smoke"), "required_checks_missing", "failed"],
  ["failed check", passingRuns({ build: { conclusion: "failure" } }), "required_checks_failed", "failed"],
  ["skipped check", passingRuns({ "dependency-policy": { conclusion: "skipped" } }), "required_checks_failed", "failed"],
  ["pending check", passingRuns({ smoke: { status: "in_progress" } }), "required_checks_pending", "pending"],
  ["wrong head sha", passingRuns({ build: { headSha: OTHER_SHA } }), "head_sha_mismatch", "failed"],
  ["too few test shards", passingRuns().filter((run) => run.name !== "test (4)"), "required_check_shards_missing", "failed"],
]) {
  test(`required checks reject ${name}`, () => {
    const result = evaluateCheckRuns(runs, { sha: SHA, policy, owner, repo });
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.ok(result.reasons.includes(reason), result.reasons.join(","));
  });
}

test("required checks prefer the newest fully passing run and the latest rerun per name", () => {
  const failedOld = passingRuns({ build: { conclusion: "failure", runId: 800 } }).map((run) => ({ ...run, details_url: run.details_url.replace("/900/", "/800/") }));
  const rerun = checkRun("build", { conclusion: "success", id: 5 });
  const firstAttempt = { ...checkRun("build", { conclusion: "failure", id: 4 }), completed_at: "2026-01-01T00:01:00Z" };
  const result = evaluateCheckRuns([...failedOld, ...passingRuns().filter((run) => run.name !== "build"), firstAttempt, rerun], { sha: SHA, policy });
  assert.equal(result.ok, true);
  assert.equal(result.runId, "900");
  assert.deepEqual(result.runIds.sort(), ["800", "900"]);
});

test("required checks report an API error without throwing", async () => {
  const { fetchImpl } = fakeFetch({ [`/repos/${owner}/${repo}/commits/${SHA}/check-runs`]: () => new Response("{}", { status: 500 }) });
  const result = await verifyRequiredChecks({ owner, repo, sha: SHA, policy, fetchImpl, apiBase: API });
  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.deepEqual(result.reasons, ["github_api_unavailable"]);
  const unreachable = await verifyRequiredChecks({ owner, repo, sha: SHA, policy, fetchImpl: async () => { throw new Error("offline"); }, apiBase: API });
  assert.equal(unreachable.error, "github_api_unreachable");
});

test("artifact metadata reports missing, expired, digestless, and wrong-commit artifacts", async () => {
  const describe = async (artifacts) => describeRunArtifacts({ owner, repo, runId: "900", sha: SHA, policy, fetchImpl: fakeFetch(githubRoutes({ artifacts })).fetchImpl, apiBase: API });
  const good = await describe([artifact("runtime-dist", { id: 11, digest: `sha256:${"c".repeat(64)}` }), artifact("runtime-dist-manifest", { id: 12, digest: `sha256:${"d".repeat(64)}` })]);
  assert.equal(good.ok, true);
  assert.equal(good.runtime.id, 11);
  assert.equal(good.manifest.id, 12);
  assert.deepEqual((await describe([])).problems, ["runtime_artifact_missing"]);
  assert.ok((await describe([artifact("runtime-dist", { id: 11, digest: `sha256:${"c".repeat(64)}`, expired: true })])).problems.includes("runtime_artifact_expired"));
  assert.ok((await describe([artifact("runtime-dist", { id: 11 })])).problems.includes("runtime_artifact_digest_missing"));
  assert.ok((await describe([artifact("runtime-dist", { id: 11, digest: `sha256:${"c".repeat(64)}`, headSha: OTHER_SHA })])).problems.includes("artifact_head_sha_mismatch"));
});

test("artifact content verification checks digest, content and CI manifest without leaking the token to storage", async () => {
  const dist = { "server/app.js": "server", "launcher/index.html": "launcher", "web/main.js": "web" };
  const zip = makeZip(dist);
  const localManifest = await buildContentManifest(await tree(dist), { label: "dist" });
  const ciManifestZip = makeZip({ "runtime-dist-manifest.json": JSON.stringify(localManifest) });
  const artifacts = {
    runtime: { id: 11, name: "runtime-dist", digest: digestOf(zip) },
    manifest: { id: 12, name: "runtime-dist-manifest", digest: digestOf(ciManifestZip) },
  };
  const { fetchImpl, calls } = fakeFetch(githubRoutes({ artifacts: [], archives: { 11: zip, 12: ciManifestZip } }));
  const ok = await verifyArtifactContent({ owner, repo, artifacts, localManifest, policy, fetchImpl, apiBase: API, token: "secret-token" });
  assert.equal(ok.ok, true, ok.problems.join(","));
  assert.equal(ok.digestMatch, true);
  assert.equal(ok.contentMatch, true);
  assert.equal(ok.ciManifestMatch, true);
  assert.equal(ok.attestation.status, "attestation_unverified");
  for (const call of calls.filter((entry) => entry.url.startsWith("https://blob.invalid"))) assert.equal(call.headers.Authorization, undefined);
  assert.ok(calls.some((entry) => entry.redirect === "manual"));

  const mismatch = await verifyArtifactContent({ owner, repo, artifacts: { runtime: { ...artifacts.runtime, digest: `sha256:${"0".repeat(64)}` } }, localManifest, policy, fetchImpl, apiBase: API, token: "t" });
  assert.deepEqual(mismatch.problems, ["artifact_digest_mismatch"]);
  const tampered = await buildContentManifest(await tree({ ...dist, "server/app.js": "tampered" }), { label: "dist" });
  const content = await verifyArtifactContent({ owner, repo, artifacts: { runtime: artifacts.runtime }, localManifest: tampered, policy, fetchImpl, apiBase: API, token: "t" });
  assert.deepEqual(content.problems, ["artifact_content_mismatch"]);
  const noToken = await verifyArtifactContent({ owner, repo, artifacts, localManifest, policy, fetchImpl, apiBase: API });
  assert.deepEqual(noToken.problems, ["github_token_required_for_download"]);
  const attested = await verifyArtifactContent({ owner, repo, artifacts, localManifest, policy, fetchImpl, apiBase: API, token: "t", ghVerify: async () => ({ status: "attestation_failed" }) });
  assert.ok(attested.problems.includes("attestation_failed"));
  const expired = await verifyArtifactContent({ owner, repo, artifacts: { runtime: { id: 99, digest: artifacts.runtime.digest } }, localManifest, policy,
    fetchImpl: fakeFetch({ [`/repos/${owner}/${repo}/actions/artifacts/99/zip`]: () => new Response("gone", { status: 410 }) }).fetchImpl, apiBase: API, token: "t" });
  assert.deepEqual(expired.problems, ["runtime_artifact_expired"]);
});
