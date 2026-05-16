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
  return [
    input.repoPath,
    input.projectRoot,
    input.cwd,
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
  ].map(nonEmptyString).filter(Boolean);
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
  return await git(repoPath, ["rev-parse", "--short", "HEAD"]).then((result) => result.stdout).catch(() => "detached");
}

async function worktreeDirty(repoPath) {
  const status = await git(repoPath, ["status", "--porcelain"]).then((result) => result.stdout).catch(() => "");
  return Boolean(status.trim());
}

async function repoRemoteUrl(repoPath) {
  return await git(repoPath, ["config", "--get", "remote.origin.url"]).then((result) => result.stdout).catch(() => "");
}

export async function detectThreadRepo(threadId, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw httpError("thread_not_found", 404);
  const repoPath = await resolveParentRepo(thread, {});
  const branchName = await currentBranch(repoPath);
  const baseCommit = await git(repoPath, ["rev-parse", "HEAD"]).then((result) => result.stdout).catch(() => "");
  const sourceDirty = await worktreeDirty(repoPath);
  const remoteUrl = await repoRemoteUrl(repoPath);
  return { repoPath, repoRemoteUrl: remoteUrl || null, branchName, baseBranch: branchName, baseCommit, sourceDirty };
}

export async function updateThreadRepo(threadId, input = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw httpError("thread_not_found", 404);
  const shouldDetect = input.detect === true;
  let repoPath = nonEmptyString(input.repoPath || input.projectRoot || input.cwd);
  let remoteUrl = nonEmptyString(input.repoRemoteUrl || input.remoteUrl || input.gitRemoteUrl);
  let branchName = nonEmptyString(input.branchName || input.branch || input.baseBranch);
  let baseCommit = nonEmptyString(input.baseCommit);
  let sourceDirty = Boolean(input.sourceDirty);

  if (shouldDetect && !repoPath) {
    const detected = await detectThreadRepo(thread.id, env);
    repoPath = detected.repoPath;
    remoteUrl ||= detected.repoRemoteUrl;
    branchName ||= detected.branchName;
    baseCommit ||= detected.baseCommit;
    sourceDirty = detected.sourceDirty;
  }

  if (repoPath) {
    const root = await resolveGitRoot(repoPath);
    if (!root) throw httpError("invalid_repo_path", 400);
    repoPath = root;
    remoteUrl ||= await repoRemoteUrl(repoPath);
    branchName ||= await currentBranch(repoPath);
    baseCommit ||= await git(repoPath, ["rev-parse", "HEAD"]).then((result) => result.stdout).catch(() => "");
    sourceDirty = await worktreeDirty(repoPath);
  } else if (!branchName && !remoteUrl) {
    repoPath = "";
  }

  const patch = {
    repoPath: repoPath || null,
    repoRemoteUrl: remoteUrl || null,
    branchName: branchName || null,
    baseBranch: branchName || null,
    baseCommit: baseCommit || null,
    sourceDirty,
  };
  const updated = await updateThread(thread.id, patch, env);
  await appendEvent({ type: "thread_repo_updated", threadId: thread.id, repoPath: patch.repoPath, repoRemoteUrl: patch.repoRemoteUrl, branchName: patch.branchName }, env);
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
    task,
    "",
    "Rules:",
    "- Work only inside this worker worktree and branch.",
    "- Do not modify the parent checkout.",
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
  if (!task) throw httpError("worker_task_required", 400);

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
      baseBranch,
      branchName,
      baseCommit,
      worktreePath,
      sourceDirty,
      forkedFromCodexThreadId: codexThreadId(parent) || null,
    };
    const workerInput = {
      id: workerId,
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
      codexMode: parent.codexMode || parent.desiredCodexMode || null,
      desiredCodexMode: parent.desiredCodexMode || parent.codexMode || null,
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
      baseBranch,
      branchName,
      baseCommit,
      worktreePath,
      sourceDirty,
      forkedFromCodexThreadId: codexThreadId(parent) || null,
    };
    const worker = await createThread(workerInput, env);
    const prompt = handoffPrompt(parent, worker, input);
    const message = await enqueueThreadInput(worker.id, {
      text: prompt,
      source: "orkestr_worker_handoff",
    }, env);
    const updatedWorker = await updateThread(worker.id, {
      handoffPrompt: prompt,
      handoffMessageId: message.id,
      workerStatus: "queued",
    }, env);
    await appendEvent({
      type: "thread_worker_created",
      threadId: parent.id,
      workerThreadId: worker.id,
      branchName,
      worktreePath,
      repoPath,
      sourceDirty,
    }, env);
    return { parent, worker: updatedWorker, message, repoPath, worktreePath, branchName, baseBranch, baseCommit, sourceDirty };
  } catch (error) {
    if (worktreeCreated) {
      await git(repoPath, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
    }
    throw error;
  }
}
