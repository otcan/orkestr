import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent } from "../../storage/src/store.js";
import { createThread, enqueueThreadInput, getThread, listThreadMessages, listThreads, updateThread } from "./threads.js";

const execFileAsync = promisify(execFile);

function httpError(message, statusCode = 400, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function safeSegment(value, fallback = "thread") {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || fallback;
}

function nonEmptyString(value) {
  return String(value || "").trim();
}

function codexThreadId(thread) {
  return nonEmptyString(thread?.executor?.codexThreadId || thread?.codexThreadId);
}

function threadDisplayName(thread) {
  return nonEmptyString(thread?.bindingName || thread?.name || thread?.title || thread?.id);
}

function workerBranchName(parent, workerId, input = {}) {
  const explicit = nonEmptyString(input.branchName || input.branch);
  if (explicit) return explicit;
  const parentName = safeSegment(parent.bindingName || parent.name || parent.id, "thread");
  const suffix = safeSegment(workerId.replace(/^worker-/, ""), randomUUID().slice(0, 8));
  return `orkestr/${parentName}/${suffix}`;
}

async function git(repoPath, args, options = {}) {
  const { stdout, stderr } = await execFileAsync("git", ["-C", repoPath, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  return { stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() };
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

function repoCandidates(parent, input = {}) {
  const metadata = parent.executor?.metadata && typeof parent.executor.metadata === "object" ? parent.executor.metadata : {};
  const runtime = parent.runtime && typeof parent.runtime === "object" ? parent.runtime : {};
  const explicit = [
    input.repoPath,
    input.projectRoot,
    input.cwd,
  ];
  const workerCheckout = [
    parent.worktreePath,
    parent.cwd,
    parent.workspace,
    runtime.worktreePath,
    runtime.workspace,
    metadata.worktreePath,
    metadata.workspace,
    metadata.cwd,
  ];
  const parentCheckout = [
    parent.repoPath,
    parent.projectRoot,
    parent.cwd,
    parent.workspace,
    parent.worktreePath,
    runtime.repoPath,
    runtime.workspace,
    metadata.repoPath,
    metadata.sourceRepoPath,
    metadata.projectRoot,
    metadata.cwd,
    metadata.sourceCwd,
    metadata.workspace,
    metadata.sourceWorkspace,
    metadata.sourceWorkingDirectory,
  ];
  return [
    ...explicit,
    ...(parent.parentThreadId ? workerCheckout : []),
    ...parentCheckout,
    ...(parent.parentThreadId ? [] : workerCheckout),
  ].map(nonEmptyString).filter(Boolean);
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function resolveParentRepo(parent, input = {}) {
  for (const candidate of repoCandidates(parent, input)) {
    const root = await resolveGitRoot(candidate);
    if (root) return root;
  }
  for (const candidate of await tmuxPathCandidates(parent)) {
    const root = await resolveGitRoot(candidate);
    if (root) return root;
  }
  throw httpError("thread_repo_not_found", 400, {
    detail: "Create Worker needs a git repository path. Pass repoPath when the parent runtime cwd is not a git checkout.",
  });
}

async function tmuxPathCandidates(parent) {
  const metadata = parent.executor?.metadata && typeof parent.executor.metadata === "object" ? parent.executor.metadata : {};
  const runtime = parent.runtime && typeof parent.runtime === "object" ? parent.runtime : {};
  const targets = [
    parent.paneId,
    parent.tmuxTarget,
    parent.sessionName,
    runtime.paneId,
    runtime.sessionName,
    parent.executor?.tmuxTarget,
    parent.executor?.sessionName,
    metadata.sourceTmuxTarget,
    metadata.sourceTmuxSession,
  ].map(nonEmptyString).filter(Boolean);
  const paths = [];
  for (const target of [...new Set(targets)]) {
    try {
      const { stdout } = await execFileAsync("tmux", ["display-message", "-p", "-t", target, "#{pane_current_path}"]);
      const cwd = nonEmptyString(stdout);
      if (cwd) paths.push(cwd);
    } catch {
      // Threads can outlive their tmux source pane.
    }
  }
  return paths;
}

async function ensureRefAvailable(repoPath, branchName) {
  try {
    await execFileAsync("git", ["check-ref-format", "--branch", branchName]);
  } catch {
    throw httpError("invalid_worker_branch_name", 400);
  }
  try {
    await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    throw httpError("worker_branch_already_exists", 409);
  } catch (error) {
    if (error?.message === "worker_branch_already_exists") throw error;
  }
}

async function pathExists(filePath) {
  return Boolean(await fs.stat(filePath).catch(() => null));
}

async function worktreePathFor(parent, workerId, env = process.env) {
  const paths = await ensureDataDirs(env);
  const root = path.resolve(env.ORKESTR_WORKTREE_ROOT || path.join(paths.home, "worktrees"));
  const parentPart = safeSegment(parent.id, "parent");
  const workerPart = safeSegment(workerId, "worker");
  return path.join(root, parentPart, workerPart);
}

async function currentBranch(repoPath) {
  const branch = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).then((result) => result.stdout).catch(() => "");
  if (branch && branch !== "HEAD") return branch;
  const symbolicBranch = await git(repoPath, ["symbolic-ref", "--short", "HEAD"]).then((result) => result.stdout).catch(() => "");
  if (symbolicBranch) return symbolicBranch;
  return await git(repoPath, ["rev-parse", "--short", "HEAD"]).then((result) => result.stdout).catch(() => "detached");
}

async function worktreeDirty(repoPath) {
  const status = await git(repoPath, ["status", "--porcelain"]).then((result) => result.stdout).catch(() => "");
  return Boolean(status.trim());
}

async function worktreeDirtyFiles(repoPath) {
  const status = await git(repoPath, ["status", "--porcelain"]).then((result) => result.stdout).catch(() => "");
  return new Set(status
    .split("\n")
    .map((line) => line.slice(3).trim().split(" -> ").at(-1))
    .filter(Boolean)).size;
}

async function repoRemoteUrl(repoPath) {
  return await git(repoPath, ["config", "--get", "remote.origin.url"]).then((result) => result.stdout).catch(() => "");
}

async function remoteTrackingBranch(repoPath, branchName) {
  const upstream = await git(repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    .then((result) => result.stdout)
    .catch(() => "");
  if (upstream) return upstream;
  return branchName ? `origin/${branchName}` : "";
}

async function aheadBehindAgainst(repoPath, ref) {
  if (!ref) return { ahead: null, behind: null };
  const exists = await refExists(repoPath, ref);
  if (!exists) return { ahead: null, behind: null };
  const counts = await git(repoPath, ["rev-list", "--left-right", "--count", `${ref}...HEAD`])
    .then((result) => result.stdout)
    .catch(() => "");
  const [behind, ahead] = counts.split(/\s+/).map((value) => Number(value));
  return {
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
  };
}

async function gitAheadBehind(repoPath, remoteBranch) {
  const counts = await aheadBehindAgainst(repoPath, remoteBranch);
  return {
    gitAhead: counts.ahead,
    gitBehind: counts.behind,
  };
}

async function changedFilesAgainst(repoPath, ref) {
  if (!ref || !(await refExists(repoPath, ref))) return null;
  const diff = await git(repoPath, ["diff", "--name-only", `${ref}..HEAD`])
    .then((result) => result.stdout)
    .catch(() => "");
  return new Set(diff.split("\n").map(nonEmptyString).filter(Boolean)).size;
}

async function refExists(repoPath, ref) {
  if (!ref) return false;
  return await git(repoPath, ["rev-parse", "--verify", "--quiet", ref])
    .then(() => true)
    .catch(() => false);
}

async function changedFilesSince(repoPath, baseCommit) {
  if (!baseCommit || !(await refExists(repoPath, baseCommit))) return null;
  const diff = await git(repoPath, ["diff", "--name-only", `${baseCommit}..HEAD`])
    .then((result) => result.stdout)
    .catch(() => "");
  const dirty = await git(repoPath, ["status", "--porcelain"])
    .then((result) => result.stdout)
    .catch(() => "");
  const paths = new Set();
  for (const line of diff.split("\n")) {
    const file = nonEmptyString(line);
    if (file) paths.add(file);
  }
  for (const line of dirty.split("\n")) {
    const file = nonEmptyString(line.slice(3).split(" -> ").at(-1));
    if (file) paths.add(file);
  }
  return paths.size;
}

async function commitsSince(repoPath, baseCommit) {
  if (!baseCommit || !(await refExists(repoPath, baseCommit))) return null;
  const count = await git(repoPath, ["rev-list", "--count", `${baseCommit}..HEAD`])
    .then((result) => Number(result.stdout))
    .catch(() => Number.NaN);
  return Number.isFinite(count) ? count : null;
}

async function mergeBase(repoPath, ref) {
  if (!ref || !(await refExists(repoPath, ref))) return "";
  return await git(repoPath, ["merge-base", "HEAD", ref])
    .then((result) => result.stdout)
    .catch(() => "");
}

async function headCommit(repoPath) {
  return await git(repoPath, ["rev-parse", "HEAD"])
    .then((result) => result.stdout)
    .catch(() => "");
}

async function gitComparisonStats(repoPath, baseCommit, label) {
  if (!baseCommit || !(await refExists(repoPath, baseCommit))) return null;
  return {
    gitComparisonBase: baseCommit,
    gitComparisonLabel: label || "base",
    gitBaseAhead: await commitsSince(repoPath, baseCommit),
    gitChangedFiles: await changedFilesSince(repoPath, baseCommit),
  };
}

async function parentAheadBehind(repoPath, thread, env = process.env) {
  const parentId = nonEmptyString(thread?.parentThreadId);
  if (!parentId) return null;
  const parent = await getThread(parentId, env).catch(() => null);
  const parentRepoPath = parent ? await resolveGitRoot(threadCheckoutPath(parent)).catch(() => null) : null;
  const parentHead = parentRepoPath ? await headCommit(parentRepoPath) : "";
  if (!parentHead) return null;
  const counts = await aheadBehindAgainst(repoPath, parentHead);
  const changedFiles = await changedFilesAgainst(repoPath, parentHead);
  return {
    gitParentHead: parentHead,
    gitParentAhead: counts.ahead,
    gitParentBehind: counts.behind,
    gitParentChangedFiles: changedFiles,
    gitComparisonBase: parentHead,
    gitComparisonLabel: "parent",
    gitBaseAhead: counts.ahead,
    gitChangedFiles: changedFiles,
  };
}

async function parentThreadComparison(repoPath, thread, env = process.env) {
  const parentId = nonEmptyString(thread?.parentThreadId);
  if (!parentId) return null;
  const parent = await getThread(parentId, env).catch(() => null);
  const parentRepoPath = parent ? await resolveGitRoot(threadCheckoutPath(parent)).catch(() => null) : null;
  const parentHead = parentRepoPath ? await headCommit(parentRepoPath) : "";
  const parentBase = parentHead ? await mergeBase(repoPath, parentHead) : "";
  return await gitComparisonStats(repoPath, parentBase, "parent");
}

function emptyGitComparison() {
  return {
    gitComparisonBase: null,
    gitComparisonLabel: null,
    gitBaseAhead: null,
    gitChangedFiles: null,
    gitParentHead: null,
    gitParentAhead: null,
    gitParentBehind: null,
    gitParentChangedFiles: null,
  };
}

async function gitBaseComparison(repoPath, thread, branchName, env = process.env) {
  const metadata = thread?.executor?.metadata && typeof thread.executor.metadata === "object" ? thread.executor.metadata : {};
  const explicitBaseCommit = nonEmptyString(thread?.baseCommit || metadata.baseCommit);
  const rawBaseBranches = [...new Set([
    thread?.baseBranch,
    metadata.baseBranch,
  ].map(nonEmptyString).filter(Boolean))];
  const isWorker = Boolean(nonEmptyString(thread?.parentThreadId));
  if (isWorker) {
    return await parentAheadBehind(repoPath, thread, env) ||
      await parentThreadComparison(repoPath, thread, env) ||
      await gitComparisonStats(repoPath, explicitBaseCommit, "base") ||
      emptyGitComparison();
  }
  if (rawBaseBranches.includes(branchName)) return emptyGitComparison();
  const baseBranches = rawBaseBranches.filter((ref) => ref !== branchName);
  const branchComparisons = [];
  const baseRefs = [...new Set(baseBranches.flatMap((baseBranch) => [
    baseBranch && !baseBranch.includes("/") ? `origin/${baseBranch}` : "",
    baseBranch,
  ]).map(nonEmptyString).filter((ref) => ref && ref !== branchName))];
  for (const ref of baseRefs) {
    const base = await mergeBase(repoPath, ref);
    const stats = await gitComparisonStats(repoPath, base, ref);
    if (stats) branchComparisons.push(stats);
  }
  if (branchComparisons.length) {
    return branchComparisons.sort((a, b) => {
      const scoreA = Number(a.gitBaseAhead || 0) + Number(a.gitChangedFiles || 0);
      const scoreB = Number(b.gitBaseAhead || 0) + Number(b.gitChangedFiles || 0);
      return scoreA - scoreB;
    })[0];
  }

  return await gitComparisonStats(repoPath, explicitBaseCommit, "base") || emptyGitComparison();
}

function threadCheckoutPath(thread) {
  const runtime = thread?.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  return nonEmptyString(
    thread?.worktreePath ||
    thread?.repoPath ||
    runtime.worktreePath ||
    runtime.repoPath ||
    runtime.workspace ||
    thread?.cwd ||
    thread?.workspace,
  );
}

export async function detectThreadGitState(threadOrId, env = process.env) {
  const thread = typeof threadOrId === "string" ? await getThread(threadOrId, env) : threadOrId;
  if (!thread) return {};
  const checkout = threadCheckoutPath(thread);
  const repoPath = await resolveGitRoot(checkout).catch(() => null);
  if (!repoPath) return {};
  const branchName = await currentBranch(repoPath);
  const remoteUrl = await repoRemoteUrl(repoPath);
  const remoteBranch = await remoteTrackingBranch(repoPath, branchName);
  const remoteExists = await refExists(repoPath, remoteBranch);
  const aheadBehind = await gitAheadBehind(repoPath, remoteBranch);
  const remoteChangedFiles = await changedFilesAgainst(repoPath, remoteBranch);
  const sourceDirty = await worktreeDirty(repoPath);
  const gitDirtyFiles = await worktreeDirtyFiles(repoPath);
  const comparison = await gitBaseComparison(repoPath, thread, branchName, env);
  const isWorker = Boolean(nonEmptyString(thread?.parentThreadId));
  const gitRemoteAhead = aheadBehind.gitAhead;
  const gitRemoteBehind = aheadBehind.gitBehind;
  const gitAhead = isWorker && Number.isFinite(comparison.gitParentAhead) ? comparison.gitParentAhead : gitRemoteAhead;
  const gitBehind = isWorker && Number.isFinite(comparison.gitParentBehind) ? comparison.gitParentBehind : gitRemoteBehind;
  return {
    repoPath,
    repoRemoteUrl: remoteUrl || null,
    remoteBranch: remoteBranch || null,
    branchName,
    sourceDirty,
    gitDirtyFiles,
    ...comparison,
    gitAhead,
    gitBehind,
    gitRemoteAhead,
    gitRemoteBehind,
    gitRemoteChangedFiles: remoteChangedFiles,
    gitRemoteBranchExists: remoteExists,
    gitRemoteMissing: Boolean(remoteBranch && !remoteExists),
  };
}

export async function detectThreadRepo(threadId, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw httpError("thread_not_found", 404);
  const repoPath = await resolveParentRepo(thread, {});
  const branchName = await currentBranch(repoPath);
  const baseCommit = await git(repoPath, ["rev-parse", "HEAD"]).then((result) => result.stdout).catch(() => "");
  const sourceDirty = await worktreeDirty(repoPath);
  const gitDirtyFiles = await worktreeDirtyFiles(repoPath);
  const remoteUrl = await repoRemoteUrl(repoPath);
  const remoteBranch = await remoteTrackingBranch(repoPath, branchName);
  const aheadBehind = await gitAheadBehind(repoPath, remoteBranch);
  const remoteChangedFiles = await changedFilesAgainst(repoPath, remoteBranch);
  const remoteExists = await refExists(repoPath, remoteBranch);
  return {
    repoPath,
    repoRemoteUrl: remoteUrl || null,
    remoteBranch: remoteBranch || null,
    branchName,
    baseBranch: branchName,
    baseCommit,
    sourceDirty,
    gitDirtyFiles,
    gitBaseAhead: 0,
    gitChangedFiles: gitDirtyFiles,
    gitRemoteAhead: aheadBehind.gitAhead,
    gitRemoteBehind: aheadBehind.gitBehind,
    gitRemoteChangedFiles: remoteChangedFiles,
    gitRemoteBranchExists: remoteExists,
    gitRemoteMissing: Boolean(remoteBranch && !remoteExists),
    ...aheadBehind,
  };
}

function gitStatePatch(state) {
  return {
    repoPath: state.repoPath || null,
    repoRemoteUrl: state.repoRemoteUrl || null,
    remoteBranch: state.remoteBranch || null,
    branchName: state.branchName || null,
    sourceDirty: Boolean(state.sourceDirty),
    gitDirtyFiles: state.gitDirtyFiles,
    gitAhead: state.gitAhead,
    gitBehind: state.gitBehind,
    gitBaseAhead: state.gitBaseAhead,
    gitChangedFiles: state.gitChangedFiles,
    gitParentHead: state.gitParentHead || null,
    gitParentAhead: state.gitParentAhead,
    gitParentBehind: state.gitParentBehind,
    gitParentChangedFiles: state.gitParentChangedFiles,
    gitRemoteAhead: state.gitRemoteAhead,
    gitRemoteBehind: state.gitRemoteBehind,
    gitRemoteChangedFiles: state.gitRemoteChangedFiles,
    gitComparisonBase: state.gitComparisonBase || null,
    gitComparisonLabel: state.gitComparisonLabel || null,
    gitRemoteBranchExists: state.gitRemoteBranchExists,
    gitRemoteMissing: state.gitRemoteMissing,
  };
}

export async function refreshThreadGitState(threadOrId, env = process.env) {
  const thread = typeof threadOrId === "string" ? await getThread(threadOrId, env) : threadOrId;
  if (!thread) throw httpError("thread_not_found", 404);
  const state = await detectThreadGitState(thread, env);
  if (!state?.repoPath) return { thread, gitState: state };
  const updated = await updateThread(thread.id, gitStatePatch(state), env);
  return { thread: updated, gitState: state };
}

export async function syncThreadWorkerWithParent(threadId, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw httpError("thread_not_found", 404);
  if (!nonEmptyString(thread.parentThreadId)) throw httpError("thread_is_not_worker", 400);

  const state = await detectThreadGitState(thread, env);
  const repoPath = await resolveGitRoot(threadCheckoutPath(thread)).catch(() => null);
  if (!repoPath) throw httpError("thread_repo_not_found", 404);

  const dirtyFiles = Number(state.gitDirtyFiles || 0);
  const parentAhead = Number(state.gitParentAhead || 0);
  const parentBehind = Number(state.gitParentBehind || 0);
  const parentHead = nonEmptyString(state.gitParentHead);
  if (!parentHead) throw httpError("parent_repo_not_found", 404);
  if (dirtyFiles > 0) throw httpError("worker_has_local_edits", 409, { dirtyFiles });
  if (parentAhead > 0) throw httpError("worker_has_unmerged_commits", 409, { gitParentAhead: parentAhead });
  if (parentBehind <= 0) {
    const updated = await updateThread(thread.id, gitStatePatch(state), env);
    return { synced: false, reason: "already_synced", thread: updated, gitState: state };
  }

  await git(repoPath, ["merge", "--ff-only", parentHead]);
  const nextState = await detectThreadGitState(thread, env);
  const updated = await updateThread(thread.id, gitStatePatch(nextState), env);
  await appendEvent({
    type: "thread_worker_synced_with_parent",
    threadId: thread.id,
    parentThreadId: thread.parentThreadId,
    parentHead,
    previousBehind: parentBehind,
  }, env);
  return { synced: true, thread: updated, gitState: nextState };
}

export async function updateThreadRepo(threadId, input = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw httpError("thread_not_found", 404);
  const shouldDetect = input.detect === true;
  let repoPath = nonEmptyString(input.repoPath || input.projectRoot || input.cwd);
  let remoteUrl = nonEmptyString(input.repoRemoteUrl || input.remoteUrl || input.gitRemoteUrl);
  let remoteBranch = nonEmptyString(input.remoteBranch || input.gitRemoteBranch || input.upstreamBranch);
  let branchName = nonEmptyString(input.branchName || input.branch || input.baseBranch);
  let baseCommit = nonEmptyString(input.baseCommit);
  let sourceDirty = Boolean(input.sourceDirty);
  let gitAhead = optionalNumber(input.gitAhead);
  let gitBehind = optionalNumber(input.gitBehind);
  let gitRemoteAhead = optionalNumber(input.gitRemoteAhead);
  let gitRemoteBehind = optionalNumber(input.gitRemoteBehind);
  let gitRemoteChangedFiles = optionalNumber(input.gitRemoteChangedFiles);

  if (shouldDetect && !repoPath) {
    const detected = await detectThreadRepo(thread.id, env);
    repoPath = detected.repoPath;
    remoteUrl ||= detected.repoRemoteUrl;
    remoteBranch ||= detected.remoteBranch;
    branchName ||= detected.branchName;
    baseCommit ||= detected.baseCommit;
    sourceDirty = detected.sourceDirty;
    gitAhead ??= detected.gitAhead;
    gitBehind ??= detected.gitBehind;
    gitRemoteAhead ??= detected.gitRemoteAhead;
    gitRemoteBehind ??= detected.gitRemoteBehind;
    gitRemoteChangedFiles ??= detected.gitRemoteChangedFiles;
  }

  if (repoPath) {
    const root = await resolveGitRoot(repoPath);
    if (!root) throw httpError("invalid_repo_path", 400);
    repoPath = root;
    remoteUrl ||= await repoRemoteUrl(repoPath);
    branchName ||= await currentBranch(repoPath);
    remoteBranch ||= await remoteTrackingBranch(repoPath, branchName);
    const aheadBehind = await gitAheadBehind(repoPath, remoteBranch);
    gitAhead = aheadBehind.gitAhead;
    gitBehind = aheadBehind.gitBehind;
    gitRemoteAhead = aheadBehind.gitAhead;
    gitRemoteBehind = aheadBehind.gitBehind;
    gitRemoteChangedFiles = await changedFilesAgainst(repoPath, remoteBranch);
    baseCommit ||= await git(repoPath, ["rev-parse", "HEAD"]).then((result) => result.stdout).catch(() => "");
    sourceDirty = await worktreeDirty(repoPath);
  } else if (!branchName && !remoteUrl && !remoteBranch) {
    repoPath = "";
  }

  const patch = {
    repoPath: repoPath || null,
    repoRemoteUrl: remoteUrl || null,
    remoteBranch: remoteBranch || null,
    branchName: branchName || null,
    baseBranch: branchName || null,
    baseCommit: baseCommit || null,
    gitAhead,
    gitBehind,
    gitRemoteAhead,
    gitRemoteBehind,
    gitRemoteChangedFiles,
    sourceDirty,
  };
  const updated = await updateThread(thread.id, patch, env);
  await appendEvent({
    type: "thread_repo_updated",
    threadId: thread.id,
    repoPath: patch.repoPath,
    repoRemoteUrl: patch.repoRemoteUrl,
    remoteBranch: patch.remoteBranch,
    branchName: patch.branchName,
    gitAhead: patch.gitAhead,
    gitBehind: patch.gitBehind,
  }, env);
  return { thread: updated, repo: patch };
}

function rootThreadId(parent) {
  return nonEmptyString(parent.rootThreadId || parent.parentThreadId || parent.id);
}

function workerTitle(parent, label) {
  return `${threadDisplayName(parent)} / ${label}`;
}

function copyExecutorForWorker(parent, metadataPatch) {
  const parentExecutor = parent.executor && typeof parent.executor === "object" ? parent.executor : {};
  const parentMetadata = parentExecutor.metadata && typeof parentExecutor.metadata === "object" ? parentExecutor.metadata : {};
  return {
    ...parentExecutor,
    codexThreadId: "",
    sessionName: "",
    tmuxTarget: "",
    metadata: {
      ...parentMetadata,
      ...metadataPatch,
      codexThreadId: "",
    },
  };
}

function handoffPrompt(parent, worker, input = {}) {
  const task = nonEmptyString(input.task || input.prompt || input.message);
  const parentName = threadDisplayName(parent);
  const parentCodex = codexThreadId(parent) || "none recorded";
  const dirtyNote = worker.sourceDirty
    ? "\n- The parent checkout had uncommitted changes when this worker was created; only committed git state is present in this worktree."
    : "";
  return [
    `You are an Orkestr worker thread forked from "${parentName}".`,
    "",
    "Worker context:",
    "- Role: worker thread. You are not the parent/root Orkestr thread.",
    `- Parent Orkestr thread: ${parent.id}`,
    `- Parent Codex thread: ${parentCodex}`,
    `- Root Orkestr thread: ${worker.rootThreadId}`,
    `- Repo: ${worker.repoPath}`,
    `- Worktree: ${worker.worktreePath}`,
    `- Branch: ${worker.branchName}`,
    `- Base branch: ${worker.baseBranch}`,
    `- Base commit: ${worker.baseCommit}${dirtyNote}`,
    "",
    "Task:",
    task || "No task was supplied. Wait for parent/root instructions before making changes.",
    "",
    "Rules:",
    "- Work only inside this worker worktree and branch.",
    "- Do not modify the parent checkout.",
    "- Do not merge into, push to, or otherwise mutate main from this worker thread.",
    "- The parent/root Orkestr thread owns integration, merge-to-main, push-to-main, tags, and release actions.",
    "- If asked to merge or push main, report your branch status and tell the parent/root thread to perform the integration.",
    "- Keep commits scoped to this branch.",
    "- Report changed files, verification commands, and any merge notes when done.",
  ].join("\n");
}

async function workerIndexFor(parentId, env = process.env) {
  const threads = await listThreads(env);
  return threads.filter((thread) => thread.parentThreadId === parentId).length + 1;
}

export async function listThreadWorkers(parentThreadId, env = process.env) {
  const parent = await getThread(parentThreadId, env);
  if (!parent) throw httpError("thread_not_found", 404);
  const threads = await listThreads(env);
  return threads
    .filter((thread) => thread.parentThreadId === parent.id)
    .sort((a, b) => Number(a.workerIndex || 0) - Number(b.workerIndex || 0) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

export async function createThreadWorker(parentThreadId, input = {}, env = process.env) {
  const parent = await getThread(parentThreadId, env);
  if (!parent) throw httpError("thread_not_found", 404);
  const task = nonEmptyString(input.task || input.prompt || input.message);

  const repoPath = await resolveParentRepo(parent, input);
  const workerId = nonEmptyString(input.id || input.threadId) || `worker-${safeSegment(parent.id, "parent")}-${randomUUID().slice(0, 8)}`;
  const branchName = workerBranchName(parent, workerId, input);
  await ensureRefAvailable(repoPath, branchName);
  const worktreePath = path.resolve(nonEmptyString(input.worktreePath) || await worktreePathFor(parent, workerId, env));
  if (await pathExists(worktreePath)) throw httpError("worker_worktree_path_exists", 409);

  const baseCommit = await git(repoPath, ["rev-parse", "HEAD"]).then((result) => result.stdout);
  const baseBranch = nonEmptyString(input.baseBranch) || await currentBranch(repoPath);
  const remoteUrl = await repoRemoteUrl(repoPath);
  const sourceDirty = await worktreeDirty(repoPath);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  let worktreeCreated = false;
  try {
    await git(repoPath, ["worktree", "add", "-b", branchName, worktreePath, baseCommit]);
    worktreeCreated = true;
    const remoteBranch = nonEmptyString(input.remoteBranch || input.gitRemoteBranch || input.upstreamBranch) || await remoteTrackingBranch(worktreePath, branchName);
    const remoteExists = await refExists(worktreePath, remoteBranch);
    const remoteAheadBehind = await gitAheadBehind(worktreePath, remoteBranch);
    const workerGitState = {
      gitAhead: 0,
      gitBehind: 0,
      gitBaseAhead: 0,
      gitChangedFiles: 0,
      gitParentHead: baseCommit,
      gitParentAhead: 0,
      gitParentBehind: 0,
      gitParentChangedFiles: 0,
      gitRemoteAhead: remoteAheadBehind.gitAhead,
      gitRemoteBehind: remoteAheadBehind.gitBehind,
      gitRemoteChangedFiles: await changedFilesAgainst(worktreePath, remoteBranch),
      gitRemoteBranchExists: remoteExists,
      gitRemoteMissing: Boolean(remoteBranch && !remoteExists),
    };
    const workerIndex = await workerIndexFor(parent.id, env);
    const workerLabel = nonEmptyString(input.label || input.name || input.workerLabel) || `Worker ${workerIndex}`;
    const rootId = rootThreadId(parent);
    const metadata = {
      parentThreadId: parent.id,
      rootThreadId: rootId,
      workerIndex,
      workerLabel,
      repoPath,
      repoRemoteUrl: remoteUrl || null,
      remoteBranch: remoteBranch || null,
      baseBranch,
      branchName,
      baseCommit,
      ...workerGitState,
      worktreePath,
      sourceDirty,
      forkedFromCodexThreadId: codexThreadId(parent) || null,
    };
    const workerInput = {
      id: workerId,
      ownerUserId: parent.ownerUserId || input.ownerUserId || null,
      name: nonEmptyString(input.displayName || input.threadName) || workerTitle(parent, workerLabel),
      title: nonEmptyString(input.title) || workerTitle(parent, workerLabel),
      bindingName: nonEmptyString(input.bindingName) || `${safeSegment(parent.bindingName || parent.name || parent.id, "thread")}-${safeSegment(workerLabel, "worker")}`,
      state: "sleeping",
      wakePolicy: parent.wakePolicy || "wake-on-message",
      cwd: worktreePath,
      workspace: worktreePath,
      command: parent.command || "",
      runtime: null,
      executor: copyExecutorForWorker(parent, metadata),
      codexMode: null,
      desiredCodexMode: null,
      codexModel: parent.codexModel || parent.executor?.metadata?.codexModel || null,
      codexModelProvider: parent.codexModelProvider || parent.executor?.metadata?.codexModelProvider || null,
      codexReasoningEffort: parent.codexReasoningEffort || parent.executor?.metadata?.codexReasoningEffort || null,
      parentThreadId: parent.id,
      rootThreadId: rootId,
      workerIndex,
      workerLabel,
      workerStatus: "created",
      repoPath,
      repoRemoteUrl: remoteUrl || null,
      remoteBranch: remoteBranch || null,
      baseBranch,
      branchName,
      baseCommit,
      ...workerGitState,
      worktreePath,
      sourceDirty,
      forkedFromCodexThreadId: codexThreadId(parent) || null,
    };
    const prompt = handoffPrompt(parent, workerInput, input);
    workerInput.handoffPrompt = prompt;
    const worker = await createThread(workerInput, env);
    let message = null;
    let updatedWorker = worker;
    if (task) {
      message = await enqueueThreadInput(worker.id, {
        text: prompt,
        source: "orkestr_worker_handoff",
      }, env);
      updatedWorker = await updateThread(worker.id, {
        handoffPrompt: prompt,
        handoffMessageId: message.id,
        workerStatus: "queued",
      }, env);
    }
    await appendEvent({
      type: "thread_worker_created",
      threadId: parent.id,
      workerThreadId: worker.id,
      branchName,
      remoteBranch,
      worktreePath,
      repoPath,
      sourceDirty,
    }, env);
    return { parent, worker: updatedWorker, message, repoPath, worktreePath, branchName, remoteBranch, baseBranch, baseCommit, sourceDirty, ...workerGitState };
  } catch (error) {
    if (worktreeCreated) {
      await git(repoPath, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
    }
    throw error;
  }
}
