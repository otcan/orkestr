import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { assertWorkerGitOwnership } from "../packages/core/src/worker-git-ownership.js";
import { createThread } from "../packages/core/src/threads.js";
import { detectThreadGitState, syncSafeThreadWorkersWithParents, syncThreadWorkerWithParent } from "../packages/core/src/thread-workers.js";

const exec = promisify(execFile);
const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
const rootOnly = { skip: process.geteuid?.() !== 0 };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-owner-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const git = async (cwd, args, options = {}) => (await exec("git", ["-C", cwd, "-c", "user.name=Example",
    "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", ...args],
  { env: gitEnv, ...options })).stdout.trim();
  await fs.mkdir(repo);
  await git(repo, ["init", "--template=", "-b", "main"]);
  await fs.writeFile(path.join(repo, "fixture.txt"), "initial\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  const base = await git(repo, ["rev-parse", "HEAD"]);
  return { root, repo, git, base };
}

async function threads(fixture, checkout) {
  const env = { ORKESTR_HOME: path.join(fixture.root, "state"), ORKESTR_BROWSER_LAUNCH_DISABLED: "1" };
  const parent = await createThread({ id: "example-parent", cwd: fixture.repo }, env);
  const worker = await createThread({ id: "example-worker", parentThreadId: parent.id,
    cwd: checkout, worktreePath: checkout, branchName: "worker", ownerUserId: "application-owner-is-not-an-os-user" }, env);
  return { env, worker };
}
async function advance({ repo, git }) {
  await fs.writeFile(path.join(repo, "fixture.txt"), "advanced\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "advance"]);
  return git(repo, ["rev-parse", "HEAD"]);
}
async function snapshot(target) {
  const stat = await fs.lstat(target);
  return { uid: stat.uid, gid: stat.gid, mode: stat.mode, ino: stat.ino, content: await fs.readFile(target, "hex") };
}

test("same-owner linked worktree still fast-forwards through release synchronization", async t => {
  const f = await fixture(t);
  const checkout = path.join(f.root, "worker");
  await f.git(f.repo, ["worktree", "add", "-b", "worker", checkout]);
  const { env, worker } = await threads(f, checkout);
  const head = await advance(f);
  const summary = await syncSafeThreadWorkersWithParents({ push: false, includeActive: true }, env);
  assert.equal(summary.ok, true);
  assert.equal(summary.blocked, 0);
  assert.equal(summary.synced, 1);
  assert.equal(await f.git(checkout, ["rev-parse", "HEAD"]), head);
  assert.equal((await syncThreadWorkerWithParent(worker.id, env)).reason, "already_synced");
});

test("same-owner standalone checkout still fast-forwards directly", async t => {
  const f = await fixture(t);
  const checkout = path.join(f.root, "worker");
  await f.git(f.repo, ["clone", "--no-hardlinks", f.repo, checkout]);
  await f.git(checkout, ["checkout", "-b", "worker"]);
  const { env, worker } = await threads(f, checkout);
  const head = await advance(f);
  await f.git(checkout, ["fetch", "origin"]);
  assert.equal((await syncThreadWorkerWithParent(worker.id, env)).synced, true);
  assert.equal(await f.git(checkout, ["rev-parse", "HEAD"]), head);
});

test("read-only Git state inspection does not refresh the checkout index", async t => {
  const f = await fixture(t);
  const index = path.join(f.repo, ".git", "index");
  const before = await snapshot(index);
  await fs.utimes(path.join(f.repo, "fixture.txt"), new Date("2000-01-01"), new Date("2000-01-01"));
  const state = await detectThreadGitState({ repoPath: f.repo }, { ORKESTR_HOME: path.join(f.root, "state") });
  assert.equal(state.gitDirtyFiles, 0);
  assert.deepEqual(await snapshot(index), before);
});

test("root skips a foreign-owned standalone checkout without replacing owner index or refs", rootOnly, async t => {
  const f = await fixture(t);
  // Numeric UID is confined to this fixture; no account lookup or app-owner mapping.
  const identity = { uid: 65534, gid: 65534 };
  await fs.chmod(f.root, 0o755);
  const checkout = path.join(f.root, "worker");
  await fs.mkdir(checkout);
  await fs.chown(checkout, identity.uid, identity.gid);
  await f.git(checkout, ["init", "--template=", "-b", "worker"], identity);
  const bundle = path.join(f.root, "fixture.bundle");
  await f.git(f.repo, ["bundle", "create", bundle, "--all"]);
  await fs.chmod(bundle, 0o644);
  await f.git(checkout, ["fetch", bundle, "main"], identity);
  await f.git(checkout, ["reset", "--hard", "FETCH_HEAD"], identity);
  const { env, worker } = await threads(f, checkout);
  await advance(f);
  await f.git(f.repo, ["bundle", "create", bundle, "--all"]);
  await fs.chmod(bundle, 0o644);
  await f.git(checkout, ["fetch", bundle, "main"], identity);
  const targets = ["index", "refs/heads/worker"].map(name => path.join(checkout, ".git", name));
  const before = await Promise.all(targets.map(snapshot));
  const summary = await syncSafeThreadWorkersWithParents({ push: false, includeActive: true }, env);
  assert.equal(summary.ok, false);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.synced, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.results[0].reason, "worker_git_owner_mismatch");
  assert.deepEqual(summary.results[0].blocker, { reason: "worker_git_owner_mismatch", checkout,
    effectiveUid: 0, path: checkout, role: "checkout", ownerUid: identity.uid });
  await assert.rejects(syncThreadWorkerWithParent(worker.id, env), { message: "worker_git_owner_mismatch", statusCode: 409 });
  assert.deepEqual(await Promise.all(targets.map(snapshot)), before);
  assert.equal(await f.git(checkout, ["rev-parse", "HEAD"], identity), f.base);
  assert.equal(await f.git(checkout, ["status", "--porcelain"], identity), "");
});

for (const target of [".git", ".git/index", ".git/refs/heads/main"]) {
  test(`mixed ownership at ${target} fails closed`, rootOnly, async t => {
    const f = await fixture(t);
    await fs.chown(path.join(f.repo, target), 65534, 65534);
    await assert.rejects(assertWorkerGitOwnership(f.repo), error => {
      // Git itself may deny discovery of a foreign .git; both cases block writes.
      assert.match(error.message, /^worker_git_(owner_mismatch|ownership_unavailable)$/);
      assert.equal(error.statusCode, 409);
      if (error.message === "worker_git_owner_mismatch") assert.equal(error.blocker.path, path.join(f.repo, target));
      return true;
    });
  });
}

test("linked worktree cannot mutate a foreign-owned common Git directory", rootOnly, async t => {
  const f = await fixture(t);
  const checkout = path.join(f.root, "worker");
  await f.git(f.repo, ["worktree", "add", "-b", "worker", checkout]);
  await fs.chown(path.join(f.repo, ".git"), 65534, 65534);
  await assert.rejects(assertWorkerGitOwnership(checkout), /worker_git_owner_mismatch|worker_git_ownership_unavailable/);
});

test("missing ownership evidence is reported as a blocker rather than already synced", async t => {
  const f = await fixture(t);
  const checkout = path.join(f.root, "missing");
  const { env } = await threads(f, checkout);
  const summary = await syncSafeThreadWorkersWithParents({ push: false, includeActive: true }, env);
  assert.equal(summary.ok, false);
  assert.equal(summary.results[0].reason, "worker_git_ownership_unavailable");
  assert.equal(summary.results[0].blocker.detail, "ENOENT");
});
