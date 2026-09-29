// Optional attestation signature verification through the GitHub CLI. When
// `gh` is not installed the verifier is null and callers report
// "attestation_unverified" instead of failing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { githubTokenFromEnv } from "./github-api.mjs";

export function ghAvailable({ env = process.env, spawn = spawnSync } = {}) {
  if (String(env.ORKESTR_DEPLOY_ATTESTATION_GH || "1") === "0") return false;
  const probe = spawn("gh", ["--version"], { stdio: "ignore", env });
  return probe.status === 0;
}

export function ghAttestationVerifier({ env = process.env, spawn = spawnSync, workflowPath = ".github/workflows/ci.yml" } = {}) {
  if (!ghAvailable({ env, spawn })) return null;
  return async (archive, { owner, repo }) => {
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
      return result.status === 0 ? { status: "attestation_verified", verifier: "gh" } : { status: "attestation_failed", verifier: "gh" };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
