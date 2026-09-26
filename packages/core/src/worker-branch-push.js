// Admin/parent-mediated action that pushes a worker's own stored branch to
// origin and nothing else. This is deliberately narrower than the
// release-train's syncSafeThreadWorkersWithParents: it never merges, never
// force-pushes, and refuses to touch main, the worker's base branch, or any
// remote other than the one already recorded on the thread.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { appendEvent } from "../../storage/src/store.js";
import { getThread, updateThread } from "./threads.js";
import { assertWorkerGitOwnership, inspectWorkerGitOwnership } from "./worker-git-ownership.js";

const execFileAsync = promisify(execFile);

function nonEmptyString(value) {
  return String(value || "").trim();
}

function httpError(message, statusCode = 400, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

async function git(repoPath, args, options = {}) {
  const { stdout, stderr } = await execFileAsync("git", ["-C", repoPath, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    ...(Number.isInteger(options.uid) ? { uid: options.uid } : {}),
    ...(Number.isInteger(options.gid) ? { gid: options.gid } : {}),
  });
  return { stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() };
}

function threadCheckoutPath(thread = {}) {
  const runtime = thread?.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  return nonEmptyString(
    thread.worktreePath || thread.repoPath || runtime.worktreePath || runtime.repoPath || runtime.workspace || thread.cwd || thread.workspace,
  );
}

async function resolveGitRoot(candidate, options = {}) {
  const repoPath = nonEmptyString(candidate);
  if (!repoPath) return null;
  try {
    const { stdout } = await git(repoPath, ["rev-parse", "--show-toplevel"], options);
    return stdout || null;
  } catch {
    return null;
  }
}

async function currentBranch(repoPath, options = {}) {
  return git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], options).then((result) => result.stdout).catch(() => "");
}

async function repoRemoteUrl(repoPath, options = {}) {
  return git(repoPath, ["config", "--get", "remote.origin.url"], options).then((result) => result.stdout).catch(() => "");
}

async function assertValidBranchName(branchName) {
  if (!branchName || branchName.startsWith("-")) throw httpError("invalid_worker_branch_name", 400);
  try {
    await execFileAsync("git", ["check-ref-format", "--branch", branchName]);
  } catch {
    throw httpError("invalid_worker_branch_name", 400);
  }
}

const PROTECTED_BRANCH_NAMES = new Set(["main", "master"]);

export function isProtectedWorkerBranchName(branchName, baseBranch = "") {
  const value = nonEmptyString(branchName);
  if (!value) return true;
  if (PROTECTED_BRANCH_NAMES.has(value.toLowerCase())) return true;
  const base = nonEmptyString(baseBranch);
  return Boolean(base && value === base);
}

async function assertRemoteNotAhead(repoPath, storedBranch) {
  const remoteRef = `refs/remotes/origin/${storedBranch}`;
  const advertised = await git(repoPath, ["ls-remote", "--heads", "origin", `refs/heads/${storedBranch}`]);
  if (!advertised.stdout) return;
  await git(repoPath, ["fetch", "--no-tags", "origin", `refs/heads/${storedBranch}:${remoteRef}`]);
  const counts = await git(repoPath, ["rev-list", "--left-right", "--count", `${remoteRef}...HEAD`]);
  const [behindRaw] = counts.stdout.split(/\s+/);
  const behind = Number(behindRaw);
  if (Number.isFinite(behind) && behind > 0) {
    throw httpError("worker_remote_has_new_commits", 409, { behind });
  }
}

async function pushFromPrivilegedStaging(checkout, storedBranch, remoteUrl) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-worker-branch-push-"));
  try {
    const bundle = path.join(staging, "worker.bundle");
    // The checkout is only read, with optional locks disabled and an explicit
    // safe-directory exception. All fetch/push writes happen in this root-owned
    // temporary bare repository, never in the runtime user's checkout.
    await execFileAsync("git", [
      "-c", `safe.directory=${checkout}`,
      "-C", checkout,
      "bundle", "create", bundle,
      `refs/heads/${storedBranch}`,
    ], {
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    const bare = path.join(staging, "repo.git");
    await execFileAsync("git", ["init", "--bare", bare], {
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    await git(bare, ["fetch", bundle, `refs/heads/${storedBranch}:refs/heads/${storedBranch}`]);
    await git(bare, ["symbolic-ref", "HEAD", `refs/heads/${storedBranch}`]);
    await git(bare, ["remote", "add", "origin", remoteUrl]);
    await assertRemoteNotAhead(bare, storedBranch);
    await git(bare, ["push", "origin", `HEAD:refs/heads/${storedBranch}`]);
  } finally {
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

export async function pushWorkerOwnBranch(threadId, options = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw httpError("thread_not_found", 404);
  if (!nonEmptyString(thread.parentThreadId)) throw httpError("thread_is_not_worker", 400);

  const storedBranch = nonEmptyString(thread.branchName);
  if (!storedBranch) throw httpError("worker_branch_unknown", 409);
  if (isProtectedWorkerBranchName(storedBranch, thread.baseBranch)) {
    throw httpError("worker_branch_protected", 403, { branchName: storedBranch, baseBranch: thread.baseBranch || null });
  }
  await assertValidBranchName(storedBranch);

  const checkout = threadCheckoutPath(thread);
  const effectiveUid = process.geteuid?.();
  const checkoutStat = await fs.stat(checkout).catch(() => null);
  const privilegedRuntimeCheckout = effectiveUid === 0 && checkoutStat && checkoutStat.uid !== 0;
  const ownership = privilegedRuntimeCheckout
    ? await inspectWorkerGitOwnership(checkout)
    : await assertWorkerGitOwnership(checkout);
  const ownerOptions = privilegedRuntimeCheckout ? { uid: ownership.ownerUid, gid: ownership.ownerGid } : {};
  const repoPath = await resolveGitRoot(checkout, ownerOptions);
  if (!repoPath) throw httpError("thread_repo_not_found", 404);

  const headBranch = await currentBranch(repoPath, ownerOptions);
  if (headBranch !== storedBranch) {
    throw httpError("worker_branch_head_mismatch", 409, { headBranch, storedBranch });
  }

  const remoteUrl = await repoRemoteUrl(repoPath, ownerOptions);
  if (!remoteUrl) throw httpError("worker_remote_not_configured", 409);
  const storedRemoteUrl = nonEmptyString(thread.repoRemoteUrl);
  if (!storedRemoteUrl) throw httpError("worker_stored_remote_unknown", 409);
  if (remoteUrl !== storedRemoteUrl) {
    throw httpError("worker_remote_mismatch", 409, { remoteUrl, storedRemoteUrl });
  }

  if (privilegedRuntimeCheckout) {
    await pushFromPrivilegedStaging(repoPath, storedBranch, remoteUrl);
  } else {
    await assertRemoteNotAhead(repoPath, storedBranch);
    // -u (never --force) sets the local upstream when the service and checkout
    // share an identity. Privileged services instead use isolated staging so
    // they never leave root-owned files in a runtime user's checkout.
    await git(repoPath, ["push", "-u", "origin", `HEAD:refs/heads/${storedBranch}`]);
  }

  const remoteBranch = `origin/${storedBranch}`;
  const updated = await updateThread(thread.id, {
    remoteBranch,
    gitRemoteBranchExists: true,
    gitRemoteMissing: false,
  }, env);

  await appendEvent({
    type: "worker_own_branch_pushed",
    threadId: thread.id,
    branchName: storedBranch,
    remoteBranch,
    operatorUserId: nonEmptyString(options.operatorUserId) || null,
  }, env).catch(() => {});

  return { pushed: true, branchName: storedBranch, remoteBranch, thread: updated };
}
