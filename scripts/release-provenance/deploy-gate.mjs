#!/usr/bin/env node
// Deployer entry for the release provenance gate (ORK-519).
//
//   deploy-gate.mjs pre  --repo-url URL --sha SHA --output FILE
//     Before build/activation: required CI checks for the exact commit, CI run
//     artifact metadata and attestation lookup.
//   deploy-gate.mjs post --release-dir DIR --provenance FILE [--manifest FILE]
//     After build, before activation: installed-tree digest, optional artifact
//     download + content comparison, and recording into release-manifest.json.
//
// Modes (env): ORKESTR_DEPLOY_REQUIRE_CHECKS=enforce|warn|off (default enforce),
// ORKESTR_DEPLOY_ARTIFACT_PROVENANCE=off|warn|enforce (default warn).
// Exit 0 = continue, 77 = rejected by an enforcing gate, 2 = bad configuration.
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "../main-module.mjs";
import { buildContentManifest, manifestSummary } from "./content-manifest.mjs";
import { createGithubClient, githubTokenFromEnv, parseGithubRepository } from "./github-api.mjs";
import { ghAttestationVerifier, ghUnavailableReason } from "./gh-attestation.mjs";
import { describeAttestation, describeRunArtifacts, loadReleasePolicy, verifyArtifactContent, verifyRequiredChecks } from "./verify.mjs";

export const GATE_REJECTED_EXIT_CODE = 77;
export const RELEASE_TREE_EXCLUDES = ["node_modules", ".git", "release-manifest.json", ".orkestr-release-ready"];
const CHECK_MODES = ["enforce", "warn", "off"];

export function gateModes(env = process.env) {
  const checks = String(env.ORKESTR_DEPLOY_REQUIRE_CHECKS || "enforce").trim().toLowerCase();
  const artifact = String(env.ORKESTR_DEPLOY_ARTIFACT_PROVENANCE || "warn").trim().toLowerCase();
  if (!CHECK_MODES.includes(checks)) throw new Error("ORKESTR_DEPLOY_REQUIRE_CHECKS must be enforce, warn, or off.");
  if (!CHECK_MODES.includes(artifact)) throw new Error("ORKESTR_DEPLOY_ARTIFACT_PROVENANCE must be off, warn, or enforce.");
  return { checks, artifact };
}

function decide(modes, checkReasons, artifactReasons) {
  const rejected = (modes.checks === "enforce" && checkReasons.length > 0) || (modes.artifact === "enforce" && artifactReasons.length > 0);
  const warned = checkReasons.length > 0 || artifactReasons.length > 0;
  return rejected ? "rejected" : warned ? "warned" : "passed";
}

function compactChecks(checks) {
  if (!checks) return null;
  return {
    status: checks.status,
    runId: checks.runId || null,
    runUrl: checks.runUrl || null,
    headShaMatch: Boolean(checks.headShaMatch),
    required: checks.required || null,
    checks: (checks.checks || []).map(({ name, status, conclusion }) => ({ name, status, conclusion })),
    missing: checks.missing || [],
    failed: checks.failed || [],
    pending: checks.pending || [],
    ...(checks.error ? { error: checks.error } : {}),
  };
}

export async function runPreGate({ repoUrl, sha, env = process.env, fetchImpl = globalThis.fetch, policy, now = () => new Date() } = {}) {
  const modes = gateModes(env);
  const token = githubTokenFromEnv(env);
  const repository = parseGithubRepository(env.ORKESTR_DEPLOY_PROVENANCE_REPO || repoUrl);
  const record = {
    schemaVersion: 1,
    repository: repository ? `${repository.owner}/${repository.repo}` : null,
    commit: sha,
    checkedAt: now().toISOString(),
    tokenUsed: Boolean(token),
    gate: { requireChecks: modes.checks, artifactProvenance: modes.artifact, result: "skipped", reasons: [] },
    ci: null,
    artifact: null,
    attestation: { status: "attestation_unverified" },
  };
  if (modes.checks === "off" && modes.artifact === "off") return record;
  const checkReasons = [];
  const artifactReasons = [];
  if (!repository) {
    if (modes.checks !== "off") checkReasons.push("repository_not_github");
    if (modes.artifact !== "off") artifactReasons.push("repository_not_github");
  } else {
    const effectivePolicy = policy || await loadReleasePolicy();
    const client = createGithubClient({ fetchImpl, token, apiBase: env.ORKESTR_GITHUB_API_URL });
    const { owner, repo } = repository;
    const checks = await verifyRequiredChecks({ owner, repo, sha, policy: effectivePolicy, client });
    record.ci = compactChecks(checks);
    if (modes.checks !== "off" && !checks.ok) checkReasons.push(...checks.reasons);
    if (modes.artifact !== "off") {
      // CI attests push and dispatch builds only. A pull_request run that passed
      // for the same commit has an artifact nobody signed, so among the runs that
      // passed, take the artifact from one that has an attestation.
      let artifacts = null;
      for (const runId of new Set([checks.runId, ...(checks.passedRunIds || [])])) {
        const described = await describeRunArtifacts({ owner, repo, runId, sha, policy: effectivePolicy, client });
        const attestation = described.runtime?.digest ? await describeAttestation({ owner, repo, digest: described.runtime.digest, client }) : null;
        const attested = attestation?.status === "attestation_present_unverified";
        if (!artifacts || attested) {
          artifacts = described;
          record.attestation = attestation || { status: "attestation_unverified" };
        }
        if (attested) break;
      }
      record.artifact = { runId: artifacts.runId, runtime: artifacts.runtime, manifest: artifacts.manifest, problems: artifacts.problems };
      artifactReasons.push(...artifacts.problems);
      if (record.attestation.status === "attestation_missing") {
        artifactReasons.push("attestation_missing");
        // The run that would attest this commit may simply not have finished yet.
        if (checks.incompleteRunIds?.length) artifactReasons.push("attestation_run_pending");
      }
      // A lookup that could not be made says nothing about the artifact, so an
      // enforcing gate stops instead of reading it as "nothing wrong found".
      if (modes.artifact === "enforce" && record.attestation.status === "attestation_unverified" && record.attestation.reason && record.attestation.reason !== "digest_unknown") artifactReasons.push("attestation_lookup_failed");
      if (modes.artifact === "enforce" && !token) artifactReasons.push("github_token_required_for_download");
    }
  }
  record.gate.reasons = [...new Set([...checkReasons, ...artifactReasons])];
  record.gate.result = decide(modes, checkReasons, artifactReasons);
  return record;
}

export async function runPostGate({ releaseDir, provenance, env = process.env, fetchImpl = globalThis.fetch, policy, ghVerify, spawn } = {}) {
  const modes = gateModes(env);
  const record = { ...provenance, gate: { ...(provenance?.gate || {}), reasons: [...(provenance?.gate?.reasons || [])] } };
  const distManifest = await buildContentManifest(path.join(releaseDir, "dist"), { label: "dist" });
  record.installedTree = {
    dist: manifestSummary(distManifest),
    release: manifestSummary(await buildContentManifest(releaseDir, { exclude: RELEASE_TREE_EXCLUDES, label: "release" })),
  };
  const repository = parseGithubRepository(record.repository || "");
  const token = githubTokenFromEnv(env);
  if (modes.artifact === "off") return record;
  const verifier = ghVerify === undefined ? ghAttestationVerifier({ env, spawn }) : ghVerify;
  if (repository && record.artifact?.runtime?.id && token) {
    const content = await verifyArtifactContent({
      owner: repository.owner,
      repo: repository.repo,
      sha: record.commit,
      artifacts: record.artifact,
      localManifest: distManifest,
      policy: policy || await loadReleasePolicy(),
      client: createGithubClient({ fetchImpl, token, apiBase: env.ORKESTR_GITHUB_API_URL }),
      token,
      ghVerify: verifier,
    });
    record.artifact = { ...record.artifact, verification: { ok: content.ok, problems: content.problems, digestMatch: content.digestMatch, contentMatch: content.contentMatch, ciManifestMatch: content.ciManifestMatch, comparison: content.comparison || null } };
    // The verification result supersedes whatever the pre-gate lookup reported.
    if (content.attestation) record.attestation = { ...record.attestation, reason: undefined, ...content.attestation };
    if (!content.ok) {
      record.gate.reasons = [...new Set([...record.gate.reasons, ...content.problems])];
      if (modes.artifact === "enforce") record.gate.result = "rejected";
      else if (record.gate.result === "passed") record.gate.result = "warned";
    }
  }
  // Enforce means the signature was checked and matched. No verifier, or a
  // verification that never ran, is not a pass; warn records why and continues.
  if (!["attestation_verified", "attestation_failed"].includes(record.attestation?.status)) {
    const reason = typeof verifier === "function" ? "attestation_not_verified" : ghUnavailableReason({ env, spawn }) || "attestation_verifier_unavailable";
    record.attestation = { status: "attestation_unverified", ...record.attestation, reason: record.attestation?.reason || reason };
    if (modes.artifact === "enforce") {
      record.gate.reasons = [...new Set([...record.gate.reasons, reason])];
      record.gate.result = "rejected";
    }
  }
  return record;
}

export async function recordInManifest(manifestFile, provenance) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  } catch {
    return false;
  }
  manifest.provenance = provenance;
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
}

function report(record, stderr) {
  const { gate } = record;
  const ci = record.ci?.runUrl ? ` CI run ${record.ci.runUrl}.` : "";
  if (gate.result === "rejected") {
    stderr.write(`Release provenance gate rejected ${record.commit} (checks=${gate.requireChecks}, artifact=${gate.artifactProvenance}): ${gate.reasons.join(", ")}.${ci}\n`);
    if (gate.reasons.includes("attestation_run_pending")) stderr.write("Another CI run for this commit has not finished, and only push and dispatch runs attest the artifact. Retry when it has completed.\n");
    stderr.write("Fix CI for this exact commit, or set ORKESTR_DEPLOY_REQUIRE_CHECKS / ORKESTR_DEPLOY_ARTIFACT_PROVENANCE to warn for an explicitly accepted exception.\n");
  } else if (gate.result === "warned") {
    stderr.write(`Release provenance warning for ${record.commit}: ${gate.reasons.join(", ")} (continuing; checks=${gate.requireChecks}, artifact=${gate.artifactProvenance}).${ci}\n`);
  } else if (gate.result === "passed") {
    stderr.write(`Release provenance gate passed for ${record.commit}.${ci} Attestation: ${record.attestation?.status || "attestation_unverified"}.\n`);
  }
}

export async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl = globalThis.fetch, stderr = process.stderr } = {}) {
  const phase = argv[0];
  const { values } = parseArgs({ args: argv.slice(1), options: Object.fromEntries(["repo-url", "sha", "output", "release-dir", "provenance", "manifest"].map((name) => [name, { type: "string" }])) });
  try {
    gateModes(env);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }
  let record;
  if (phase === "pre") {
    if (!values.sha || !values.output) { stderr.write("Usage: deploy-gate.mjs pre --repo-url URL --sha SHA --output FILE\n"); return 2; }
    record = await runPreGate({ repoUrl: values["repo-url"], sha: values.sha, env, fetchImpl });
    await fs.writeFile(values.output, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  } else if (phase === "post") {
    if (!values["release-dir"] || !values.provenance) { stderr.write("Usage: deploy-gate.mjs post --release-dir DIR --provenance FILE [--manifest FILE]\n"); return 2; }
    let provenance = null;
    try { provenance = JSON.parse(await fs.readFile(values.provenance, "utf8")); } catch {}
    if (!provenance) {
      const modes = gateModes(env);
      if (modes.checks === "enforce" || modes.artifact === "enforce") {
        stderr.write("Release provenance record from the pre-build gate is missing.\n");
        return GATE_REJECTED_EXIT_CODE;
      }
      provenance = { schemaVersion: 1, gate: { requireChecks: modes.checks, artifactProvenance: modes.artifact, result: modes.checks === "off" && modes.artifact === "off" ? "skipped" : "warned", reasons: ["pre_gate_record_missing"] } };
    }
    record = await runPostGate({ releaseDir: values["release-dir"], provenance, env, fetchImpl });
    await fs.writeFile(values.provenance, `${JSON.stringify(record, null, 2)}\n`);
    await recordInManifest(values.manifest || path.join(values["release-dir"], "release-manifest.json"), record);
  } else {
    stderr.write("Usage: deploy-gate.mjs pre|post ...\n");
    return 2;
  }
  report(record, stderr);
  return record.gate.result === "rejected" ? GATE_REJECTED_EXIT_CODE : 0;
}

if (isMainModule(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    // An internal error fails closed only when a mode is enforcing.
    const modes = (() => { try { return gateModes(); } catch { return { checks: "enforce", artifact: "enforce" }; } })();
    const enforcing = modes.checks === "enforce" || modes.artifact === "enforce";
    process.stderr.write(`Release provenance gate ${enforcing ? "failed" : "warning"}: ${error?.message || error}\n`);
    process.exitCode = enforcing ? GATE_REJECTED_EXIT_CODE : 0;
  });
}
