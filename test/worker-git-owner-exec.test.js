import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createPasswdResolver, gitOwnerAllowlist } from "../packages/core/src/git-owner-exec.js";
import { createThread } from "../packages/core/src/threads.js";
import { createThreadWorker, detectThreadGitState, syncSafeThreadWorkersWithParents } from "../packages/core/src/thread-workers.js";
import { pushWorkerOwnBranch } from "../packages/core/src/worker-branch-push.js";

const exec = promisify(execFile);

// Finds a real non-root allowlisted account so the fixture can be chowned to it.
async function allowlistedOwner() {
  if (process.geteuid?.() !== 0) return null;
  const resolve = createPasswdResolver();
  const text = await fs.readFile("/etc/passwd", "utf8").catch(() => "");
  const names = gitOwnerAllowlist(process.env);
  for (const line of text.split("\n")) {
    const [name, , uid] = line.split(":");
    if (names.has(name) && Number(uid) > 0) return resolve(Number(uid));
  }
  return null;
}

const owner = await allowlistedOwner();
const skip = owner ? false : "requires root and a non-root allowlisted account";

async function ownerFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-owner-exec-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o755);
  const identity = { uid: owner.uid, gid: owner.gid };
  const gitEnv = { PATH: process.env.PATH, HOME: owner.home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = async (cwd, args) => (await exec("git", ["-C", cwd, "-c", "user.name=Example",
    "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", ...args],
  { env: gitEnv, cwd: root, ...identity })).stdout.trim();
  const repo = path.join(root, "repo");
  const checkout = path.join(root, "worker");
  await fs.mkdir(repo);
  await fs.chown(root, owner.uid, owner.gid);
  await fs.chown(repo, owner.uid, owner.gid);
  await git(repo, ["init", "--template=", "-b", "main"]);
  await fs.writeFile(path.join(repo, "fixture.txt"), "initial\n");
  await fs.chown(path.join(repo, "fixture.txt"), owner.uid, owner.gid);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "worker", checkout]);
  await git(repo, ["commit", "--allow-empty", "-m", "advance"]);
  const head = await git(repo, ["rev-parse", "HEAD"]);

  const env = { ORKESTR_HOME: path.join(root, "state"), ORKESTR_BROWSER_LAUNCH_DISABLED: "1" };
  return { root, repo, checkout, git, head, env };
}

test("root syncs an allowlisted owner's worktree as that owner and keeps refs owner-owned", { skip }, async t => {
  const { repo, checkout, git, head, env } = await ownerFixture(t);
  const parent = await createThread({ id: "example-parent", cwd: repo }, env);
  const worker = await createThread({ id: "example-worker", parentThreadId: parent.id,
    cwd: checkout, worktreePath: checkout, branchName: "worker" }, env);

  const before = await detectThreadGitState(worker, env);
  assert.equal(before.gitParentBehind, 1);
  assert.equal(before.gitDirtyFiles, 0);

  const summary = await syncSafeThreadWorkersWithParents({ push: false, includeActive: true }, env);
  assert.equal(summary.ok, true);
  assert.equal(summary.synced, 1);
  assert.equal(summary.results[0].executedAsUid, owner.uid);
  assert.equal(await git(checkout, ["rev-parse", "HEAD"]), head);

  const commonDir = path.join(repo, ".git");
  const worktreeGitDir = path.join(commonDir, "worktrees", "worker");
  for (const target of [
    path.join(commonDir, "refs", "heads", "worker"),
    path.join(commonDir, "logs", "refs", "heads", "worker"),
    path.join(worktreeGitDir, "index"),
    path.join(worktreeGitDir, "HEAD"),
  ]) {
    assert.equal((await fs.lstat(target)).uid, owner.uid, target);
  }

  await fs.writeFile(path.join(checkout, "local-edit.txt"), "edit\n");
  await fs.chown(path.join(checkout, "local-edit.txt"), owner.uid, owner.gid);
  const after = await detectThreadGitState(worker, env);
  assert.equal(after.gitDirtyFiles, 1);
  assert.equal(after.gitParentBehind, 0);
});

test("root pushes an allowlisted owner's worker branch as that owner", { skip }, async t => {
  const { root, repo, checkout, git, env } = await ownerFixture(t);
  const remote = path.join(root, "origin.git");
  await git(root, ["init", "--bare", "--template=", remote]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(checkout, ["commit", "--allow-empty", "-m", "worker change"]);
  const parent = await createThread({ id: "example-parent", cwd: repo }, env);
  const worker = await createThread({ id: "example-worker", parentThreadId: parent.id, cwd: checkout,
    worktreePath: checkout, branchName: "worker", baseBranch: "main", repoRemoteUrl: remote }, env);
  const result = await pushWorkerOwnBranch(worker.id, {}, env);
  assert.equal(result.pushed, true);
  assert.equal(result.executedAsUid, owner.uid);
  assert.equal(await git(remote, ["rev-parse", "refs/heads/worker"]), await git(checkout, ["rev-parse", "HEAD"]));
  assert.equal((await fs.lstat(path.join(remote, "refs", "heads", "worker"))).uid, owner.uid);
  assert.equal((await fs.lstat(path.join(repo, ".git", "config"))).uid, owner.uid);
  assert.equal((await fs.lstat(path.join(repo, ".git", "refs", "remotes", "origin", "worker"))).uid, owner.uid);
});

test("root creates a worker from an allowlisted owner's checkout as that owner", { skip }, async t => {
  const { root, repo, env } = await ownerFixture(t);
  const parent = await createThread({ id: "example-parent", cwd: repo }, env);
  const worktreePath = path.join(root, "worktrees", "example-parent", "new-worker");
  const result = await createThreadWorker(parent.id, { id: "example-worker", worktreePath, autoRun: false }, { ...env, HOME: "/nonexistent" });
  assert.equal(result.worker.worktreePath || result.worker.cwd, worktreePath);
  for (const entry of [worktreePath, path.dirname(worktreePath), path.join(root, "worktrees")]) {
    assert.equal((await fs.stat(entry)).uid, owner.uid, entry);
  }
  const refs = await fs.readdir(path.join(repo, ".git", "refs", "heads"));
  assert.ok(refs.length >= 2);
  for (const ref of refs) assert.equal((await fs.stat(path.join(repo, ".git", "refs", "heads", ref))).uid, owner.uid);
});
