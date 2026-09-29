// `orkestr release-train check`: build and test an exact commit in a fresh,
// throwaway git worktree (own node_modules, never shared with another
// checkout), then run the dependency advisory scan for that commit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tail } from "./release-train-support.js";

export function releaseCheckSteps({ worktree, sha, reportFile, testTmpDir }) {
  return [
    { name: "npm ci", command: "npm", args: ["ci", "--ignore-scripts", "--no-audit"] },
    { name: "patch whatsapp media id", command: "node", args: ["scripts/patch-whatsapp-media-id.mjs"] },
    { name: "build", command: "npm", args: ["run", "build"] },
    { name: "launcher build", command: "npm", args: ["run", "launcher:build"] },
    { name: "test:ci", command: "npm", args: ["run", "test:ci"], env: { TMPDIR: testTmpDir } },
    {
      name: "dependency advisories",
      command: "node",
      args: [path.join(worktree, "scripts/security/dependency-advisories.mjs"), "--root", worktree, "--commit", sha, "--policy-commit", sha, "--report", reportFile],
    },
  ];
}

function shortTmpDir(env) {
  const explicit = String(env.ORKESTR_RELEASE_TRAIN_TEST_TMPDIR || "").trim();
  if (explicit) return explicit;
  return fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
}

// Returns { ok, sha, steps: [{ name, code, durationMs }], failedStep, output }.
export async function runReleaseCheck({ git, exec, sha, env = process.env, stateDir, now = () => Date.now(), onStep = () => {} }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "orkestr-release-check-"));
  const worktree = path.join(base, "wt");
  const runDir = path.join(stateDir, "runs", `${sha}-${now()}`);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const reportFile = path.join(runDir, "dependency-advisories.json");
  const logFile = path.join(runDir, "check.log");
  const result = { ok: false, sha, startedAt: new Date(now()).toISOString(), steps: [], logFile, reportFile, worktree };
  const stepEnv = { ...env };
  for (const key of ["ORKESTR_HOME", "ORKESTR_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) delete stepEnv[key];
  try {
    await git(["worktree", "add", "--detach", worktree, sha]);
    for (const step of releaseCheckSteps({ worktree, sha, reportFile, testTmpDir: shortTmpDir(env) })) {
      onStep(step.name);
      const started = now();
      const run = await exec(step.command, step.args, { cwd: worktree, env: { ...stepEnv, ...(step.env || {}) }, logFile });
      result.steps.push({ name: step.name, code: run.code, durationMs: now() - started });
      if (run.code !== 0) {
        result.failedStep = step.name;
        result.output = tail(`${run.stdout}\n${run.stderr}`, 30);
        break;
      }
    }
    result.ok = !result.failedStep;
    try {
      const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
      result.dependencyAdvisories = { status: report.status, counts: report.counts };
    } catch {}
  } catch (error) {
    result.failedStep = result.failedStep || "worktree";
    result.output = String(error?.message || error);
  } finally {
    await git(["worktree", "remove", "--force", worktree], { allowFailure: true });
    fs.rmSync(base, { recursive: true, force: true });
    await git(["worktree", "prune"], { allowFailure: true });
  }
  result.finishedAt = new Date(now()).toISOString();
  return result;
}
