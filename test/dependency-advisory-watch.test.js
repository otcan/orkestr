import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultExec, formatWatch, planFix, runAdvisoryWatch, watchStateDir } from "../scripts/security/dependency-advisory-watch.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orkestr-adv-watch-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  git(root, "init", "--bare", "--quiet", origin);
  git(root, "clone", "--quiet", origin, repo);
  fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: "fixture", dependencies: { "pinned-lib": "1.0.0", "ranged-lib": "^2.0.0" }, devDependencies: { "major-only": "3.1.0" } }, null, 2)}\n`);
  fs.writeFileSync(path.join(repo, "package-lock.json"), "{}\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "base");
  git(repo, "push", "--quiet", "origin", "HEAD:main");
  return { root, origin, repo, stateDir: path.join(root, "state") };
}

const finding = (pkg, version, advisoryId, severity, fixedVersion = null, status = "open") => ({ package: pkg, version, advisoryId, severity, fixedVersion, status });
const blocked = {
  status: "blocked",
  counts: { advisories: 4, blocking: 3 },
  findings: [
    finding("pinned-lib", "1.0.0", "GHSA-aaaa-aaaa-aaaa", "high", "1.0.3,2.0.0"),
    finding("deep-transitive", "4.0.0", "GHSA-bbbb-bbbb-bbbb", "critical", "4.0.1"),
    finding("major-only", "3.1.0", "GHSA-cccc-cccc-cccc", "high", "4.0.0"),
    finding("low-noise", "1.0.0", "GHSA-dddd-dddd-dddd", "low", "1.0.1"),
  ],
};

test("fix plan bumps exact direct pins within the major and updates transitive packages", () => {
  const plan = planFix(blocked, { dependencies: { "pinned-lib": "1.0.0" }, devDependencies: { "major-only": "3.1.0" } });
  assert.deepEqual(plan.pins, { "pinned-lib": "1.0.3" });
  assert.deepEqual(plan.update, ["deep-transitive"]);
  assert.deepEqual(plan.skipped, [{ package: "major-only", reason: "no_fix_within_major" }]);
  assert.match(watchStateDir({ ORKESTR_ADVISORY_WATCH_STATE_DIR: "/tmp/x" }), /\/tmp\/x$/);
});

test("watch alerts on a blocked scan, builds a local fix branch, rescans, and never pushes", async () => {
  const { repo, origin, stateDir } = fixtureRepo();
  const scans = [];
  const scan = async ({ root, commit }) => {
    scans.push({ root, commit, packageJson: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) });
    return scans.length === 1 ? blocked : { status: "passed", counts: { advisories: 1, blocking: 0 }, findings: [blocked.findings[3]] };
  };
  const npmCalls = [];
  const exec = async (command, args, options = {}) => {
    if (command === "npm") {
      npmCalls.push(args);
      fs.appendFileSync(path.join(options.cwd, "package-lock.json"), `${args[0]} ${args.slice(5).join(" ")}\n`);
      return { code: 0, stdout: "", stderr: "" };
    }
    assert.notEqual(args.includes("push"), true, "the watch must never push");
    return defaultExec(command, args, options);
  };
  const result = await runAdvisoryWatch({ repo, stateDir, fixBranch: true, exec, scan });
  const sha = git(repo, "rev-parse", "origin/main");
  assert.equal(result.ok, false);
  assert.equal(result.alert, true);
  assert.equal(result.sha, sha);
  assert.deepEqual(result.newHighCritical, ["deep-transitive@4.0.0 GHSA-bbbb-bbbb-bbbb", "major-only@3.1.0 GHSA-cccc-cccc-cccc", "pinned-lib@1.0.0 GHSA-aaaa-aaaa-aaaa"]);
  assert.equal(scans[0].commit, sha);
  assert.deepEqual(npmCalls.map((args) => args.slice(0, 3)), [["install", "--package-lock-only", "--ignore-scripts"], ["update", "--package-lock-only", "--ignore-scripts"]]);
  assert.equal(npmCalls[1].at(-1), "deep-transitive");
  const branch = `deps/advisory-fix-${sha.slice(0, 12)}`;
  assert.equal(result.fix.branch, branch);
  assert.equal(result.fix.cleared, true);
  assert.equal(scans[1].commit, result.fix.commit);
  assert.equal(scans[1].packageJson.dependencies["pinned-lib"], "1.0.3");
  assert.equal(git(repo, "rev-parse", branch), result.fix.commit);
  assert.throws(() => git(origin, "rev-parse", "--verify", branch));
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1, "temporary worktree removed");
  assert.match(formatWatch(result), /clears the block/);
  assert.match(formatWatch(result), /major-only \(no_fix_within_major\)/);
});

test("watch stays quiet for known advisories and alerts again on a new high or critical one", async () => {
  const { repo, stateDir } = fixtureRepo();
  const passingWithKnown = { status: "passed", counts: { advisories: 1, blocking: 0 }, findings: [finding("known-lib", "1.0.0", "GHSA-eeee-eeee-eeee", "high", null, "approved_exception"), finding("tracked", "1.0.0", "GHSA-ffff-ffff-ffff", "high")] };
  const first = await runAdvisoryWatch({ repo, stateDir, scan: async () => passingWithKnown });
  assert.equal(first.alert, true, "first sighting of an open high advisory alerts");
  const second = await runAdvisoryWatch({ repo, stateDir, scan: async () => passingWithKnown });
  assert.equal(second.ok, true);
  assert.deepEqual(second.newHighCritical, []);
  const third = await runAdvisoryWatch({ repo, stateDir, scan: async () => ({ ...passingWithKnown, findings: [...passingWithKnown.findings, finding("fresh", "2.0.0", "GHSA-gggg-gggg-gggg", "critical")] }) });
  assert.equal(third.ok, false);
  assert.deepEqual(third.newHighCritical, ["fresh@2.0.0 GHSA-gggg-gggg-gggg"]);
  assert.equal(third.fix, undefined);
});
