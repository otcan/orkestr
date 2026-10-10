// Example A (examples/repository-maintainer) end to end on the real `codex`
// job executor: the Codex app-server is the conformance fake, the code host is
// the local fake code host, the repository is a local git repo. The fake
// "model" calls the job's Orkestr tools as Codex dynamic tools.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { admitRun, registerJobFiles } from "../packages/core/src/agent-job-admission.js";
import { listRunEffects } from "../packages/core/src/agent-job-ledger.js";
import { listCheckpoints } from "../packages/core/src/agent-job-store.js";
import { stopCodexJobClients } from "../packages/core/src/codex-job-client.js";
import { listThreads } from "../packages/core/src/threads.js";
import { codexJobEnv, driveCodexRun, readFakeCodex, useRealProviderProbes } from "./fixtures/codex-job-fixtures.js";
import { pullRequests } from "./fixtures/agent-job-fixtures.js";

const exampleDir = fileURLToPath(new URL("../examples/repository-maintainer", import.meta.url));
const gitEnv = { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Example", GIT_AUTHOR_EMAIL: "example@example.invalid", GIT_COMMITTER_NAME: "Example", GIT_COMMITTER_EMAIL: "example@example.invalid" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

const script = [
  { say: "Reading the repository." },
  { tool: "repo.read", args: { file: "README.md" } },
  { tool: "repo.branch.push", args: { branch: "orkestr/issue-7", file: "FIX.md", content: "Fixed issue 7.\n", message: "fix: issue 7" } },
  { tool: "github.pull_request.create", args: { repository: "example-org/example-repo", head: "orkestr/issue-7", title: "fix: issue 7" } },
  { tool: "github.pull_request.merge", args: { repository: "example-org/example-repo", head: "orkestr/issue-7" } },
  { final: { summary: "Opened and merged one pull request for issue 7." } },
];

async function setup(t) {
  const env = await codexJobEnv({ script });
  t.after(() => stopCodexJobClients());
  useRealProviderProbes();
  const project = path.join(env.ORKESTR_HOME, "project");
  await fs.cp(exampleDir, project, { recursive: true });
  const repo = path.join(project, "repo");
  await fs.mkdir(repo);
  git(repo, "init", "-q");
  await fs.writeFile(path.join(repo, "README.md"), "# example\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "init");
  const [job] = await registerJobFiles(project, env);
  assert.equal(job.spec?.agent?.provider ?? "codex", "codex");
  const { run } = await admitRun({ job: job.name, type: "webhook", name: "issue-opened", body: { delivery_id: "example-delivery-7" } }, env);
  return { env, repo, run, base: git(repo, "rev-parse", "HEAD") };
}

test("Example A runs end to end on the codex executor with the fake app-server and fake code host", async (t) => {
  const { env, repo, run, base } = await setup(t);
  const result = await driveCodexRun(run.id, env);
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  assert.deepEqual(result.output, { summary: "Opened and merged one pull request for issue 7." });

  // The merge is approval_required: the run parked once, then resumed the
  // same Codex session and consumed the approval.
  assert.deepEqual(result.parked.map((approval) => approval.tool), ["github.pull_request.merge"]);
  const fake = await readFakeCodex(env);
  assert.equal(fake.calls.filter((call) => call.method === "thread/start").length, 1);
  assert.ok(fake.calls.some((call) => call.method === "thread/resume" && call.threadId === "thr_001"));
  assert.deepEqual(fake.threads[0].dynamicTools.sort(), ["github__pull_request__create", "github__pull_request__merge", "repo__branch__push", "repo__read"]);
  assert.deepEqual(fake.threads[0].startParams, { approvalPolicy: "untrusted", sandbox: "workspace-write" });

  const branch = git(repo, "rev-parse", "orkestr/issue-7");
  assert.equal(git(repo, "rev-parse", `${branch}^`), base);
  assert.equal(git(repo, "rev-parse", "HEAD"), base, "the working branch is untouched");
  const prs = await pullRequests(env);
  assert.equal(prs.length, 1);
  assert.equal(prs[0].merges, 1);

  // Workspace: a detached git worktree of the repository, Codex ran there.
  const checkpoints = await listCheckpoints(run.id, env);
  const workspace = checkpoints.find((entry) => entry.kind === "workspace").data;
  assert.equal(workspace.kind, "git_worktree");
  assert.equal(fake.threads[0].cwd, workspace.path);
  assert.equal(git(workspace.path, "rev-parse", "HEAD"), base);
  // Progress is streamed into the run journal.
  assert.ok(checkpoints.some((entry) => entry.kind === "progress" && /Reading the repository/.test(entry.data.text)));
  assert.equal(checkpoints.filter((entry) => entry.kind === "codex_session").length, 2);
  // No chat thread was created for the job.
  assert.deepEqual(await listThreads(env), []);
});

test("Example A on codex survives a crash right after the branch push", async (t) => {
  const { env, repo, run, base } = await setup(t);
  const result = await driveCodexRun(run.id, env, { faults: [{ at: "effect_performed", tool: "repo.branch.push", attempts: [1] }] });
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  const branch = git(repo, "rev-parse", "orkestr/issue-7");
  assert.equal(git(repo, "rev-parse", `${branch}^`), base, "exactly one commit on top of the base");
  const push = (await listRunEffects(run.id, env)).find((effect) => effect.tool === "repo.branch.push");
  assert.equal(push.reconciled, true);
  const prs = await pullRequests(env);
  assert.equal(prs.length, 1);
  assert.equal(prs[0].merges, 1);
  const fake = await readFakeCodex(env);
  assert.ok(fake.spawnCount >= 2, "the app-server was restarted");
  assert.equal(fake.calls.filter((call) => call.method === "thread/start").length, 1, "the restarted attempt resumed the Codex session");
  // Codex asked for the push again after the restart; the ledger answered it from the committed effect.
  assert.equal(fake.toolCalls.filter((call) => call.tool === "repo.branch.push").length, 1);
});
