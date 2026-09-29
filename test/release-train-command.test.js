import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { releaseTrainCommand } from "../apps/cli/src/release-train-command.js";
import { dirtyEntries, parseWorktreeList } from "../apps/cli/src/release-train-branches.js";
import { readShaRecord, writeShaRecord } from "../apps/cli/src/release-train-support.js";

const SHA = "1".repeat(40);
const REPO = "/work/example-repo";

function io() {
  const stdout = { text: "", write(chunk) { this.text += chunk; } };
  const stderr = { text: "", write(chunk) { this.text += chunk; } };
  return { stdout, stderr };
}

function stateEnv(extra = {}) {
  return { ORKESTR_RELEASE_TRAIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "orkestr-rt-state-")), ORKESTR_RELEASE_TRAIN_TEST_TMPDIR: "/tmp", ...extra };
}

// Fake runner for git/npm/node: records calls, answers git plumbing, and
// fails the step named in `failOn`.
function fakeExec({ failOn = "", onOrigin = true } = {}) {
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    const joined = args.join(" ");
    if (command === "git") {
      if (joined.includes("rev-parse --show-toplevel")) return { code: 0, stdout: `${REPO}\n`, stderr: "" };
      if (joined.includes("rev-parse --verify --quiet origin/main^{commit}")) return { code: 0, stdout: `${SHA}\n`, stderr: "" };
      if (joined.includes("remote get-url origin")) return { code: 0, stdout: "https://github.com/example-org/example-repo.git\n", stderr: "" };
      if (joined.includes("branch -r --contains")) return { code: 0, stdout: onOrigin ? "  origin/main\n" : "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }
    if (failOn && joined.includes(failOn)) return { code: 1, stdout: "", stderr: `${failOn} exploded` };
    const report = args.indexOf("--report");
    if (report >= 0) fs.writeFileSync(args[report + 1], JSON.stringify({ status: "passed", counts: { blocking: 0 } }));
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("check builds and tests the exact sha in a throwaway worktree and records the result", async () => {
  const env = stateEnv({ ORKESTR_HOME: "/should/not/leak", GITHUB_TOKEN: "t" });
  const { exec, calls } = fakeExec();
  const { stdout, stderr } = io();
  const code = await releaseTrainCommand(["check", "--ref", "main", "--json"], { env, stdout, stderr, cwd: REPO }, { exec });
  assert.equal(code, 0, stderr.text);
  const add = calls.find((call) => call.args.includes("worktree") && call.args.includes("add"));
  assert.deepEqual(add.args.slice(-4), ["add", "--detach", add.args.at(-2), SHA]);
  const worktree = add.args.at(-2);
  assert.ok(worktree.startsWith(os.tmpdir()));
  const steps = calls.filter((call) => call.command !== "git");
  assert.deepEqual(steps.map((call) => [call.command, ...call.args].slice(0, 3).join(" ")), [
    "npm ci --ignore-scripts", "node scripts/patch-whatsapp-media-id.mjs", "npm run build", "npm run launcher:build", "npm run test:ci",
    `node ${path.join(worktree, "scripts/security/dependency-advisories.mjs")} --root`,
  ]);
  assert.ok(steps.every((call) => call.cwd === worktree));
  assert.equal(steps.find((call) => call.args.includes("test:ci")).env.TMPDIR, "/tmp");
  assert.ok(steps.every((call) => call.env.ORKESTR_HOME === undefined && call.env.GITHUB_TOKEN === undefined));
  const scan = steps.at(-1).args;
  assert.deepEqual(scan.slice(1, 7), ["--root", worktree, "--commit", SHA, "--policy-commit", SHA]);
  assert.ok(calls.some((call) => call.args.join(" ").includes(`worktree remove --force ${worktree}`)));
  assert.equal(fs.existsSync(path.dirname(worktree)), false);
  const record = readShaRecord(env.ORKESTR_RELEASE_TRAIN_STATE_DIR, SHA);
  assert.equal(record.check.ok, true);
  assert.equal(record.check.dependencyAdvisories.status, "passed");
  assert.equal(JSON.parse(stdout.text).ok, true);
});

test("check stops at the first failing step and records the failure", async () => {
  const env = stateEnv();
  const { exec, calls } = fakeExec({ failOn: "run build" });
  const { stdout, stderr } = io();
  assert.equal(await releaseTrainCommand(["check"], { env, stdout, stderr, cwd: REPO }, { exec }), 1);
  assert.match(stdout.text, /FAILED .* at step "build"/);
  assert.equal(calls.some((call) => call.args.includes("test:ci")), false);
  assert.ok(calls.some((call) => call.args.includes("remove")));
  assert.equal(readShaRecord(env.ORKESTR_RELEASE_TRAIN_STATE_DIR, SHA).check.failedStep, "build");
});

test("ci waits for pending checks and records the verified run", async () => {
  const env = stateEnv({ ORKESTR_RELEASE_TRAIN_POLL_MS: "1" });
  const { exec } = fakeExec();
  const responses = [
    { ok: false, status: "pending", reasons: ["required_checks_pending"], pending: ["smoke"], missing: [], failed: [], checks: [] },
    { ok: true, status: "passed", reasons: [], pending: [], missing: [], failed: [], checks: [{ name: "build", status: "completed", conclusion: "success" }], runId: "900", runUrl: "https://github.com/example-org/example-repo/actions/runs/900" },
  ];
  const seen = [];
  const verifyRequiredChecks = async (options) => { seen.push(options); return responses.shift(); };
  const { stdout, stderr } = io();
  const code = await releaseTrainCommand(["ci", "--sha", SHA, "--wait"], { env, stdout, stderr, cwd: REPO }, { exec, verifyRequiredChecks, sleep: async () => {} });
  assert.equal(code, 0, stderr.text);
  assert.equal(seen.length, 2);
  assert.deepEqual([seen[0].owner, seen[0].repo, seen[0].sha], ["example-org", "example-repo", SHA]);
  assert.match(stdout.text, /CI passed/);
  assert.equal(readShaRecord(env.ORKESTR_RELEASE_TRAIN_STATE_DIR, SHA).ci.runId, "900");

  const failing = async () => ({ ok: false, status: "failed", reasons: ["required_checks_failed"], failed: [{ name: "build", conclusion: "failure" }], pending: [], missing: [], checks: [] });
  assert.equal(await releaseTrainCommand(["ci", "--sha", SHA, "--wait"], { env, ...io(), cwd: REPO }, { exec, verifyRequiredChecks: failing, sleep: async () => { throw new Error("must not wait on failure"); } }), 1);
  assert.equal(readShaRecord(env.ORKESTR_RELEASE_TRAIN_STATE_DIR, SHA).ci.ok, false);
});

function deployDeps(overrides = {}) {
  const launches = [];
  return {
    launches,
    deps: {
      activeDeployUnits: () => [],
      requestJson: async () => ({ threads: [] }),
      launchDetachedDeploy: async (options) => { launches.push(options); return 0; },
      updateScriptPath: (name) => `/app/scripts/${name}`,
      systemdRunEnvArgs: () => ["--setenv=ORKESTR_UPDATE_SYSTEMD_RUN=0"],
      ...overrides,
    },
  };
}

test("deploy refuses without recorded check and CI success", async () => {
  const env = stateEnv();
  const { deps, launches } = deployDeps();
  const { stdout } = io();
  assert.equal(await releaseTrainCommand(["deploy", "--sha", SHA], { env, stdout, stderr: io().stderr }, deps), 1);
  assert.match(stdout.text, /no recorded passing release check/);
  assert.match(stdout.text, /no recorded green CI/);
  assert.equal(launches.length, 0);
});

test("deploy refuses while a deploy unit or unsafe active thread exists, and launches the detached deploy otherwise", async () => {
  const env = stateEnv();
  writeShaRecord(env.ORKESTR_RELEASE_TRAIN_STATE_DIR, SHA, { check: { ok: true }, ci: { ok: true } });
  const busy = deployDeps({ activeDeployUnits: () => ["orkestr-deploy-x"] });
  assert.equal(await releaseTrainCommand(["deploy", "--sha", SHA], { env, ...io() }, busy.deps), 75);
  assert.equal(busy.launches.length, 0);

  const threads = { threads: [
    { id: "self", name: "release thread", working: true, runtime: "codex" },
    { id: "other", name: "busy worker", working: true, runtime: "tmux" },
    { id: "safe", name: "safe codex", working: true, runtimeKind: "codex-app-server", codexAppServerTransport: "proxy" },
  ] };
  const unsafe = deployDeps({ requestJson: async () => threads });
  const out = io();
  assert.equal(await releaseTrainCommand(["deploy", "--sha", SHA, "--thread", "self"], { env, ...out }, unsafe.deps), 1);
  assert.match(out.stdout.text, /not restart-safe: busy worker/);
  assert.doesNotMatch(out.stdout.text, /release thread|safe codex/);

  const unavailable = deployDeps({ requestJson: async () => { throw new Error("connect ECONNREFUSED"); } });
  assert.equal(await releaseTrainCommand(["deploy", "--sha", SHA], { env, ...io() }, unavailable.deps), 1);
  assert.equal(unavailable.launches.length, 0);

  const ok = deployDeps({ requestJson: async () => ({ threads: threads.threads.filter((thread) => thread.id !== "other") }) });
  assert.equal(await releaseTrainCommand(["deploy", "--sha", SHA, "--thread", "self"], { env, ...io() }, ok.deps), 0);
  const launch = ok.launches[0];
  assert.deepEqual(launch.deployArgs, ["install", "--ref", SHA, "--channel", "main", "--allow-untagged", "--all-instances", "--wait-active"]);
  assert.equal(launch.script, "/app/scripts/deploy-git-release.sh");
  assert.deepEqual(launch.argv, ["--thread", "self"]);
  assert.equal(launch.env.ORKESTR_DEPLOY_REF, SHA);
  assert.equal(readShaRecord(env.ORKESTR_RELEASE_TRAIN_STATE_DIR, SHA).deploy.launched, true);
});

test("run stops when the ref is not on origin and otherwise chains check, ci and deploy", async () => {
  const env = stateEnv({ ORKESTR_RELEASE_TRAIN_POLL_MS: "1" });
  const notPushed = fakeExec({ onOrigin: false });
  const out = io();
  assert.equal(await releaseTrainCommand(["run", "--ref", "main"], { env, ...out, cwd: REPO }, { exec: notPushed.exec, ...deployDeps().deps }), 1);
  assert.match(out.stdout.text, /stopped at origin[\s\S]*never pushes/);
  assert.equal(notPushed.calls.some((call) => call.command === "npm"), false);
  assert.equal(notPushed.calls.some((call) => call.args.includes("push")), false);

  const failing = fakeExec({ failOn: "test:ci" });
  const stopOut = io();
  const stopDeps = deployDeps();
  assert.equal(await releaseTrainCommand(["run"], { env, ...stopOut, cwd: REPO }, { exec: failing.exec, ...stopDeps.deps, verifyRequiredChecks: async () => { throw new Error("ci must not run"); } }), 1);
  assert.match(stopOut.stdout.text, /stopped at check/);
  assert.equal(stopDeps.launches.length, 0);

  const good = fakeExec();
  const { deps, launches } = deployDeps();
  const verifyRequiredChecks = async () => ({ ok: true, status: "passed", reasons: [], checks: [], pending: [], missing: [], failed: [], runUrl: "https://github.com/example-org/example-repo/actions/runs/1" });
  const goodOut = io();
  assert.equal(await releaseTrainCommand(["run", "--ref", "main", "--json"], { env, ...goodOut, cwd: REPO }, { exec: good.exec, ...deps, verifyRequiredChecks }), 0, goodOut.stderr.text);
  assert.deepEqual(JSON.parse(goodOut.stdout.text).stages.map((stage) => stage.stage), ["check", "ci", "deploy"]);
  assert.equal(launches.length, 1);
});

test("worktree parsing and dirty detection ignore an untracked node_modules entry", () => {
  const rows = parseWorktreeList("worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\ndetached\n");
  assert.deepEqual(rows.map((row) => [row.path, row.branch, row.detached]), [["/a", "main", false], ["/b", "", true]]);
  assert.deepEqual(dirtyEntries("?? node_modules/\n"), []);
  assert.deepEqual(dirtyEntries("?? node_modules\n M src/a.js\n?? notes.txt\n"), [" M src/a.js", "?? notes.txt"]);
});

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("sync-branches fast-forwards clean ancestor worktrees, pushes once, and reports dirty and diverged ones", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orkestr-rt-sync-"));
  const origin = path.join(root, "origin.git");
  const main = path.join(root, "main");
  git(root, "init", "--bare", "--quiet", origin);
  git(root, "clone", "--quiet", origin, main);
  fs.writeFileSync(path.join(main, "a.txt"), "1\n");
  git(main, "add", "a.txt");
  git(main, "commit", "--quiet", "-m", "base");
  git(main, "push", "--quiet", "origin", "HEAD:main");
  for (const branch of ["w-behind", "w-dirty", "w-modules", "w-diverged", "w-local"]) {
    git(main, "worktree", "add", "--quiet", "-b", branch, path.join(root, branch));
  }
  git(main, "push", "--quiet", "origin", "w-behind", "w-dirty", "w-modules", "w-diverged");
  git(main, "fetch", "--quiet", "origin");
  fs.writeFileSync(path.join(main, "a.txt"), "2\n");
  git(main, "commit", "--quiet", "-am", "release");
  git(main, "push", "--quiet", "origin", "HEAD:main");
  const released = git(main, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "w-dirty", "a.txt"), "local edit\n");
  fs.mkdirSync(path.join(root, "w-modules", "node_modules"));
  fs.writeFileSync(path.join(root, "w-modules", "node_modules", "x.js"), "x");
  fs.writeFileSync(path.join(root, "w-diverged", "b.txt"), "b\n");
  git(path.join(root, "w-diverged"), "add", "b.txt");
  git(path.join(root, "w-diverged"), "commit", "--quiet", "-m", "unique");
  const env = stateEnv();

  const dry = io();
  assert.equal(await releaseTrainCommand(["sync-branches", "--sha", released, "--dry-run", "--json", "--repo", main], { env, ...dry }, {}), 1);
  const plan = JSON.parse(dry.stdout.text);
  assert.equal(plan.branches.find((entry) => entry.branch === "w-behind").action, "would-fast-forward");
  assert.notEqual(git(root, "-C", path.join(root, "w-behind"), "rev-parse", "HEAD"), released);

  const out = io();
  assert.equal(await releaseTrainCommand(["sync-branches", "--sha", released, "--json", "--repo", main], { env, ...out }, {}), 1, "blocked branches make the train incomplete");
  const result = JSON.parse(out.stdout.text);
  const byName = Object.fromEntries(result.branches.map((entry) => [entry.branch, entry]));
  assert.equal(byName.main.action, "current");
  assert.equal(byName["w-behind"].action, "fast-forwarded");
  assert.equal(byName["w-behind"].push, "pushed");
  assert.equal(byName["w-modules"].action, "fast-forwarded");
  assert.equal(byName["w-dirty"].action, "skipped-dirty");
  assert.equal(byName["w-diverged"].action, "skipped-diverged");
  assert.equal(byName["w-diverged"].uniqueCommits, 1);
  assert.equal(byName["w-diverged"].missingCommits, 1);
  assert.equal(byName["w-local"].push, "local-only");
  assert.deepEqual(result.pushed.branches.sort(), ["w-behind", "w-modules"]);
  assert.equal(git(origin, "rev-parse", "w-behind"), released);
  assert.equal(git(origin, "rev-parse", "w-modules"), released);
  assert.notEqual(git(origin, "rev-parse", "w-diverged"), released);
  assert.equal(fs.readFileSync(path.join(root, "w-dirty", "a.txt"), "utf8"), "local edit\n");
  assert.deepEqual(result.blocked.sort(), ["w-dirty", "w-diverged"]);

  const text = io();
  await releaseTrainCommand(["sync-branches", "--sha", released, "--repo", main, "--path-prefix", path.join(root, "w-d")], { env, ...text }, {});
  assert.match(text.stdout.text, /w-diverged: skipped-diverged \(1 unique commit\(s\), 1 missing\)/);
  assert.doesNotMatch(text.stdout.text, /w-behind/);
});

test("orkestr release-train is wired into the CLI", async () => {
  const { stdout, stderr } = io();
  assert.equal(await runCli(["release-train"], { env: stateEnv(), stdout, stderr }), 2);
  assert.match(stdout.text, /orkestr release-train check/);
  const help = io();
  await runCli(["help"], { env: stateEnv(), ...help });
  assert.match(help.stdout.text, /orkestr release-train check\|ci\|deploy\|sync-branches\|run/);
});
