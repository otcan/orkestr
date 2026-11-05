// Attestation signature verification through the GitHub CLI. When `gh` cannot
// be used the verifier is null and callers report "attestation_unverified";
// a gate in enforce mode rejects that, and `ghUnavailableReason` says why.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { githubTokenFromEnv } from "./github-api.mjs";

const disabled = (env) => String(env.ORKESTR_DEPLOY_ATTESTATION_GH || "1") === "0";

export function ghAvailable({ env = process.env, spawn = spawnSync } = {}) {
  if (disabled(env)) return false;
  const probe = spawn("gh", ["--version"], { stdio: "ignore", env });
  return probe.status === 0;
}

export function ghUnavailableReason({ env = process.env, spawn = spawnSync } = {}) {
  if (disabled(env)) return "attestation_verifier_disabled";
  return ghAvailable({ env, spawn }) ? "" : "attestation_verifier_unavailable";
}

// `gh attestation verify` proves who signed (repository and workflow), not what
// was built. The signing certificate also names the source commit and ref, so
// an attestation made for another commit, or from a ref the release policy does
// not release from, is refused here.
export function attestationBinding(stdout, { sha, allowedRefs = [] } = {}) {
  let certificates = [];
  try {
    certificates = JSON.parse(stdout).map((row) => row?.verificationResult?.signature?.certificate).filter(Boolean);
  } catch {}
  if (!certificates.length) return { reason: "attestation_identity_unreadable" };
  const forCommit = certificates.filter((certificate) => sha && certificate.sourceRepositoryDigest === sha);
  if (!forCommit.length) return { reason: "attestation_commit_mismatch" };
  const allowed = forCommit.find((certificate) => allowedRefs.includes(certificate.sourceRepositoryRef));
  return allowed ? { sourceCommit: sha, sourceRef: allowed.sourceRepositoryRef } : { reason: "attestation_ref_not_allowed" };
}

export function ghAttestationVerifier({ env = process.env, spawn = spawnSync, workflowPath = ".github/workflows/ci.yml" } = {}) {
  if (!ghAvailable({ env, spawn })) return null;
  return async (archive, { owner, repo, sha, allowedRefs }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orkestr-attest-"));
    const file = path.join(dir, "runtime-dist.zip");
    try {
      fs.writeFileSync(file, archive, { mode: 0o600 });
      const token = githubTokenFromEnv(env);
      const result = spawn("gh", [
        "attestation", "verify", file,
        "--repo", `${owner}/${repo}`,
        "--signer-workflow", `${owner}/${repo}/${workflowPath}`,
        "--format", "json",
      ], { env: { ...env, ...(token ? { GH_TOKEN: token } : {}) }, encoding: "utf8", timeout: 120000 });
      if (result.status !== 0) return { status: "attestation_failed", verifier: "gh" };
      const binding = attestationBinding(result.stdout, { sha, allowedRefs });
      return binding.reason ? { status: "attestation_failed", verifier: "gh", reason: binding.reason } : { status: "attestation_verified", verifier: "gh", ...binding };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
