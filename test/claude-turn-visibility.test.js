// Hermetic unit tests for Claude Code turn visibility: sub-agent deadline
// exemption, interim-text mirroring, kill-notice text, partial-work summary.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { claudeCodeSubAgentTool, spawnSupervised } from "../packages/core/src/claude-code-supervised-process.js";
import { createClaudeCodeInterimTextMirror, normalizeClaudeCodeInterimText } from "../packages/core/src/claude-code-interim-text.js";
import { claudeCodeKillNoticeText, claudeCodeTerminationReason } from "../packages/core/src/claude-code-kill-notice.js";
import { createClaudeCodeWorkspaceTracker, summarizeClaudeCodePartialWork } from "../packages/core/src/claude-code-partial-work.js";
import {
  CLAUDE_CODE_FAILED_TURN_NOTICE,
  CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE,
  CLAUDE_CODE_TERMINATED_TURN_NOTICE,
  claudeCodeArgs,
} from "../packages/core/src/claude-code-client.js";

async function superviseScript(t, body, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-visibility-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "fake.mjs");
  await fs.writeFile(script, `const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");\n${body}`);
  const timeouts = [];
  const supervisor = spawnSupervised({
    command: process.execPath, args: [script], cwd: dir,
    env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    attemptId: "visibility-test", gracePeriodMs: 200,
    semanticInactivityMs: 30_000, staleWorkingMs: 30_000,
    onToolTimeout: (info) => timeouts.push(info),
    ...options,
  });
  t.after(() => { if (!supervisor.settled) supervisor.terminate("test_cleanup"); });
  readline.createInterface({ input: supervisor.proc.stdout }).on("line", (line) => {
    try { supervisor.observeEvent(JSON.parse(line)); } catch {}
  });
  supervisor.proc.stderr.resume();
  await new Promise((resolve) => supervisor.proc.once("exit", resolve));
  supervisor.markSettled();
  return { supervisor, timeouts };
}

const agentUse = (id) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Agent", input: { prompt: "implement" } }] } });
const nestedUse = (id, parent, name = "Bash") => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name, input: {} }] } });

test("sub-agent tool names are recognized", () => {
  assert.equal(claudeCodeSubAgentTool("Agent"), true);
  assert.equal(claudeCodeSubAgentTool("Task"), true);
  assert.equal(claudeCodeSubAgentTool("Bash"), false);
});

test("a long Agent call with nested activity is exempt from the per-tool deadline", { timeout: 5_000 }, async (t) => {
  const { supervisor, timeouts } = await superviseScript(t, `
emit(${JSON.stringify(agentUse("a1"))});
let n = 0;
const tick = setInterval(() => {
  n += 1;
  emit({ type: "assistant", parent_tool_use_id: "a1", message: { content: [{ type: "tool_use", id: "n" + n, name: "Bash", input: {} }] } });
  emit({ type: "user", parent_tool_use_id: "a1", message: { content: [{ type: "tool_result", tool_use_id: "n" + n, content: "ok" }] } });
}, 100);
setTimeout(() => { clearInterval(tick); emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "done" }] } }); process.exit(0); }, 900);
`, { toolDeadlineMs: 300 });
  assert.deepEqual(timeouts, []);
  assert.equal(supervisor.failureCode, null);
});

test("a stuck nested tool inside an Agent still trips its own deadline", { timeout: 5_000 }, async (t) => {
  const { supervisor, timeouts } = await superviseScript(t, `
emit(${JSON.stringify(agentUse("a1"))});
setTimeout(() => emit(${JSON.stringify(nestedUse("n1", "a1"))}), 150);
setInterval(() => {}, 10_000);
`, { toolDeadlineMs: 300 });
  assert.equal(supervisor.failureCode, "claude_code_tool_timeout");
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].toolName, "Bash");
  assert.deepEqual(supervisor.toolTimeout, timeouts[0]);
});

test("an explicit Agent deadline applies when configured", { timeout: 5_000 }, async (t) => {
  const { supervisor, timeouts } = await superviseScript(t, `
emit(${JSON.stringify(agentUse("a1"))});
setInterval(() => {}, 10_000);
`, { toolDeadlineMs: 60_000, agentToolDeadlineMs: 300 });
  assert.equal(supervisor.failureCode, "claude_code_tool_timeout");
  assert.equal(timeouts[0].toolName, "Agent");
});

test("finishing an Agent drops leftover nested tools and re-emitted tool_use keeps its clock", { timeout: 5_000 }, async (t) => {
  const finished = await superviseScript(t, `
emit(${JSON.stringify(agentUse("a1"))});
emit(${JSON.stringify(nestedUse("n1", "a1"))});
setTimeout(() => emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "done" }] } }), 100);
setTimeout(() => process.exit(0), 700);
`, { toolDeadlineMs: 400 });
  assert.deepEqual(finished.timeouts, []);

  const reemitted = await superviseScript(t, `
const use = { type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: {} }] } };
emit(use);
setTimeout(() => emit(use), 250);
setTimeout(() => process.exit(0), 600);
`, { toolDeadlineMs: 400 });
  assert.equal(reemitted.timeouts.length, 1, "deadline counts from the first tool_use");
});

function fakeClock() {
  let now = 1_000_000;
  return { now: () => now, advance(ms) { now += ms; } };
}

const textEvent = (text, extra = {}) => ({ type: "assistant", ...extra, message: { content: [{ type: "text", text }] } });
const toolEvent = (name = "Bash", extra = {}) => ({ type: "assistant", ...extra, message: { content: [{ type: "tool_use", id: `t-${Math.random()}`, name, input: {} }] } });

test("interim text is released only after a tool call, deduplicated, and never duplicates the final answer", () => {
  const published = [];
  const clock = fakeClock();
  const mirror = createClaudeCodeInterimTextMirror({ publish: (text) => published.push(text), now: clock.now, env: {} });
  assert.equal(mirror.observe(textEvent("  Launching both implementations   in parallel.  ")), true);
  assert.deepEqual(published, [], "text is held until a tool call proves it is not final");
  mirror.observe(toolEvent("Agent"));
  assert.deepEqual(published, ["Launching both implementations in parallel."]);
  clock.advance(60_000);
  mirror.observe(textEvent("Launching both implementations in parallel."));
  mirror.observe(toolEvent());
  assert.equal(published.length, 1, "duplicate text is not republished");
  mirror.observe(textEvent("Both tickets are implemented."));
  mirror.observe({ type: "result", result: "Both tickets are implemented." });
  mirror.finish();
  assert.equal(published.length, 1, "trailing final text is never mirrored");
});

test("interim text is throttled with coalescing, capped, and ignores sub-agent narration", async () => {
  const published = [];
  const clock = fakeClock();
  const mirror = createClaudeCodeInterimTextMirror({
    publish: (text) => published.push(text), now: clock.now,
    env: { ORKESTR_CLAUDE_INTERIM_TEXT_MIN_INTERVAL_MS: "50" },
  });
  mirror.observe(textEvent("First step."));
  mirror.observe(toolEvent());
  mirror.observe(textEvent("Second step."));
  mirror.observe(toolEvent());
  mirror.observe(textEvent("Third step."));
  mirror.observe(toolEvent());
  mirror.observe(textEvent("sub-agent chatter", { parent_tool_use_id: "a1" }));
  mirror.observe(toolEvent("Bash", { parent_tool_use_id: "a1" }));
  assert.deepEqual(published, ["First step."]);
  clock.advance(50);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(published, ["First step.", "Second step.\n\nThird step."]);
  mirror.finish();

  const long = normalizeClaudeCodeInterimText("x".repeat(2_000));
  assert.equal(long.length, 600);
  assert.equal(long.endsWith("…"), true);
});

test("pending throttled interim text is dropped when the turn finishes", async () => {
  const published = [];
  const mirror = createClaudeCodeInterimTextMirror({ publish: (text) => published.push(text), env: { ORKESTR_CLAUDE_INTERIM_TEXT_MIN_INTERVAL_MS: "40" } });
  mirror.observe(textEvent("One."));
  mirror.observe(toolEvent());
  mirror.observe(textEvent("Two."));
  mirror.observe(toolEvent());
  mirror.finish();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(published, ["One."]);
});

test("termination reasons exclude user interrupts and unrelated failures", () => {
  for (const code of ["claude_code_tool_timeout", "claude_code_timeout", "claude_code_semantic_stall", "claude_code_output_limit"]) {
    assert.equal(claudeCodeTerminationReason({ code }), code);
  }
  assert.equal(claudeCodeTerminationReason({ code: "claude_code_tool_timeout", termination: { userInterrupted: true } }), "");
  assert.equal(claudeCodeTerminationReason({ code: "claude_code_rate_limited" }), "");
  assert.equal(claudeCodeTerminationReason({ code: "claude_code_interrupted" }), "");
});

test("kill notice states reason, tool, elapsed time, partial work, and how to continue", () => {
  const text = claudeCodeKillNoticeText({
    reason: "claude_code_tool_timeout", toolName: "Agent", toolElapsedMs: 600_000, turnElapsedMs: 725_000,
    partialWork: { repositories: [
      { path: "/work/repo-a", branch: "fix/one", changedFiles: 3 },
      { path: "/work/repo-b", branch: "main", changedFiles: 0 },
      { path: "/work/repo-c", branch: "HEAD", changedFiles: 1 },
    ] },
  });
  assert.match(text, /per-tool time limit/);
  assert.match(text, /Tool: Agent \(running 10m 0s\)\. Turn time: 12m 5s\./);
  assert.match(text, /- \/work\/repo-a \[fix\/one\]: 3 changed files/);
  assert.match(text, /- \/work\/repo-c: 1 changed file$/m);
  assert.equal(text.includes("repo-b"), false);
  assert.match(text, /Reply "continue"/);
  assert.match(claudeCodeKillNoticeText({ reason: "claude_code_semantic_stall", partialWork: { repositories: [] } }), /No uncommitted changes/);
  assert.match(claudeCodeKillNoticeText({ reason: "claude_code_timeout", partialWork: { repositories: [], timedOut: true } }), /timed out/);
});

test("workspace tracker and partial-work summary report only paths and changed-file counts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-partial-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "wt");
  const git = (...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, stdio: "pipe" });
  await fs.mkdir(repo);
  git("init", "-q", "-b", "main");
  await fs.writeFile(path.join(repo, "a.txt"), "secret-content-a\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("worktree", "add", "-q", "-b", "feature/x", worktree);
  await fs.writeFile(path.join(worktree, "a.txt"), "changed secret-content-b\n");
  await fs.writeFile(path.join(worktree, "new.txt"), "new\n");

  const tracker = createClaudeCodeWorkspaceTracker();
  tracker.observe({ type: "assistant", parent_tool_use_id: "a1", message: { content: [
    { type: "tool_use", name: "Bash", input: { command: `cd ${worktree} && npm test` } },
    { type: "tool_use", name: "Edit", input: { file_path: path.join(worktree, "a.txt") } },
  ] } });
  assert.equal(tracker.paths.includes(worktree), true);

  const summary = await summarizeClaudeCodePartialWork({ cwd: repo, paths: tracker.paths, timeoutMs: 5_000 });
  const byPath = Object.fromEntries(summary.repositories.map((entry) => [entry.path, entry]));
  const realWorktree = await fs.realpath(worktree);
  const realRepo = await fs.realpath(repo);
  assert.equal(byPath[realWorktree].changedFiles, 2);
  assert.equal(byPath[realWorktree].branch, "feature/x");
  assert.equal(byPath[realRepo].changedFiles, 0);
  assert.equal(JSON.stringify(summary).includes("secret-content"), false);
});

test("standing notice asks for pacing and a final summary; terminated turns get a resumable notice", () => {
  assert.match(CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE, /never request run_in_background/);
  assert.match(CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE, /one-line progress update/);
  assert.match(CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE, /tool call and sub-agent task short/);
  assert.match(CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE, /finish one coherent phase, report it/);
  assert.match(CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE, /what is partial \(with branch and worktree paths\)/);
  const prompt = (thread, options) => {
    const args = claudeCodeArgs(thread, { sessionId: "s1", ...options }, {});
    return args[args.indexOf("--append-system-prompt") + 1];
  };
  const terminated = { runtime: { lastTurnStatus: "failed", lastTurnTermination: "claude_code_tool_timeout" } };
  assert.equal(prompt(terminated, { priorTurnFailed: true }), `${CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE}\n\n${CLAUDE_CODE_TERMINATED_TURN_NOTICE}`);
  assert.equal(prompt({}, { priorTurnFailed: true }), `${CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE}\n\n${CLAUDE_CODE_FAILED_TURN_NOTICE}`);
  assert.equal(prompt(terminated, {}), CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE);
});
