// Hermetic integration tests: a Claude Code turn stopped by Orkestr gets a
// visible kill notice with a partial-work summary; user interrupts do not.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLAUDE_CODE_TERMINATED_TURN_NOTICE } from "../packages/core/src/claude-code-client.js";
import { createLlmAccountProfile, updateLlmAccountProfileState } from "../packages/core/src/llm-account-profiles.js";
import {
  interruptClaudeCodeThread,
  resetClaudeCodeRuntimeForTest,
  sendClaudeCodeInput,
  startClaudeCodeThread,
} from "../packages/core/src/runtime-claude-code-adapter.js";
import { createThread, enqueueThreadInput, getThread, listThreadMessages } from "../packages/core/src/threads.js";

async function fixture(t, name) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-kill-${name}-`));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  t.after(async () => {
    resetClaudeCodeRuntimeForTest();
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const repo = path.join(home, "repo");
  const git = (...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, stdio: "pipe" });
  await fs.mkdir(repo);
  git("init", "-q", "-b", "main");
  await fs.writeFile(path.join(repo, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const calls = path.join(home, "calls.jsonl");
  const fake = path.join(home, "fake-claude.mjs");
  await fs.writeFile(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, prompt: prompt.trim() }) + "\\n");
  emit({ type: "system", subtype: "init", session_id: "claude_session_kill" });
  if (prompt.includes("long job")) {
    fs.writeFileSync(${JSON.stringify(path.join(repo, "a.txt"))}, "partial\\n");
    emit({ type: "assistant", session_id: "claude_session_kill", message: { content: [{ type: "text", text: "Launching the long build step now." }] } });
    emit({ type: "assistant", session_id: "claude_session_kill", message: { content: [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "cd ${repo} && sleep 100" } },
    ] } });
    setInterval(() => {}, 10_000);
    return;
  }
  emit({ type: "result", session_id: "claude_session_kill", result: "Resumed: " + prompt.trim(), is_error: false });
  process.exit(0);
});
`, { mode: 0o755 });
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "owner",
    ORKESTR_CLAUDE_CODE_ENABLED: "1",
    ORKESTR_CLAUDE_CODE_BIN: fake,
    ORKESTR_CLAUDE_CODE_LOGIN_TRANSPORT: "pipe",
    ORKESTR_CLAUDE_GRACE_PERIOD_MS: "200",
    ORKESTR_CLAUDE_SEMANTIC_INACTIVITY_MS: "30000",
    ORKESTR_CLAUDE_STALE_WORKING_MS: "30000",
    ORKESTR_CLAUDE_TOOL_DEADLINE_MS: "600",
    ORKESTR_CLAUDE_INTERIM_TEXT_MIN_INTERVAL_MS: "0",
  };
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: `Kill ${name}`, authMode: "subscription" }, env);
  await updateLlmAccountProfileState("owner", profile.id, "ready", { verified: true }, env);
  const created = await createThread({
    id: `kill-${name}`, name: `Kill ${name}`, ownerUserId: "owner", cwd: repo,
    executorId: "claude-code", runtimeKind: "claude-code",
    executor: { type: "claude-code", accountProfileId: profile.id, metadata: { accountProfileId: profile.id, runtimeKind: "claude-code" } },
  }, env);
  const thread = (await startClaudeCodeThread(created, env)).thread;
  return { env, thread, repo, calls };
}

function whatsappInput(text) {
  return { text, source: "whatsapp_inbound", connector: "whatsapp", accountId: "account-fixture", chatId: "chat-fixture", sourceEventId: `event-${text}` };
}

test("a tool-deadline kill appends a visible notice with partial work and resumes on continue", { timeout: 15_000 }, async (t) => {
  const { env, thread, repo, calls } = await fixture(t, "tool");
  const input = await enqueueThreadInput(thread.id, whatsappInput("long job"), env);
  await assert.rejects(sendClaudeCodeInput(thread, input, env), /claude_code_timeout/);

  const assistant = (await listThreadMessages(thread.id, env)).filter((message) => message.role === "assistant");
  assert.deepEqual(assistant.map((message) => message.phase), ["commentary", "commentary", "final_answer"]);
  assert.equal(assistant[1].text, "Launching the long build step now.");
  const notice = assistant[2];
  assert.equal(notice.connector, "whatsapp");
  assert.equal(notice.chatId, "chat-fixture");
  assert.equal(notice.parentMessageId, input.id);
  assert.match(notice.text, /per-tool time limit/);
  assert.match(notice.text, /Tool: Bash \(running /);
  assert.match(notice.text, new RegExp(`- ${(await fs.realpath(repo)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[main\\]: 1 changed file`));
  assert.equal(notice.text.includes("partial\n"), false, "file contents are never reported");
  assert.match(notice.text, /Reply "continue"/);

  const failed = await getThread(thread.id, env);
  assert.equal(failed.runtime.lastTurnTermination, "claude_code_tool_timeout");
  const next = await enqueueThreadInput(thread.id, whatsappInput("continue"), env);
  const resumed = await sendClaudeCodeInput(failed, next, env);
  assert.equal(resumed.assistant.text, "Resumed: continue");
  const recorded = (await fs.readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
  const args = recorded.at(-1).args;
  assert.deepEqual(args.slice(-2), ["--resume", "claude_session_kill"]);
  assert.equal(args[args.indexOf("--append-system-prompt") + 1].endsWith(CLAUDE_CODE_TERMINATED_TURN_NOTICE), true);
});

test("a user interrupt of a long tool call produces no kill notice", { timeout: 15_000 }, async (t) => {
  const { env, thread } = await fixture(t, "interrupt");
  env.ORKESTR_CLAUDE_TOOL_DEADLINE_MS = "30000";
  const input = await enqueueThreadInput(thread.id, whatsappInput("long job"), env);
  const running = sendClaudeCodeInput(thread, input, env);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal((await interruptClaudeCodeThread(thread, env)).interrupted, true);
  const result = await running;
  assert.equal(result.interrupted, true);
  const finals = (await listThreadMessages(thread.id, env)).filter((message) => message.role === "assistant" && message.phase === "final_answer");
  assert.deepEqual(finals, []);
  assert.notEqual((await getThread(thread.id, env)).runtime.lastTurnTermination, "claude_code_tool_timeout");
});
