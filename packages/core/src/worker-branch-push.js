// Admin/parent-mediated action that pushes a worker's own stored branch to
// origin and nothing else. This is deliberately narrower than the
// release-train's syncSafeThreadWorkersWithParents: it never merges, never
// force-pushes, and refuses to touch main, the worker's base branch, or any
// remote other than the one already recorded on the thread.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendEvent } from "../../storage/src/store.js";
import { getThread, updateThread } from "./threads.js";
import { assertWorkerGitOwnership } from "./worker-git-ownership.js";

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

async function git(repoPath, args) {
  const { stdout, stderr } = await execFileAsync("git", ["-C", repoPath, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return { stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() };
}

function threadCheckoutPath(thread = {}) {
  const runtime = thread?.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  return nonEmptyString(
    thread.worktreePath || thread.repoPath || runtime.worktreePath || runtime.repoPath || runtime.workspace || thread.cwd || thread.workspace,
  );
}

async function resolveGitRoot(candidate) {
  const repoPath = nonEmptyString(candidate);
  if (!repoPath) return null;
  try {
    const { stdout } = await git(repoPath, ["rev-parse", "--show-toplevel"]);
    return stdout || null;
  } catch {
    return null;
  }
}

async function currentBranch(repoPath) {
  return git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).then((result) => result.stdout).catch(() => "");
}

async function repoRemoteUrl(repoPath) {
  return git(repoPath, ["config", "--get", "remote.origin.url"]).then((result) => result.stdout).catch(() => "");
}

async function refExists(repoPath, ref) {
  if (!ref) return false;
  return git(repoPath, ["rev-parse", "--verify", "--quiet", ref]).then(() => true).catch(() => false);
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
  await assertWorkerGitOwnership(checkout);
  const repoPath = await resolveGitRoot(checkout);
  if (!repoPath) throw httpError("thread_repo_not_found", 404);

  const headBranch = await currentBranch(repoPath);
  if (headBranch !== storedBranch) {
    throw httpError("worker_branch_head_mismatch", 409, { headBranch, storedBranch });
  }

  const remoteUrl = await repoRemoteUrl(repoPath);
  if (!remoteUrl) throw httpError("worker_remote_not_configured", 409);
  const storedRemoteUrl = nonEmptyString(thread.repoRemoteUrl);
  if (storedRemoteUrl && remoteUrl !== storedRemoteUrl) {
    throw httpError("worker_remote_mismatch", 409, { remoteUrl, storedRemoteUrl });
  }

  await git(repoPath, ["fetch", "origin", storedBranch]).catch(() => {});
  const remoteRef = `refs/remotes/origin/${storedBranch}`;
  if (await refExists(repoPath, remoteRef)) {
    const counts = await git(repoPath, ["rev-list", "--left-right", "--count", `${remoteRef}...HEAD`])
      .then((result) => result.stdout)
      .catch(() => "");
    const [behindRaw] = counts.split(/\s+/);
    const behind = Number(behindRaw);
    if (Number.isFinite(behind) && behind > 0) {
      throw httpError("worker_remote_has_new_commits", 409, { behind });
    }
  }

  // -u (never --force) sets the local upstream tracking branch as well as
  // persisting remoteBranch on the thread record below.
  await git(repoPath, ["push", "-u", "origin", `HEAD:refs/heads/${storedBranch}`]);

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
