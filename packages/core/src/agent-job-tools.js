// Tool registry for Agent Job runs. A tool definition decides whether a call
// is a side effect, which args form its logical key (agent-job §4) and how to
// find an earlier execution again after a crash (`reconcile`).
//
//   {
//     name: "demo.pull_request.create",
//     effect: true,                       // false = read-only, never ledgered
//     logicalKey(args, ctx) {},           // default: canonical args
//     reconcile(effect, ctx) {},          // -> { found: true, result, ref } | { found: false } ; omit = at_most_once
//     async perform(args, ctx) {},        // ctx.effectKey is the idempotency key / marker
//   }
//
// The `demo.*` and Example A tools below are offline: they act on the local
// fake code host (simulated-pr-sink.js) and, for `repo.*`, a local git repo.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  findSimulatedPullRequest,
  listSimulatedPullRequests,
  mergeSimulatedPullRequest,
  openSimulatedPullRequest,
} from "./simulated-pr-sink.js";

const run = promisify(execFile);
const tools = new Map();

export function registerAgentJobTool(definition) {
  if (!definition?.name) throw new Error("agent_job_tool_name_required");
  tools.set(definition.name, Object.freeze({ effect: true, ...definition }));
  return () => tools.delete(definition.name);
}

export function getAgentJobTool(name) {
  return tools.get(String(name || "")) || null;
}

export function listAgentJobTools() {
  return [...tools.values()].map((tool) => ({ name: tool.name, effect: tool.effect !== false, reconcile: typeof tool.reconcile === "function" }));
}

function clean(value) {
  return String(value ?? "").trim();
}

async function findByHead(repository, head, env) {
  return (await listSimulatedPullRequests(env)).find((pr) => pr.repository === repository && pr.head === head) || null;
}

// ---- simulated demo tools (fake code host) ----

const pullRequestCreate = (name) => ({
  name,
  effect: true,
  logicalKey: (args) => [clean(args.repository), clean(args.head)],
  async reconcile(effect, ctx) {
    const pr = await findSimulatedPullRequest(effect.effectKey, ctx.env);
    return pr ? { found: true, result: pr, ref: `fake-host://${pr.repository}/pull/${pr.number}` } : { found: false };
  },
  async perform(args, ctx) {
    const pr = await openSimulatedPullRequest({ ...args, idempotencyKey: ctx.effectKey }, ctx.env);
    return { result: pr, ref: `fake-host://${pr.repository}/pull/${pr.number}` };
  },
});

const pullRequestMerge = (name) => ({
  name,
  effect: true,
  logicalKey: (args) => [clean(args.repository), clean(args.head)],
  async reconcile(_effect, ctx) {
    const pr = await findByHead(clean(ctx.args?.repository), clean(ctx.args?.head), ctx.env);
    return pr?.state === "merged" ? { found: true, result: pr, ref: `fake-host://${pr.repository}/pull/${pr.number}` } : { found: false };
  },
  async perform(args, ctx) {
    const pr = await findByHead(clean(args.repository), clean(args.head), ctx.env);
    if (!pr) throw Object.assign(new Error("pull_request_not_found"), { kind: "task", retryable: false });
    const merged = await mergeSimulatedPullRequest(pr.number, ctx.env);
    return { result: merged, ref: `fake-host://${merged.repository}/pull/${merged.number}` };
  },
});

registerAgentJobTool({
  name: "demo.repo.read",
  effect: false,
  async perform(args) {
    return { result: { repository: clean(args.repository) || "example/repo", files: ["package.json", "src/index.js"], outdated: ["example-lib 1.9.0 -> 2.0.1"] } };
  },
});
registerAgentJobTool(pullRequestCreate("demo.pull_request.create"));
registerAgentJobTool(pullRequestMerge("demo.pull_request.merge"));

// An effect with no reconcile hook and no remote idempotency: at_most_once.
// After a crash its outcome is `unknown` and a human decides (G4).
registerAgentJobTool({
  name: "demo.notify.send",
  effect: true,
  async perform(args, ctx) {
    const paths = path.join(ctx.home, "simulated", "sent-notes.jsonl");
    await fs.mkdir(path.dirname(paths), { recursive: true });
    await fs.appendFile(paths, `${JSON.stringify({ text: clean(args.text), effectKey: ctx.effectKey })}\n`);
    return { result: { sent: true } };
  },
});

// ---- Example A (examples/repository-maintainer): local git + fake code host ----

async function git(cwd, args) {
  const { stdout } = await run("git", args, { cwd, env: { PATH: process.env.PATH || "", GIT_TERMINAL_PROMPT: "0", HOME: cwd } });
  return stdout.trim();
}

function repoPath(args, ctx) {
  const target = clean(args.path || ctx.inputs?.repository_path);
  if (!target) throw Object.assign(new Error("repository_path_required"), { kind: "task", retryable: false });
  return path.resolve(ctx.baseDir || process.cwd(), target);
}

registerAgentJobTool({
  name: "repo.read",
  effect: false,
  async perform(args, ctx) {
    const cwd = repoPath(args, ctx);
    const files = (await git(cwd, ["ls-files"])).split("\n").filter(Boolean);
    const file = clean(args.file);
    const content = file ? await fs.readFile(path.join(cwd, file), "utf8") : null;
    return { result: { files, file: file || null, content } };
  },
});

registerAgentJobTool({
  name: "repo.branch.push",
  effect: true,
  logicalKey: (args) => [clean(args.branch)],
  async reconcile(_effect, ctx) {
    const cwd = repoPath(ctx.args || {}, ctx);
    const sha = await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${clean(ctx.args?.branch)}`]).catch(() => "");
    return sha ? { found: true, result: { branch: clean(ctx.args?.branch), sha }, ref: sha } : { found: false };
  },
  async perform(args, ctx) {
    const cwd = repoPath(args, ctx);
    const branch = clean(args.branch);
    const base = await git(cwd, ["rev-parse", "HEAD"]);
    // Build the commit without touching the working tree or HEAD.
    const indexFile = path.join(ctx.home, "simulated", `index-${ctx.effectKey}`);
    await fs.mkdir(path.dirname(indexFile), { recursive: true });
    const env = { PATH: process.env.PATH || "", GIT_INDEX_FILE: indexFile, HOME: cwd,
      GIT_AUTHOR_NAME: "Orkestr Example", GIT_AUTHOR_EMAIL: "agent@example.invalid",
      GIT_COMMITTER_NAME: "Orkestr Example", GIT_COMMITTER_EMAIL: "agent@example.invalid" };
    const opts = { cwd, env };
    await run("git", ["read-tree", base], opts);
    const contentPath = path.join(ctx.home, "simulated", `blob-${ctx.effectKey}`);
    await fs.writeFile(contentPath, String(args.content ?? ""));
    const { stdout: blobSha } = await run("git", ["hash-object", "-w", contentPath], opts);
    await run("git", ["update-index", "--add", "--cacheinfo", `100644,${blobSha.trim()},${clean(args.file)}`], opts);
    const { stdout: tree } = await run("git", ["write-tree"], opts);
    const { stdout: commit } = await run("git", ["commit-tree", tree.trim(), "-p", base, "-m", `${clean(args.message) || "orkestr change"}\n\norkestr-effect: ${ctx.effectKey}`], opts);
    await run("git", ["update-ref", `refs/heads/${branch}`, commit.trim()], opts);
    await fs.rm(indexFile, { force: true });
    await fs.rm(contentPath, { force: true });
    return { result: { branch, sha: commit.trim() }, ref: commit.trim() };
  },
});

// `github.*` only has the offline fake code host so far. A job must opt in
// with `inputs.code_host: fake`; anything else fails loudly instead of
// pretending a real pull request was opened.
function fakeHostOnly(definition) {
  const guard = (ctx) => {
    if (ctx.inputs?.code_host !== "fake") {
      throw Object.assign(new Error("code_host_not_configured: set task.inputs.code_host to fake; a real GitHub connector is not available yet"), { kind: "task", retryable: false });
    }
  };
  return {
    ...definition,
    async reconcile(effect, ctx) { guard(ctx); return definition.reconcile(effect, ctx); },
    async perform(args, ctx) { guard(ctx); return definition.perform(args, ctx); },
  };
}

registerAgentJobTool(fakeHostOnly(pullRequestCreate("github.pull_request.create")));
registerAgentJobTool(fakeHostOnly(pullRequestMerge("github.pull_request.merge")));
