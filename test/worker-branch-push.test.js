import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { isProtectedWorkerBranchName, pushWorkerOwnBranch } from "../packages/core/src/worker-branch-push.js";
import { createThreadWorker } from "../packages/core/src/thread-workers.js";
import { createThread, getThread, updateThread } from "../packages/core/src/threads.js";

const execFileAsync = promisify(execFile);

async function createTempGitRepo(prefix = "orkestr-branch-push-repo-") {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "orkestr@example.test"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Orkestr Test"], { cwd: repo });
  await fs.writeFile(path.join(repo, "README.md"), "# test repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
  return repo;
}

async function setUpWorkerWithRemote(t, prefix) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-branch-push-home-${prefix}-`));
  const repo = await createTempGitRepo(`orkestr-branch-push-repo-${prefix}-`);
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-branch-push-remote-${prefix}-`));
  const remote = path.join(remoteDir, "origin.git");
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: repo });
  await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: repo });
  const env = { ORKESTR_HOME: home };
  const parent = await createThread({ id: `branch-push-parent-${prefix}`, name: "Push Parent", cwd: repo }, env);
  const created = await createThreadWorker(parent.id, { label: "Push Worker", autoRun: false }, env);
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(remoteDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { env, repo, remote, worker: created.worker };
}

test("isProtectedWorkerBranchName rejects main, master, base branch, and empty names", () => {
  assert.equal(isProtectedWorkerBranchName("main"), true);
  assert.equal(isProtectedWorkerBranchName("master"), true);
  assert.equal(isProtectedWorkerBranchName("Main"), true);
  assert.equal(isProtectedWorkerBranchName("release/foo", "release/foo"), true);
  assert.equal(isProtectedWorkerBranchName(""), true);
  assert.equal(isProtectedWorkerBranchName("orkestr/worker/abc123", "main"), false);
});

test("pushWorkerOwnBranch pushes a clean worker's own branch and persists remoteBranch", async (t) => {
  const { env, worker } = await setUpWorkerWithRemote(t, "allow");
  await fs.writeFile(path.join(worker.worktreePath, "worker-change.txt"), "hello\n", "utf8");
  await execFileAsync("git", ["add", "worker-change.txt"], { cwd: worker.worktreePath });
  await execFileAsync("git", ["commit", "-m", "worker change"], { cwd: worker.worktreePath });

  const result = await pushWorkerOwnBranch(worker.id, { operatorUserId: "admin" }, env);
  assert.equal(result.pushed, true);
  assert.equal(result.branchName, worker.branchName);
  assert.equal(result.remoteBranch, `origin/${worker.branchName}`);
  assert.equal(result.thread.remoteBranch, `origin/${worker.branchName}`);

  const remoteHead = await execFileAsync("git", ["rev-parse", `origin/${worker.branchName}`], { cwd: worker.worktreePath })
    .then((r) => String(r.stdout).trim());
  const localHead = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worker.worktreePath })
    .then((r) => String(r.stdout).trim());
  assert.equal(remoteHead, localHead);
});

test("pushWorkerOwnBranch rejects a protected branch name", async (t) => {
  const { env, worker } = await setUpWorkerWithRemote(t, "protected");
  await updateThread(worker.id, { branchName: "main" }, env);
  await assert.rejects(
    pushWorkerOwnBranch(worker.id, {}, env),
    /worker_branch_protected/,
  );
});

test("pushWorkerOwnBranch rejects when checkout HEAD does not match the stored branch", async (t) => {
  const { env, worker } = await setUpWorkerWithRemote(t, "mismatch");
  await execFileAsync("git", ["checkout", "-b", "some-other-local-branch"], { cwd: worker.worktreePath });
  await assert.rejects(
    pushWorkerOwnBranch(worker.id, {}, env),
    /worker_branch_head_mismatch/,
  );
});

test("pushWorkerOwnBranch requires the stored remote and rejects a remote mismatch", async (t) => {
  const { env, worker } = await setUpWorkerWithRemote(t, "remote-identity");
  await updateThread(worker.id, { repoRemoteUrl: null }, env);
  await assert.rejects(pushWorkerOwnBranch(worker.id, {}, env), /worker_stored_remote_unknown/);
  await updateThread(worker.id, { repoRemoteUrl: "/different/origin.git" }, env);
  await assert.rejects(pushWorkerOwnBranch(worker.id, {}, env), /worker_remote_mismatch/);
});

test("pushWorkerOwnBranch rejects when the remote has commits the worker does not", async (t) => {
  const { env, worker, remote } = await setUpWorkerWithRemote(t, "divergence");
  // Someone else advances the worker's remote branch out of band, from a
  // separate clone (the worker's own checkout already has that branch
  // checked out in a worktree, so it cannot be checked out again here).
  const outOfBandClone = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-branch-push-oob-"));
  t.after(() => fs.rm(outOfBandClone, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await execFileAsync("git", ["clone", remote, outOfBandClone]);
  await execFileAsync("git", ["checkout", "-b", worker.branchName, "origin/main"], { cwd: outOfBandClone });
  await fs.writeFile(path.join(outOfBandClone, "remote-only.txt"), "remote only\n", "utf8");
  await execFileAsync("git", ["add", "remote-only.txt"], { cwd: outOfBandClone });
  await execFileAsync("git", ["-c", "user.email=other@example.test", "-c", "user.name=Other", "commit", "-m", "remote-only change"], { cwd: outOfBandClone });
  await execFileAsync("git", ["push", "origin", `HEAD:refs/heads/${worker.branchName}`], { cwd: outOfBandClone });

  await fs.writeFile(path.join(worker.worktreePath, "unrelated.txt"), "local only\n", "utf8");
  await execFileAsync("git", ["add", "unrelated.txt"], { cwd: worker.worktreePath });
  await execFileAsync("git", ["commit", "-m", "local only change"], { cwd: worker.worktreePath });

  await assert.rejects(
    pushWorkerOwnBranch(worker.id, {}, env),
    /worker_remote_has_new_commits/,
  );
});

test("pushWorkerOwnBranch rejects a non-worker thread and never force-pushes", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-branch-push-nonworker-"));
  const repo = await createTempGitRepo("orkestr-branch-push-nonworker-repo-");
  const env = { ORKESTR_HOME: home };
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const thread = await createThread({ id: "not-a-worker", name: "Root Thread", cwd: repo, branchName: "main" }, env);
  await assert.rejects(pushWorkerOwnBranch(thread.id, {}, env), /thread_is_not_worker/);
});

test("a root service stages a push without writing into a runtime-user-owned checkout", async (t) => {
  if (process.geteuid?.() !== 0) return t.skip("requires root to exercise privileged staging");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-branch-push-priv-home-"));
  const repo = await createTempGitRepo("orkestr-branch-push-priv-repo-");
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-branch-push-priv-remote-"));
  const remote = path.join(remoteDir, "origin.git");
  const branchName = "orkestr/worker/privileged-staging";
  const env = { ORKESTR_HOME: home };
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(remoteDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: repo });
  await execFileAsync("git", ["push", "origin", "main"], { cwd: repo });
  await execFileAsync("git", ["checkout", "-b", branchName], { cwd: repo });
  await fs.writeFile(path.join(repo, "runtime-user-change.txt"), "runtime owned\n", "utf8");
  await execFileAsync("git", ["add", "runtime-user-change.txt"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "runtime user change"], { cwd: repo });

  const parent = await createThread({
    id: "privileged-staging-parent",
    name: "Privileged staging parent",
    cwd: repo,
    repoPath: repo,
  }, env);
  const worker = await createThread({
    id: "privileged-staging-worker",
    name: "Privileged staging worker",
    parentThreadId: parent.id,
    cwd: repo,
    repoPath: repo,
    worktreePath: repo,
    repoRemoteUrl: remote,
    branchName,
    baseBranch: "main",
  }, env);
  await execFileAsync("chown", ["-R", "65534:65534", repo]);

  const result = await pushWorkerOwnBranch(worker.id, { operatorUserId: "admin" }, env);
  assert.equal(result.pushed, true);
  const remoteHead = await execFileAsync("git", ["--git-dir", remote, "rev-parse", `refs/heads/${branchName}`])
    .then((output) => String(output.stdout).trim());
  const localHead = await execFileAsync("git", ["-c", `safe.directory=${repo}`, "-C", repo, "rev-parse", "HEAD"])
    .then((output) => String(output.stdout).trim());
  assert.equal(remoteHead, localHead);
  assert.equal((await fs.stat(path.join(repo, ".git", "config"))).uid, 65534);
});
