// Example A (examples/repository-maintainer) against a local git repository
// and the fake code host, including a crash after the branch push.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { admitRun, registerJobFiles } from "../packages/core/src/agent-job-admission.js";
import { listRunEffects } from "../packages/core/src/agent-job-ledger.js";
import { driveToEnd, pullRequests, tempEnv } from "./fixtures/agent-job-fixtures.js";

const exampleDir = fileURLToPath(new URL("../examples/repository-maintainer", import.meta.url));
const gitEnv = { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Example", GIT_AUTHOR_EMAIL: "example@example.invalid", GIT_COMMITTER_NAME: "Example", GIT_COMMITTER_EMAIL: "example@example.invalid" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

test("Example A opens one branch and one pull request despite a crash after the push", async () => {
  const env = await tempEnv();
  const project = path.join(env.ORKESTR_HOME, "project");
  await fs.cp(exampleDir, project, { recursive: true });
  const repo = path.join(project, "repo");
  await fs.mkdir(repo);
  git(repo, "init", "-q");
  await fs.writeFile(path.join(repo, "README.md"), "# example\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "init");
  const base = git(repo, "rev-parse", "HEAD");

  const [job] = await registerJobFiles(project, env);
  const { run } = await admitRun({ job: job.name, type: "webhook", name: "issue-opened", body: { delivery_id: "example-delivery-7" } }, env);
  const result = await driveToEnd(run.id, env, { faults: [{ at: "effect_performed", tool: "repo.branch.push", attempts: [1] }] });
  assert.equal(result.state, "succeeded", JSON.stringify(result));

  const branch = git(repo, "rev-parse", "orkestr/issue-7");
  assert.equal(git(repo, "rev-parse", `${branch}^`), base, "exactly one commit on top of the base");
  assert.equal(git(repo, "show", `${branch}:FIX.md`), "Fixed issue 7.");
  assert.equal(git(repo, "rev-parse", "HEAD"), base, "the working branch is untouched");
  const push = (await listRunEffects(run.id, env)).find((effect) => effect.tool === "repo.branch.push");
  assert.equal(push.reconciled, true);
  const prs = await pullRequests(env);
  assert.equal(prs.length, 1);
  assert.equal(prs[0].head, "orkestr/issue-7");
  assert.equal(prs[0].merges, 1);
});

test("github.* tools refuse to run without an explicit fake code host", async () => {
  const env = await tempEnv();
  const project = path.join(env.ORKESTR_HOME, "project");
  await fs.cp(exampleDir, project, { recursive: true });
  const file = path.join(project, "jobs", "repository-maintainer.yaml");
  const text = (await fs.readFile(file, "utf8")).replace("    code_host: fake", "    code_host: github").replace(/      - tool: repo\.[\s\S]*?(?=      - tool: github\.pull_request\.create)/, "");
  await fs.writeFile(file, text);
  const [job] = await registerJobFiles(project, env);
  const { run } = await admitRun({ job: job.name, type: "api", dedupeKey: "evt" }, env);
  const result = await driveToEnd(run.id, env);
  assert.equal(result.state, "succeeded");
  assert.equal((await pullRequests(env)).length, 0);
  const create = (await listRunEffects(run.id, env)).find((effect) => effect.tool === "github.pull_request.create");
  assert.equal(create.state, "failed");
  assert.match(create.error, /code_host_not_configured/);
});
