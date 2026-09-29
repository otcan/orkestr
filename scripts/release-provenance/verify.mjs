// Release provenance verification against GitHub Actions: required check runs
// for an exact commit, CI artifact metadata, optional artifact download with
// digest + content-manifest comparison, and optional attestation verification.
// All I/O is injectable (fetchImpl, ghVerify) so tests never hit the network.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { compareContentManifests, manifestFromEntries, manifestSummary } from "./content-manifest.mjs";
import { createGithubClient } from "./github-api.mjs";
import { zipEntries } from "./zip-entries.mjs";

const defaultPolicyUrl = new URL("./release-policy.json", import.meta.url);

export async function loadReleasePolicy(file = defaultPolicyUrl) {
  const policy = JSON.parse(await fs.readFile(file, "utf8"));
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.requiredChecks)) throw new Error("release_policy_invalid");
  return policy;
}

export function runIdFromCheck(check = {}) {
  const match = String(check.details_url || check.html_url || "").match(/\/actions\/runs\/(\d+)/);
  return match ? match[1] : "";
}

function checkTime(check) {
  return Date.parse(check.completed_at || check.started_at || "") || 0;
}

function relevantName(name, policy) {
  return policy.requiredChecks.includes(name) || (policy.requiredCheckPrefixes || []).some((rule) => name.startsWith(rule.prefix));
}

function evaluateGroup(runId, checks, { sha, policy }) {
  const byName = new Map();
  for (const check of checks) {
    const previous = byName.get(check.name);
    if (!previous || checkTime(check) > checkTime(previous) || (checkTime(check) === checkTime(previous) && Number(check.id) > Number(previous.id))) byName.set(check.name, check);
  }
  const rows = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).map((check) => ({
    name: check.name,
    status: String(check.status || ""),
    conclusion: check.conclusion == null ? null : String(check.conclusion),
    headSha: String(check.head_sha || ""),
    runId,
  }));
  const missing = policy.requiredChecks.filter((name) => !byName.has(name));
  const shardRules = (policy.requiredCheckPrefixes || []).map((rule) => ({
    prefix: rule.prefix,
    minCount: Number(rule.minCount) || 1,
    count: rows.filter((row) => row.name.startsWith(rule.prefix)).length,
  }));
  const pending = rows.filter((row) => row.status !== "completed").map((row) => row.name);
  const failed = rows.filter((row) => row.status === "completed" && row.conclusion !== "success").map((row) => ({ name: row.name, conclusion: row.conclusion }));
  const headMismatch = rows.filter((row) => row.headSha !== sha).map((row) => row.name);
  const reasons = [];
  if (missing.length) reasons.push("required_checks_missing");
  if (shardRules.some((rule) => rule.count < rule.minCount)) reasons.push("required_check_shards_missing");
  if (failed.length) reasons.push("required_checks_failed");
  if (pending.length) reasons.push("required_checks_pending");
  if (headMismatch.length) reasons.push("head_sha_mismatch");
  return { runId, checks: rows, missing, shardRules, pending, failed, headMismatch, reasons, ok: reasons.length === 0 };
}

// Pure evaluation of a check-runs listing. Picks the newest workflow run whose
// required checks all passed, otherwise reports the newest run's problems.
export function evaluateCheckRuns(checkRuns = [], { sha, policy, owner = "", repo = "" }) {
  const groups = new Map();
  for (const check of checkRuns) {
    if (!check?.name || !relevantName(check.name, policy)) continue;
    const runId = runIdFromCheck(check) || "unknown";
    if (!groups.has(runId)) groups.set(runId, []);
    groups.get(runId).push(check);
  }
  const evaluated = [...groups.entries()].map(([runId, checks]) => evaluateGroup(runId, checks, { sha, policy }))
    .sort((a, b) => Number(b.runId === "unknown" ? -1 : b.runId) - Number(a.runId === "unknown" ? -1 : a.runId));
  const chosen = evaluated.find((group) => group.ok) || evaluated[0] || evaluateGroup("", [], { sha, policy });
  const status = chosen.ok ? "passed" : chosen.reasons.length === 1 && chosen.reasons[0] === "required_checks_pending" ? "pending" : "failed";
  const runId = chosen.runId && chosen.runId !== "unknown" ? chosen.runId : "";
  return {
    ok: chosen.ok,
    status,
    reasons: chosen.reasons,
    sha,
    headShaMatch: chosen.checks.length > 0 && chosen.headMismatch.length === 0,
    runId: runId || null,
    runIds: evaluated.map((group) => group.runId).filter((id) => id && id !== "unknown"),
    runUrl: runId && owner && repo ? `https://github.com/${owner}/${repo}/actions/runs/${runId}` : null,
    required: { checks: policy.requiredChecks, prefixes: policy.requiredCheckPrefixes || [] },
    checks: chosen.checks,
    missing: chosen.missing,
    shardRules: chosen.shardRules,
    failed: chosen.failed,
    pending: chosen.pending,
    headMismatch: chosen.headMismatch,
  };
}

export async function verifyRequiredChecks({ owner, repo, sha, required, policy, fetchImpl, token = "", apiBase, client } = {}) {
  const effectivePolicy = policy || (required ? { requiredChecks: required, requiredCheckPrefixes: [] } : await loadReleasePolicy());
  if (!/^[a-f0-9]{40}$/.test(String(sha || ""))) return { ok: false, status: "error", reasons: ["sha_invalid"], sha, checks: [] };
  const api = client || createGithubClient({ fetchImpl, token, apiBase });
  let rows;
  try {
    rows = await api.list(`/repos/${owner}/${repo}/commits/${sha}/check-runs`, "check_runs");
  } catch (error) {
    return { ok: false, status: "error", reasons: ["github_api_unavailable"], error: error?.code || "github_api_error", sha, checks: [] };
  }
  return evaluateCheckRuns(rows, { sha, policy: effectivePolicy, owner, repo });
}

function artifactRow(artifact = {}) {
  return {
    name: String(artifact.name || ""),
    id: artifact.id ?? null,
    digest: artifact.digest ? String(artifact.digest) : null,
    sizeInBytes: Number(artifact.size_in_bytes) || 0,
    expired: Boolean(artifact.expired),
    headSha: artifact.workflow_run?.head_sha ? String(artifact.workflow_run.head_sha) : null,
  };
}

// Artifact metadata only (no download): name, id, digest, expiry.
export async function describeRunArtifacts({ owner, repo, runId, sha, policy, fetchImpl, token = "", apiBase, client } = {}) {
  const effectivePolicy = policy || await loadReleasePolicy();
  const names = effectivePolicy.artifacts || {};
  if (!runId) return { ok: false, problems: ["ci_run_unknown"], runId: null, artifacts: [], runtime: null, manifest: null };
  const api = client || createGithubClient({ fetchImpl, token, apiBase });
  let rows;
  try {
    rows = (await api.list(`/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`, "artifacts")).map(artifactRow);
  } catch (error) {
    return { ok: false, problems: ["artifact_metadata_unavailable"], error: error?.code || "github_api_error", runId, artifacts: [], runtime: null, manifest: null };
  }
  const pick = (name) => rows.filter((row) => row.name === name).sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
  const runtime = pick(names.runtime || "runtime-dist");
  const manifest = names.manifest ? pick(names.manifest) : null;
  const problems = [];
  if (!runtime) problems.push("runtime_artifact_missing");
  else {
    if (runtime.expired) problems.push("runtime_artifact_expired");
    if (!/^sha256:[a-f0-9]{64}$/.test(runtime.digest || "")) problems.push("runtime_artifact_digest_missing");
    if (runtime.headSha && sha && runtime.headSha !== sha) problems.push("artifact_head_sha_mismatch");
  }
  return { ok: problems.length === 0, problems, runId, artifacts: rows, runtime, manifest };
}

// Looks up GitHub artifact attestations for a digest. Presence is not a
// signature verification; that needs `gh attestation verify` on the bytes.
export async function describeAttestation({ owner, repo, digest, fetchImpl, token = "", apiBase, client } = {}) {
  if (!/^sha256:[a-f0-9]{64}$/.test(String(digest || ""))) return { status: "attestation_unverified", reason: "digest_unknown" };
  const api = client || createGithubClient({ fetchImpl, token, apiBase });
  try {
    const payload = await api.json(`/repos/${owner}/${repo}/attestations/${digest}`);
    const count = Array.isArray(payload?.attestations) ? payload.attestations.length : 0;
    return count ? { status: "attestation_present_unverified", count } : { status: "attestation_missing", count: 0 };
  } catch (error) {
    if (error?.code === "github_api_not_found") return { status: "attestation_missing", count: 0 };
    return { status: "attestation_unverified", reason: error?.code || "attestation_lookup_failed" };
  }
}

const sha256 = (buffer) => `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;

// Downloads the runtime artifact (token required), checks its archive digest
// against the API metadata, rebuilds its content manifest and compares it with
// the locally built tree. Optionally cross-checks the CI manifest artifact and
// runs an injected attestation verifier on the downloaded bytes.
export async function verifyArtifactContent({ owner, repo, artifacts, localManifest, policy, fetchImpl, token = "", apiBase, client, ghVerify = null } = {}) {
  const effectivePolicy = policy || await loadReleasePolicy();
  const subtrees = effectivePolicy.artifacts?.compareSubtrees || [];
  const api = client || createGithubClient({ fetchImpl, token, apiBase });
  const result = { ok: false, problems: [], downloaded: false, digestMatch: null, contentMatch: null, ciManifestMatch: null, attestation: { status: "attestation_unverified" } };
  const runtime = artifacts?.runtime;
  if (!runtime?.id) { result.problems.push("runtime_artifact_missing"); return result; }
  if (!token) { result.problems.push("github_token_required_for_download"); return result; }
  let archive;
  try {
    archive = await api.download(`/repos/${owner}/${repo}/actions/artifacts/${runtime.id}/zip`);
  } catch (error) {
    result.problems.push(error?.code === "github_artifact_expired" ? "runtime_artifact_expired" : "runtime_artifact_download_failed");
    return result;
  }
  result.downloaded = true;
  result.archiveDigest = sha256(archive);
  result.digestMatch = Boolean(runtime.digest) && result.archiveDigest === runtime.digest;
  if (!result.digestMatch) result.problems.push("artifact_digest_mismatch");
  let artifactManifest;
  try {
    artifactManifest = manifestFromEntries(zipEntries(archive), { root: "dist" });
  } catch {
    result.problems.push("artifact_archive_invalid");
    return result;
  }
  result.artifactTree = manifestSummary(artifactManifest);
  const comparison = compareContentManifests(artifactManifest, localManifest, { subtrees });
  result.contentMatch = comparison.match;
  result.comparison = comparison;
  if (!comparison.match) result.problems.push("artifact_content_mismatch");
  if (artifacts.manifest?.id) {
    try {
      const manifestArchive = await api.download(`/repos/${owner}/${repo}/actions/artifacts/${artifacts.manifest.id}/zip`);
      const digestOk = !artifacts.manifest.digest || sha256(manifestArchive) === artifacts.manifest.digest;
      const entry = zipEntries(manifestArchive, { includeData: true }).find((row) => row.path.endsWith(".json"));
      const ciManifest = entry ? JSON.parse(entry.data.toString("utf8")) : null;
      result.ciManifestMatch = digestOk && ciManifest?.treeDigest === artifactManifest.treeDigest;
    } catch {
      result.ciManifestMatch = false;
    }
    if (!result.ciManifestMatch) result.problems.push("ci_manifest_mismatch");
  }
  if (typeof ghVerify === "function") {
    try {
      result.attestation = await ghVerify(archive, { owner, repo });
    } catch {
      result.attestation = { status: "attestation_failed" };
    }
    if (result.attestation.status === "attestation_failed") result.problems.push("attestation_failed");
  }
  result.ok = result.problems.length === 0;
  return result;
}
