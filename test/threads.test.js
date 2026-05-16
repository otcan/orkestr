import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer } from "../apps/server/src/server.js";
import { runNextThreadMessage } from "../packages/core/src/executors.js";
import { runtimeStatus, syncRuntimeWindowName, wakeThread } from "../packages/core/src/runtime-leases.js";
import { parseThreadInputCommand } from "../packages/core/src/thread-commands.js";
import { createThreadWorker, detectThreadGitState, listThreadWorkers, updateThreadRepo } from "../packages/core/src/thread-workers.js";
import { appendThreadMessage, createThread, enqueueThreadInput, listThreadMessages, listThreads, updateThread } from "../packages/core/src/threads.js";

const execFileAsync = promisify(execFile);

async function createTempGitRepo(prefix = "orkestr-worker-repo-") {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "orkestr@example.test"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Orkestr Test"], { cwd: repo });
  await fs.writeFile(path.join(repo, "README.md"), "# test repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
  return repo;
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function createFakeTmux(home) {
  const bin = path.join(home, "bin");
  const log = path.join(home, "tmux.log");
  const state = path.join(home, "tmux.sessions");
  await fs.mkdir(bin, { recursive: true });
  const tmuxPath = path.join(bin, "tmux");
  await fs.writeFile(
    tmuxPath,
    `#!/usr/bin/env bash
set -euo pipefail
{
  printf '__CALL__'
  for arg in "$@"; do printf '\\t%s' "$arg"; done
  printf '\\n'
} >> "$TMUX_LOG"

cmd="\${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
case "$cmd" in
  has-session)
    target=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-t" ]; then target="\${2:-}"; shift 2; else shift; fi
    done
    if [ -f "$TMUX_STATE" ] && grep -Fxq "$target" "$TMUX_STATE"; then exit 0; fi
    exit 1
    ;;
  new-session)
    session=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-s" ]; then session="\${2:-}"; shift 2; else shift; fi
    done
    if [ -n "$session" ]; then printf '%s\\n' "$session" >> "$TMUX_STATE"; fi
    exit 0
    ;;
  list-panes)
    printf '%%42\\n'
    exit 0
    ;;
  capture-pane)
    printf '%s\\n' "\${TMUX_CAPTURE_TEXT:-> }"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
    "utf8",
  );
  await fs.chmod(tmuxPath, 0o755);
  return { bin, log, state };
}

function restoreEnvValue(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("threads are the primary routable runtime object", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-threads-"));
  const env = { ORKESTR_HOME: home };
  const thread = await createThread({ id: "demo-thread", name: "Demo Thread", executorId: "noop" }, env);
  const input = await enqueueThreadInput("demo-thread", { text: "hello thread" }, env);
  const execution = await runNextThreadMessage("demo-thread", {}, env);
  const threads = await listThreads(env);
  const messages = await listThreadMessages("demo-thread", env);

  assert.equal(thread.id, "demo-thread");
  assert.equal(input.state, "queued");
  assert.equal(execution.state, "completed");
  assert.equal(threads[0].state, "ready");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].state, "completed");
  assert.equal(messages[1].role, "assistant");
});

test("threads default to wake-on-message and sleep without a runtime lease", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-sleeping-"));
  const env = { ORKESTR_HOME: home };
  const thread = await createThread({ id: "sleeping-thread", name: "Sleeping Thread" }, env);
  const status = await runtimeStatus("sleeping-thread", env);

  assert.equal(thread.wakePolicy, "wake-on-message");
  assert.equal(status.state, "sleeping");
  assert.equal(status.promptReady, false);
  assert.equal(status.hibernated, true);
});

test("thread runtimes name the tmux window after the thread for byobu", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-tmux-title-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
    };
    await createThread({ id: "demo-thread", name: "Demo Thread With A Readable Name" }, env);

    const woken = await wakeThread("demo-thread", { reason: "test" }, env);
    await updateThread("demo-thread", { name: "Renamed Thread" }, env);
    const synced = await syncRuntimeWindowName("demo-thread", env);
    const log = await fs.readFile(fakeTmux.log, "utf8");

    assert.equal(woken.lease.windowName, "Demo Thread With A Readable Name");
    assert.equal(woken.status.windowName, "Demo Thread With A Readable Name");
    assert.deepEqual(synced, { sessionName: "orkestr-demo-thread", windowName: "Renamed Thread" });
    assert.match(log, /__CALL__\tset-window-option\t-t\torkestr-demo-thread\tautomatic-rename\toff/);
    assert.match(log, /__CALL__\tset-window-option\t-t\torkestr-demo-thread\tallow-rename\toff/);
    assert.match(log, /__CALL__\trename-window\t-t\torkestr-demo-thread\tDemo Thread With A Readable Name/);
    assert.match(log, /__CALL__\trename-window\t-t\torkestr-demo-thread\tRenamed Thread/);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
  }
});

test("runtime status keeps delivered Codex input processing until prompt returns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-processing-status-"));
  const fakeTmux = await createFakeTmux(home);
  const priorPath = process.env.PATH;
  const priorTmuxLog = process.env.TMUX_LOG;
  const priorTmuxState = process.env.TMUX_STATE;
  const priorTmuxCaptureText = process.env.TMUX_CAPTURE_TEXT;
  process.env.PATH = `${fakeTmux.bin}:${priorPath || ""}`;
  process.env.TMUX_LOG = fakeTmux.log;
  process.env.TMUX_STATE = fakeTmux.state;

  try {
    const env = {
      ORKESTR_HOME: path.join(home, "orkestr-home"),
      HOME: path.join(home, "runtime-home"),
      CODEX_HOME: path.join(home, "codex-home"),
      PATH: process.env.PATH,
      TMUX_LOG: fakeTmux.log,
      TMUX_STATE: fakeTmux.state,
    };
    await createThread({ id: "processing-thread", name: "Processing Thread" }, env);
    await wakeThread("processing-thread", { reason: "test" }, env);
    process.env.TMUX_CAPTURE_TEXT = "Codex is still preparing a response";
    await updateThread("processing-thread", { state: "working" }, env);

    const busy = await runtimeStatus("processing-thread", env);

    assert.equal(busy.state, "working");
    assert.equal(busy.working, true);

    process.env.TMUX_CAPTURE_TEXT = "> ";
    const ready = await runtimeStatus("processing-thread", env);

    assert.equal(ready.state, "ready");
    assert.equal(ready.working, false);
  } finally {
    restoreEnvValue("PATH", priorPath);
    restoreEnvValue("TMUX_LOG", priorTmuxLog);
    restoreEnvValue("TMUX_STATE", priorTmuxState);
    restoreEnvValue("TMUX_CAPTURE_TEXT", priorTmuxCaptureText);
  }
});

test("thread workers create a git worktree-backed child thread without resuming the parent Codex thread", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-home-"));
  const repo = await createTempGitRepo();
  const env = { ORKESTR_HOME: home };
  const parent = await createThread({
    id: "parent-thread",
    name: "Parent Thread",
    cwd: repo,
    executor: { type: "codex", codexThreadId: "parent-codex-id", metadata: { codexModel: "gpt-test" } },
  }, env);

  const result = await createThreadWorker(parent.id, {
    label: "Worker A",
    task: "Investigate the feature on a parallel branch.",
    autoRun: false,
  }, env);
  const workers = await listThreadWorkers(parent.id, env);
  const messages = await listThreadMessages(result.worker.id, env);

  assert.equal(result.worker.parentThreadId, parent.id);
  assert.equal(result.worker.rootThreadId, parent.id);
  assert.equal(result.worker.workerLabel, "Worker A");
  assert.match(result.worker.branchName, /^orkestr\/Parent-Thread\//);
  assert.equal(result.worker.remoteBranch, `origin/${result.worker.branchName}`);
  assert.equal(result.worker.gitAhead, null);
  assert.equal(result.worker.gitBehind, null);
  assert.equal(result.worker.executor.codexThreadId, "");
  assert.equal(result.worker.executor.metadata.forkedFromCodexThreadId, "parent-codex-id");
  assert.match(result.worker.handoffPrompt, /Role: worker thread\. You are not the parent\/root Orkestr thread/);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].id, result.worker.id);
  assert.equal(await fs.stat(result.worker.worktreePath).then((stats) => stats.isDirectory()), true);
  assert.match(messages[0].text, /Role: worker thread\. You are not the parent\/root Orkestr thread/);
  assert.match(messages[0].text, /Work only inside this worker worktree and branch/);
  assert.match(messages[0].text, /Do not merge into, push to, or otherwise mutate main from this worker thread/);
  assert.match(messages[0].text, /parent\/root Orkestr thread owns integration, merge-to-main, push-to-main, tags, and release actions/);
  assert.match(messages[0].text, new RegExp(result.worker.branchName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("thread worker creation requires a git repository path", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-missing-repo-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "no-repo-thread", name: "No Repo Thread", cwd: home }, env);
  await assert.rejects(
    () => createThreadWorker("no-repo-thread", { task: "try to fork" }, env),
    /thread_repo_not_found/,
  );
});

test("thread worker git state reports live branch and base deviation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-git-state-home-"));
  const repo = await createTempGitRepo("orkestr-thread-worker-git-state-repo-");
  const env = { ORKESTR_HOME: home };
  const parent = await createThread({ id: "git-state-parent", name: "Git State Parent", cwd: repo }, env);
  const result = await createThreadWorker(parent.id, { label: "Git State Worker", autoRun: false }, env);
  const committedPath = path.join(result.worker.worktreePath, "committed.txt");
  const dirtyPath = path.join(result.worker.worktreePath, "dirty.txt");

  await fs.writeFile(committedPath, "committed worker change\n", "utf8");
  await execFileAsync("git", ["add", "committed.txt"], { cwd: result.worker.worktreePath });
  await execFileAsync("git", ["commit", "-m", "worker change"], { cwd: result.worker.worktreePath });
  await fs.writeFile(dirtyPath, "dirty worker change\n", "utf8");

  const state = await detectThreadGitState(result.worker, env);

  assert.equal(state.branchName, result.worker.branchName);
  assert.equal(state.gitBaseAhead, 1);
  assert.equal(state.gitChangedFiles, 2);
  assert.equal(state.gitDirtyFiles, 1);
  assert.equal(state.gitRemoteMissing, true);
});

test("thread worker git state falls back to base branch when stored base commit is stale", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-git-fallback-home-"));
  const repo = await createTempGitRepo("orkestr-thread-worker-git-fallback-repo-");
  const env = { ORKESTR_HOME: home };
  const parent = await createThread({ id: "git-fallback-parent", name: "Git Fallback Parent", cwd: repo }, env);
  const result = await createThreadWorker(parent.id, { label: "Git Fallback Worker", autoRun: false }, env);
  await fs.writeFile(path.join(result.worker.worktreePath, "fallback.txt"), "worker branch change\n", "utf8");
  await execFileAsync("git", ["add", "fallback.txt"], { cwd: result.worker.worktreePath });
  await execFileAsync("git", ["commit", "-m", "worker fallback change"], { cwd: result.worker.worktreePath });
  const head = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: result.worker.worktreePath }).then((result) => String(result.stdout).trim());

  const state = await detectThreadGitState({ ...result.worker, baseCommit: head }, env);

  assert.equal(state.gitComparisonLabel, "main");
  assert.equal(state.gitBaseAhead, 1);
  assert.equal(state.gitChangedFiles, 1);
});

test("thread workers can be created as blank parallel chats", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-blank-home-"));
  const repo = await createTempGitRepo("orkestr-thread-worker-blank-repo-");
  const env = { ORKESTR_HOME: home };
  const parent = await createThread({ id: "blank-worker-parent", name: "Blank Worker Parent", cwd: repo }, env);

  const result = await createThreadWorker(parent.id, { label: "Blank Worker", autoRun: false }, env);
  const messages = await listThreadMessages(result.worker.id, env);

  assert.equal(result.worker.parentThreadId, parent.id);
  assert.equal(result.worker.workerLabel, "Blank Worker");
  assert.equal(result.worker.workerStatus, "created");
  assert.equal(result.worker.remoteBranch, `origin/${result.worker.branchName}`);
  assert.equal(result.worker.gitAhead, null);
  assert.equal(result.worker.gitBehind, null);
  assert.match(result.worker.handoffPrompt, /Role: worker thread\. You are not the parent\/root Orkestr thread/);
  assert.match(result.worker.handoffPrompt, /No task was supplied\. Wait for parent\/root instructions before making changes/);
  assert.equal(result.message, null);
  assert.equal(messages.length, 0);
});

test("thread repo metadata can be saved as first-class thread state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-repo-meta-"));
  const repo = await createTempGitRepo("orkestr-thread-repo-meta-repo-");
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:otcan/orkestr.git"], { cwd: repo });
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "repo-thread", name: "Repo Thread" }, env);

  const result = await updateThreadRepo("repo-thread", { repoPath: repo, branchName: "main" }, env);

  assert.equal(result.thread.repoPath, repo);
  assert.equal(result.thread.repoRemoteUrl, "git@github.com:otcan/orkestr.git");
  assert.equal(result.thread.remoteBranch, "origin/main");
  assert.equal(result.thread.branchName, "main");
  assert.equal(result.repo.repoRemoteUrl, "git@github.com:otcan/orkestr.git");
  assert.equal(result.repo.remoteBranch, "origin/main");
  assert.equal(result.repo.branchName, "main");
  assert.match(result.thread.baseCommit, /^[0-9a-f]{40}$/);
});

test("thread input commands strip /now before runtime delivery", () => {
  assert.deepEqual(parseThreadInputCommand({ text: "/now run this immediately" }), {
    command: "interrupt",
    rawCommand: "now",
    text: "run this immediately",
  });
  assert.equal(parseThreadInputCommand({ text: "normal message" }).command, null);
});

test("thread runtime summary reads Codex model and limits from live metadata", async (t) => {
  try {
    await execFileAsync("sqlite3", ["--version"]);
  } catch {
    t.skip("sqlite3 unavailable");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-metadata-api-"));
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-home-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-workspace-"));
  const codexThreadId = "11111111-1111-4111-8111-111111111111";
  const rolloutPath = path.join(codexHome, "sessions", "rollout-metadata.jsonl");
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await fs.writeFile(rolloutPath, `${JSON.stringify({
    timestamp: "2026-05-16T10:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 120,
          cached_input_tokens: 40,
          output_tokens: 30,
          reasoning_output_tokens: 10,
          total_tokens: 150,
        },
        last_token_usage: {
          input_tokens: 70,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 5,
          total_tokens: 80,
        },
        model_context_window: 258400,
      },
      rate_limits: {
        primary: { used_percent: 12, window_minutes: 300, resets_at: 1770000000 },
        secondary: { used_percent: 34, window_minutes: 10080, resets_at: 1770500000 },
        plan_type: "pro",
      },
    },
  })}\n`, "utf8");
  const nowMs = Date.now();
  await execFileAsync("sqlite3", [path.join(codexHome, "state_5.sqlite"), [
    "create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, sandbox_policy text not null, approval_mode text not null, tokens_used integer not null default 0, archived integer not null default 0, model text, reasoning_effort text, created_at_ms integer, updated_at_ms integer);",
    `insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used, archived, model, reasoning_effort, created_at_ms, updated_at_ms) values (${sqlQuote(codexThreadId)}, ${sqlQuote(rolloutPath)}, ${Math.floor(nowMs / 1000)}, ${Math.floor(nowMs / 1000)}, 'codex', 'openai', ${sqlQuote(workspace)}, 'Metadata Thread', 'workspace-write', 'never', 99, 0, 'gpt-test-codex', 'high', ${nowMs}, ${nowMs});`,
  ].join("\n")]);

  const priorHome = process.env.ORKESTR_HOME;
  const priorCodexHome = process.env.CODEX_HOME;
  process.env.ORKESTR_HOME = home;
  process.env.CODEX_HOME = codexHome;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await createThread({ id: "metadata-api-thread", name: "Metadata API Thread", cwd: workspace }, { ORKESTR_HOME: home });
    const response = await fetch(`${baseUrl}/api/threads/metadata-api-thread/runtime-lite`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.codexThreadId, codexThreadId);
    assert.equal(payload.threadId, codexThreadId);
    assert.equal(payload.codexModel, "gpt-test-codex");
    assert.equal(payload.codexReasoningEffort, "high");
    assert.equal(payload.codexContextWindow, 258400);
    assert.equal(payload.codexTokenUsage.total_tokens, 80);
    assert.equal(payload.codexTotalTokenUsage.total_tokens, 150);
    assert.equal(payload.codexRateLimits.primary.used_percent, 12);
    assert.equal(payload.codexRateLimits.secondary.used_percent, 34);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
  }
});

test("thread APIs create, queue, run, and list messages", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const created = await fetch(`${baseUrl}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "api-thread", name: "API Thread", executorId: "noop" }),
    });
    const input = await fetch(`${baseUrl}/api/threads/api-thread/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "run this", autoRun: false }),
    });
    const run = await fetch(`${baseUrl}/api/threads/api-thread/run-next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const listed = await fetch(`${baseUrl}/api/threads/api-thread/messages`);

    assert.equal(created.status, 201);
    assert.equal(input.status, 202);
    assert.equal(run.status, 200);
    const payload = await listed.json();
    assert.equal(payload.thread.id, "api-thread");
    assert.equal(payload.messages.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});

test("thread message API hides adjacent duplicate rollout assistant records", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-duplicate-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await createThread({ id: "duplicate-api-thread", name: "Duplicate API Thread" }, { ORKESTR_HOME: home });
    await appendThreadMessage("duplicate-api-thread", {
      role: "assistant",
      source: "codex-rollout",
      phase: "final_answer",
      text: "same final answer",
      createdAt: "2026-05-16T10:00:00.000Z",
    }, { ORKESTR_HOME: home });
    await appendThreadMessage("duplicate-api-thread", {
      role: "assistant",
      source: "codex-rollout",
      phase: "final_answer",
      text: "same final answer",
      createdAt: "2026-05-16T10:00:00.500Z",
    }, { ORKESTR_HOME: home });

    const listed = await fetch(`${baseUrl}/api/threads/duplicate-api-thread/messages`);
    const payload = await listed.json();

    assert.equal(listed.status, 200);
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].text, "same final answer");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});

test("thread API creates worker threads", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-worker-api-"));
  const repo = await createTempGitRepo("orkestr-worker-api-repo-");
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fetch(`${baseUrl}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "worker-api-parent", name: "Worker API Parent", cwd: repo }),
    });
    const created = await fetch(`${baseUrl}/api/threads/worker-api-parent/workers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Worker API", task: "Build this in a worker.", autoRun: false, wake: false }),
    });
    const payload = await created.json();
    const listed = await fetch(`${baseUrl}/api/threads/worker-api-parent/workers`);
    const listPayload = await listed.json();
    const repoUpdate = await fetch(`${baseUrl}/api/threads/worker-api-parent/repo`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath: repo, branchName: "main" }),
    });
    const repoPayload = await repoUpdate.json();

    assert.equal(created.status, 201);
    assert.equal(payload.worker.parentThreadId, "worker-api-parent");
    assert.match(payload.worker.branchName, /^orkestr\/Worker-API-Parent\//);
    assert.equal(listPayload.workers.length, 1);
    assert.equal(repoUpdate.status, 200);
    assert.equal(repoPayload.thread.repoPath, repo);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});
