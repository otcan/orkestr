import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function blocked(reason, details) {
  const error = new Error(reason);
  error.statusCode = 409;
  error.blocker = { ...details, reason };
  return error;
}

// A privileged deploy process must not replace a runtime user's index or refs.
// Do not infer Unix accounts from thread principals, or attempt permission repair.
async function inspectOwnership(checkout, expectedIdentity) {
  const effectiveUid = process.geteuid?.();
  const expectedUid = expectedIdentity?.uid;
  const expectedGid = expectedIdentity?.gid;
  const context = {
    checkout: String(checkout || ""),
    effectiveUid: effectiveUid ?? null,
    ...(Number.isInteger(expectedUid) && expectedUid !== effectiveUid ? { expectedUid } : {}),
  };
  if (!Number.isInteger(effectiveUid) || !Number.isInteger(expectedUid) || !checkout) {
    throw blocked("worker_git_ownership_unavailable", context);
  }
  const inspect = async (target, role, optional = false) => {
    let stat;
    try { stat = await fs.lstat(target); }
    catch (error) { if (optional && error.code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink()) throw blocked("worker_git_ownership_unavailable", { ...context, path: target, role, detail: "symlink" });
    if (stat.uid !== expectedUid) throw blocked("worker_git_owner_mismatch", {
      ...context, path: target, role, ownerUid: stat.uid,
    });
  };
  try {
    const root = await fs.realpath(checkout);
    await inspect(root, "checkout");
    await inspect(path.join(root, ".git"), "git_entry", true);
    const runAsOwner = effectiveUid === 0 && expectedUid !== 0;
    const git = async args => (await exec("git", ["--no-optional-locks", "-C", root, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      ...(runAsOwner ? { uid: expectedUid, gid: expectedGid } : {}),
    })).stdout.trim();
    const top = await git(["rev-parse", "--show-toplevel"]);
    const gitDir = await git(["rev-parse", "--absolute-git-dir"]);
    const commonDir = path.resolve(root, await git(["rev-parse", "--git-common-dir"]));
    await inspect(top, "checkout_root");
    await inspect(path.join(top, ".git"), "git_entry");
    for (const directory of new Set([gitDir, commonDir])) {
      await inspect(directory, "git_directory");
      for (const name of ["HEAD", "index", "packed-refs", "refs", "objects", "logs"]) {
        await inspect(path.join(directory, name), `git_${name}`, true);
      }
    }
    // Include the current branch's existing intermediate directories and leaf.
    // Missing leaves are created by Git under the already verified parent.
    let branch = "";
    try { branch = await git(["symbolic-ref", "--quiet", "HEAD"]); }
    catch (error) { if (error.code !== 1) throw error; }
    if (branch) {
      if (!branch.startsWith("refs/heads/") || branch.split("/").some(part => !part || part === "." || part === "..")) {
        throw blocked("worker_git_ownership_unavailable", { ...context, detail: "invalid_branch_ref" });
      }
      for (const prefix of [commonDir, path.join(commonDir, "logs")]) {
        const segments = branch.split("/");
        for (let i = 1; i <= segments.length; i++) {
          await inspect(path.join(prefix, ...segments.slice(0, i)), "branch_ref", true);
        }
      }
    }
    return { effectiveUid, ownerUid: expectedUid, ownerGid: expectedGid, checkout: top, gitDir, commonDir };
  } catch (error) {
    if (error.blocker) throw error;
    throw blocked("worker_git_ownership_unavailable", { ...context, detail: error.code || "inspection_failed" });
  }
}

export async function assertWorkerGitOwnership(checkout) {
  const effectiveUid = process.geteuid?.();
  const effectiveGid = process.getegid?.();
  return inspectOwnership(checkout, { uid: effectiveUid, gid: effectiveGid });
}

// Privileged orchestration may need to perform a read-only inspection of a
// runtime-owned checkout before staging a push elsewhere. Validate that the
// checkout and every Git path share the checkout owner's uid, and run Git's
// read probes as that owner so root never creates files in the runtime tree.
export async function inspectWorkerGitOwnership(checkout) {
  if (!checkout) throw blocked("worker_git_ownership_unavailable", { checkout: String(checkout || "") });
  let root;
  let stat;
  try {
    root = await fs.realpath(checkout);
    stat = await fs.lstat(root);
  } catch (error) {
    throw blocked("worker_git_ownership_unavailable", {
      checkout: String(checkout || ""),
      detail: error?.code || "inspection_failed",
    });
  }
  if (stat.isSymbolicLink()) {
    throw blocked("worker_git_ownership_unavailable", { checkout: String(checkout || ""), detail: "symlink" });
  }
  return inspectOwnership(root, { uid: stat.uid, gid: stat.gid });
}
