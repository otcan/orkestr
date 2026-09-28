import assert from "node:assert/strict";
import test from "node:test";
import {
  gitOwnerAllowlist,
  gitOwnerExecEnabled,
  ownerGitExecIdentity,
  parsePasswd,
  resolveGitExec,
  runOwnerAwareGit,
  scopedGitExecOptions,
  withGitOwnerScope,
} from "../packages/core/src/git-owner-exec.js";

const users = [
  { name: "orkestr", uid: 1500, gid: 1500, home: "/home/orkestr" },
  { name: "alice", uid: 1600, gid: 1600, home: "/home/alice" },
];

function mismatch(ownerUid) {
  const error = new Error("worker_git_owner_mismatch");
  error.statusCode = 409;
  error.blocker = { reason: "worker_git_owner_mismatch", ownerUid };
  return error;
}

function fakes({ euid = 0, ownerUid = 1500, mixed = false } = {}) {
  const calls = { inspect: 0, assertSameUid: 0, exec: [] };
  return {
    calls,
    deps: {
      geteuid: () => euid,
      realpath: async (target) => target,
      lstat: async () => ({ uid: ownerUid, gid: ownerUid }),
      resolveUser: async (uid) => users.find((user) => user.uid === uid) || null,
      inspect: async () => {
        calls.inspect += 1;
        if (mixed) throw mismatch(0);
        return { ownerUid, ownerGid: ownerUid };
      },
      assertSameUid: async () => {
        calls.assertSameUid += 1;
        if (euid !== ownerUid) throw mismatch(ownerUid);
        return { ownerUid: euid };
      },
      execFile: async (file, args, options) => {
        calls.exec.push({ file, args, options });
        return { stdout: "ok\n", stderr: "" };
      },
    },
  };
}

const baseEnv = { ORKESTR_GIT_OWNER_EXEC: "", ORKESTR_GIT_OWNER_ALLOWLIST: "", ORKESTR_EXECUTOR_RUN_USER: "", ORKESTR_RUN_USER: "" };

test("parsePasswd reads name, uid, gid and home", () => {
  assert.deepEqual(parsePasswd("# comment\norkestr:x:1500:1500:Orkestr:/home/orkestr:/bin/sh\nbroken\n"), [
    { name: "orkestr", uid: 1500, gid: 1500, home: "/home/orkestr" },
  ]);
});

test("allowlist defaults to the executor run user, then run user, then orkestr", () => {
  assert.deepEqual([...gitOwnerAllowlist(baseEnv)], ["orkestr"]);
  assert.deepEqual([...gitOwnerAllowlist({ ...baseEnv, ORKESTR_RUN_USER: "alice" })], ["alice"]);
  assert.deepEqual([...gitOwnerAllowlist({ ...baseEnv, ORKESTR_RUN_USER: "alice", ORKESTR_EXECUTOR_RUN_USER: "orkestr" })], ["orkestr"]);
  assert.deepEqual([...gitOwnerAllowlist({ ...baseEnv, ORKESTR_GIT_OWNER_ALLOWLIST: "alice, orkestr" })], ["alice", "orkestr"]);
  assert.equal(gitOwnerExecEnabled(baseEnv), true);
  assert.equal(gitOwnerExecEnabled({ ...baseEnv, ORKESTR_GIT_OWNER_EXEC: "0" }), false);
});

test("root with a single allowlisted owner runs Git as that owner with owner env", async () => {
  const { deps, calls } = fakes();
  const result = await runOwnerAwareGit("/srv/checkout", ["merge", "--ff-only", "abc"], baseEnv, deps);
  assert.equal(result.executedAsUid, 1500);
  assert.equal(result.stdout, "ok");
  assert.equal(calls.assertSameUid, 0);
  const [{ file, args, options }] = calls.exec;
  assert.equal(file, "git");
  assert.deepEqual(args, ["-C", "/srv/checkout", "merge", "--ff-only", "abc"]);
  assert.equal(options.uid, 1500);
  assert.equal(options.gid, 1500);
  assert.equal(options.env.HOME, "/home/orkestr");
  assert.equal(options.env.USER, "orkestr");
  assert.equal(options.env.LOGNAME, "orkestr");
  assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(options.env.GIT_OPTIONAL_LOCKS, "0");
});

test("owner outside the allowlist keeps the existing mismatch error", async () => {
  const { deps, calls } = fakes({ ownerUid: 1600 });
  assert.equal(await ownerGitExecIdentity("/srv/checkout", baseEnv, deps), null);
  await assert.rejects(runOwnerAwareGit("/srv/checkout", ["merge"], baseEnv, deps), {
    message: "worker_git_owner_mismatch",
    statusCode: 409,
  });
  assert.equal(calls.inspect, 0);
  assert.equal(calls.exec.length, 0);
});

test("mixed-owner metadata fails closed even for an allowlisted owner", async () => {
  const { deps, calls } = fakes({ mixed: true });
  await assert.rejects(runOwnerAwareGit("/srv/checkout", ["merge"], baseEnv, deps), { message: "worker_git_owner_mismatch" });
  assert.equal(calls.exec.length, 0);
});

test("root-owned checkouts never use the owner path", async () => {
  const { deps } = fakes({ ownerUid: 0 });
  assert.equal(await ownerGitExecIdentity("/srv/checkout", { ...baseEnv, ORKESTR_GIT_OWNER_ALLOWLIST: "root" }, deps), null);
});

test("kill switch restores same-uid behaviour", async () => {
  const { deps, calls } = fakes();
  const env = { ...baseEnv, ORKESTR_GIT_OWNER_EXEC: "0" };
  assert.equal(await ownerGitExecIdentity("/srv/checkout", env, deps), null);
  await assert.rejects(resolveGitExec("/srv/checkout", env, deps), { message: "worker_git_owner_mismatch" });
  assert.equal(calls.inspect, 0);
});

test("non-root services keep same-uid execution", async () => {
  const { deps, calls } = fakes({ euid: 1500, ownerUid: 1500 });
  const result = await runOwnerAwareGit("/srv/checkout", ["status"], baseEnv, deps);
  assert.equal(result.executedAsUid, 1500);
  assert.equal(calls.inspect, 0);
  assert.equal(calls.assertSameUid, 1);
  assert.equal(calls.exec[0].options.uid, undefined);
});

test("state-refresh scope caches owner options and falls back on inspection failure", async () => {
  const owned = fakes();
  const options = await withGitOwnerScope(baseEnv, async () => {
    const first = await scopedGitExecOptions("/srv/checkout");
    await scopedGitExecOptions("/srv/checkout");
    return first;
  }, owned.deps);
  assert.equal(options.uid, 1500);
  assert.equal(owned.calls.inspect, 1);
  const mixed = fakes({ mixed: true });
  assert.deepEqual(await withGitOwnerScope(baseEnv, () => scopedGitExecOptions("/srv/checkout"), mixed.deps), {});
  assert.deepEqual(await scopedGitExecOptions("/srv/checkout"), {});
});
