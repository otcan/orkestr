import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { listEvents } from "../packages/storage/src/store.js";
import { codexInputText, isCodexRuntimeThread } from "../packages/core/src/codex-app-server-common.js";
import { CodexAppServerClient } from "../packages/core/src/codex-app-server-client.js";
import { getClaudeCodeSession, setClaudeCodeSession } from "../packages/core/src/claude-code-sessions.js";
import { claimExecutorHandoffForMessage } from "../packages/core/src/executor-handoff-delivery.js";
import { createLlmAccountProfile, updateLlmAccountProfileState } from "../packages/core/src/llm-account-profiles.js";
import {
  hasActiveClaudeCodeSupervisor,
  interruptClaudeCodeThread,
  resetClaudeCodeRuntimeForTest,
  sendClaudeCodeInput,
  setClaudeCodeDeliveryScheduler,
  startClaudeCodeThread,
  threadUsesClaudeCode,
} from "../packages/core/src/runtime-claude-code-adapter.js";
import { createThreadWorker } from "../packages/core/src/thread-workers.js";
import {
  applyPendingExecutorSwitch,
  setExecutorSwitchRuntimeForTest,
  switchThreadExecutor,
  threadExecutorSummary,
} from "../packages/core/src/thread-executor-switch.js";
import { createThread, enqueueThreadInput, getThread, getThreadMessage, updateThread, updateThreadMessage } from "../packages/core/src/threads.js";

const execFileAsync = promisify(execFile);
// Turns are driven explicitly; never let a background scheduler pick up inputs.
setClaudeCodeDeliveryScheduler(() => {});
const OLD_CODEX_ID = "codex-generation-old";

async function fixture(t, name) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-executor-switch-${name}-`));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const fake = path.join(home, "fake-claude.mjs");
  const calls = path.join(home, "calls.jsonl");
  const delayFile = path.join(home, "delay-ms");
  await fs.writeFile(delayFile, "0", "utf8");
  await fs.writeFile(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", () => {
  const resumeAt = args.indexOf("--resume");
  const session = resumeAt >= 0 ? args[resumeAt + 1] : "claude_session_fixture";
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, prompt: prompt.trim() }) + "\\n");
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: session }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", session_id: session, result: "Done", is_error: false }) + "\\n");
  }, Number(fs.readFileSync(${JSON.stringify(delayFile)}, "utf8") || 0));
});
`, { mode: 0o755 });
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_CLAUDE_CODE_ENABLED: "1",
    ORKESTR_CLAUDE_CODE_BIN: fake,
    ORKESTR_EXECUTOR_HANDOFF_GIT_TIMEOUT_MS: "2000",
  };
  t.after(async () => {
    resetClaudeCodeRuntimeForTest();
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { home, calls, delayFile, env };
}

async function readyProfile(env, label = "Primary") {
  const created = await createLlmAccountProfile("admin", { provider: "claude-code", label, authMode: "subscription" }, env);
  await updateLlmAccountProfileState("admin", created.id, "ready", { verified: true }, env);
  return created;
}

async function codexThread(id, env, extra = {}) {
  return createThread({
    id,
    name: id,
    ownerUserId: "admin",
    runtimeKind: "codex-app-server",
    executorId: "codex",
    codexThreadId: OLD_CODEX_ID,
    codexSessionId: OLD_CODEX_ID,
    codexModel: "gpt-test",
    codexReasoningEffort: "high",
    codexRolloutPath: "/tmp/rollout-old.jsonl",
    executor: {
      id: "codex",
      type: "codex",
      transport: "app-server",
      codexThreadId: OLD_CODEX_ID,
      codexSessionId: OLD_CODEX_ID,
      metadata: { runtimeKind: "codex-app-server", transport: "app-server", codexThreadId: OLD_CODEX_ID, codexModel: "gpt-test", codexRolloutPath: "/tmp/rollout-old.jsonl" },
    },
    runtime: { runtimeKind: "codex-app-server", state: "ready", codexThreadId: OLD_CODEX_ID, runtimeGeneration: OLD_CODEX_ID, operatorRolloutPath: "/tmp/rollout-old.jsonl" },
    ...extra,
  }, env);
}

function fakeRuntime(overrides = {}) {
  const calls = [];
  const runtime = {
    calls,
    startClaude: async (thread, env) => {
      calls.push({ op: "startClaude", thread });
      return startClaudeCodeThread(thread, env);
    },
    startCodex: async (thread, env) => {
      calls.push({ op: "startCodex", thread });
      const updated = await updateThread(thread.id, { codexThreadId: "codex-generation-new", executor: { codexThreadId: "codex-generation-new" } }, env);
      return { thread: updated };
    },
    resumeCodex: async (thread) => {
      calls.push({ op: "resumeCodex", thread });
      return { thread };
    },
    interruptCodex: async () => ({ interrupted: false }),
    interruptClaude: interruptClaudeCodeThread,
    claudeTurnActive: hasActiveClaudeCodeSupervisor,
    requestDelivery: () => {},
    ...overrides,
  };
  return runtime;
}

function deepKeys(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => [`${prefix}${key}`, ...deepKeys(entry, `${prefix}${key}.`)]);
}

test("switching Codex to Claude removes every stale Codex routing field and writes a neutral handoff", async (t) => {
  const { env } = await fixture(t, "to-claude");
  const profile = await readyProfile(env);
  await codexThread("switch-to-claude", env);
  const runtime = fakeRuntime();
  const result = await switchThreadExecutor("switch-to-claude", "claude", { runtime, model: "opus", actor: "owner", reason: "use claude quota" }, env);
  const thread = await getThread("switch-to-claude", env);

  assert.equal(result.changed, true);
  assert.equal(result.from, "codex");
  assert.equal(result.to, "claude-code");
  assert.equal(threadUsesClaudeCode(thread), true);
  assert.equal(isCodexRuntimeThread(thread), false);
  const live = { ...thread };
  delete live.executorStates;
  delete live.pendingExecutorHandoff;
  assert.equal(JSON.stringify(live).includes(OLD_CODEX_ID), false, JSON.stringify(live));
  assert.equal(deepKeys(live).some((key) => /codex(ThreadId|SessionId|Rollout|Model|ReasoningEffort)|operatorRollout|runtimeGeneration/.test(key)), false);
  assert.equal(thread.executor.accountProfileId, profile.id);
  assert.equal(thread.claudeModel, "opus");
  assert.equal(thread.executorStates.codex.codexThreadId, OLD_CODEX_ID);
  assert.equal(thread.executorStates.codex.codexModel, "gpt-test");
  assert.equal(thread.executorStates.codex.codexRolloutPath, "/tmp/rollout-old.jsonl");
  assert.ok(thread.claudeSystemPolicyRevision);

  const handoff = await fs.readFile(thread.pendingExecutorHandoff.path, "utf8");
  assert.match(handoff, /same owner and the same authority/);
  assert.match(handoff, /The previous executor was Codex/);
  assert.match(handoff, /primary agent for this Orkestr thread/);
  assert.doesNotMatch(handoff, /worker thread/i);

  const events = (await listEvents(env)).filter((event) => event.type === "thread_executor_switched");
  assert.equal(events.length, 1);
  assert.deepEqual(
    { from: events[0].from, to: events[0].to, actor: events[0].actor, reason: events[0].reason, when: events[0].when },
    { from: "codex", to: "claude-code", actor: "owner", reason: "use claude quota", when: "after_turn" },
  );
  assert.equal(threadExecutorSummary(thread).executor, "claude-code");
});

test("round trip restores the previous Codex thread and Claude profile/model and removes Claude state", async (t) => {
  const { env } = await fixture(t, "round-trip");
  const profile = await readyProfile(env);
  await codexThread("round-trip", env);
  const runtime = fakeRuntime();
  await switchThreadExecutor("round-trip", "claude", { runtime, model: "opus", effort: "max" }, env);
  const asClaude = await getThread("round-trip", env);
  await setClaudeCodeSession(asClaude, "claude-session-1", env);
  assert.equal(await getClaudeCodeSession(asClaude, env), "claude-session-1");

  const back = await switchThreadExecutor("round-trip", "codex", { runtime }, env);
  const asCodex = await getThread("round-trip", env);
  assert.equal(back.changed, true);
  assert.equal(threadUsesClaudeCode(asCodex), false);
  assert.equal(isCodexRuntimeThread(asCodex), true);
  assert.equal(asCodex.codexThreadId, OLD_CODEX_ID);
  assert.equal(asCodex.executor.codexThreadId, OLD_CODEX_ID);
  assert.equal(asCodex.runtime.codexThreadId, OLD_CODEX_ID);
  assert.equal(asCodex.codexModel, "gpt-test");
  assert.equal(asCodex.executor.accountProfileId, undefined);
  assert.equal(asCodex.executor.metadata.accountProfileId, undefined);
  assert.equal(asCodex.claudeModel, undefined);
  assert.equal(asCodex.executor.metadata.claudePermissionMode, undefined);
  assert.equal(asCodex.executorStates["claude-code"].accountProfileId, profile.id);
  assert.equal(asCodex.executorStates["claude-code"].claudeModel, "opus");
  assert.equal(runtime.calls.at(-1).op, "resumeCodex");
  assert.equal(runtime.calls.at(-1).thread.codexThreadId, OLD_CODEX_ID);
  const resumedHandoff = await fs.readFile(asCodex.pendingExecutorHandoff.path, "utf8");
  assert.match(resumedHandoff, /Messages Since Codex Last Ran/);
  // Leaving Claude drops the session binding.
  assert.equal(await getClaudeCodeSession(asClaude, env), "");

  await switchThreadExecutor("round-trip", "claude", { runtime }, env);
  const again = await getThread("round-trip", env);
  assert.equal(again.executor.accountProfileId, profile.id);
  assert.equal(again.claudeModel, "opus");
  assert.equal(again.claudeEffort, "max");
  assert.notEqual(again.claudeSystemPolicyRevision, asClaude.claudeSystemPolicyRevision);
  assert.equal(await getClaudeCodeSession(again, env), "");
});

test("a failed target start rolls the thread back to its previous executor", async (t) => {
  const { env } = await fixture(t, "rollback");
  await readyProfile(env);
  const before = await codexThread("rollback", env);
  const runtime = fakeRuntime({ startClaude: async () => { throw Object.assign(new Error("claude_boot_failed"), { statusCode: 503 }); } });
  await assert.rejects(
    switchThreadExecutor("rollback", "claude", { runtime }, env),
    (error) => error.code === "executor_switch_start_failed" && error.rolledBack === true && error.statusCode === 503,
  );
  const after = await getThread("rollback", env);
  for (const key of ["executor", "runtime", "runtimeKind", "codexThreadId", "codexSessionId", "codexModel", "codexRolloutPath", "claudeSystemPolicyRevision"]) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.equal(after.executorStates, undefined);
  assert.equal(after.pendingExecutorHandoff, undefined);
  assert.equal(isCodexRuntimeThread(after), true);
  const failed = (await listEvents(env)).find((event) => event.type === "thread_executor_switch_failed");
  assert.equal(failed.rolledBack, true);
});

test("Claude target requires an admin principal, an allowed model and a ready profile", async (t) => {
  const { env } = await fixture(t, "validation");
  await codexThread("validation", env);
  const runtime = fakeRuntime();
  await assert.rejects(switchThreadExecutor("validation", "claude", { runtime }, env), (error) => error.code === "llm_account_profile_required");
  await readyProfile(env);
  await assert.rejects(
    switchThreadExecutor("validation", "claude", { runtime, principal: { userId: "someone", role: "user" } }, env),
    (error) => error.code === "claude_code_admin_runtime_required" && error.statusCode === 403,
  );
  await assert.rejects(
    switchThreadExecutor("validation", "claude", { runtime, model: "opus" }, { ...env, ORKESTR_CLAUDE_CODE_MODELS: "sonnet" }),
    (error) => error.code === "claude_model_unsupported",
  );
  await assert.rejects(switchThreadExecutor("validation", "gemini", { runtime }, env), (error) => error.code === "executor_target_invalid");
  assert.equal(isCodexRuntimeThread(await getThread("validation", env)), true);
});

test("handoff is delivered once as the preamble of the next Claude turn", async (t) => {
  const { env, calls } = await fixture(t, "handoff-turn");
  await readyProfile(env);
  await codexThread("handoff-turn", env);
  await switchThreadExecutor("handoff-turn", "claude", { runtime: fakeRuntime() }, env);

  const wrongExecutor = await enqueueThreadInput("handoff-turn", { text: "noop", source: "test" }, env);
  const untouched = await claimExecutorHandoffForMessage("handoff-turn", wrongExecutor, "codex", env);
  assert.equal(untouched.executorHandoffPreamble, undefined);
  await updateThreadMessage("handoff-turn", wrongExecutor.id, { state: "completed", deliveryState: "delivered" }, env);

  const first = await enqueueThreadInput("handoff-turn", { text: "first after switch", source: "test" }, env);
  await sendClaudeCodeInput(await getThread("handoff-turn", env), first, env);
  const second = await enqueueThreadInput("handoff-turn", { text: "second after switch", source: "test" }, env);
  await sendClaudeCodeInput(await getThread("handoff-turn", env), second, env);

  const prompts = (await fs.readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line).prompt);
  assert.match(prompts[0], /Orkestr executor handoff, delivered once/);
  assert.match(prompts[0], /You \(Claude Code\) are now the active agent for this thread/);
  assert.match(prompts[0], /first after switch$/);
  assert.doesNotMatch(prompts[1], /executor handoff/);
  const thread = await getThread("handoff-turn", env);
  assert.equal(thread.pendingExecutorHandoff, undefined);
  assert.equal(thread.lastExecutorHandoff.messageId, first.id);
  const stored = await getThreadMessage("handoff-turn", first.id, env);
  assert.equal(codexInputText(stored).startsWith("[Orkestr executor handoff"), true);
});

test("after_turn switch waits for the active Claude turn and applies at completion", async (t) => {
  const { env, delayFile } = await fixture(t, "after-turn");
  await readyProfile(env);
  await codexThread("after-turn", env);
  const runtime = fakeRuntime();
  t.after(setExecutorSwitchRuntimeForTest(runtime));
  await switchThreadExecutor("after-turn", "claude", { runtime }, env);
  await fs.writeFile(delayFile, "400", "utf8");
  const message = await enqueueThreadInput("after-turn", { text: "long running turn", source: "test" }, env);
  const turn = sendClaudeCodeInput(await getThread("after-turn", env), message, env);
  for (let index = 0; index < 100 && !hasActiveClaudeCodeSupervisor("after-turn"); index += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hasActiveClaudeCodeSupervisor("after-turn"), true);

  const deferred = await switchThreadExecutor("after-turn", "codex", { runtime, when: "after_turn" }, env);
  assert.equal(deferred.deferred, true);
  assert.equal((await getThread("after-turn", env)).pendingExecutorSwitch.target, "codex");
  assert.equal(threadUsesClaudeCode(await getThread("after-turn", env)), true);

  await turn;
  const after = await getThread("after-turn", env);
  assert.equal(threadUsesClaudeCode(after), false);
  assert.equal(after.codexThreadId, OLD_CODEX_ID);
  assert.equal(after.pendingExecutorSwitch, undefined);
  assert.equal(after.lastExecutorSwitch.when, "after_turn");
  assert.equal(await applyPendingExecutorSwitch("after-turn", { runtime }, env), null);
});

test("when=now interrupts the active Claude turn before switching", async (t) => {
  const { env, delayFile } = await fixture(t, "now");
  await readyProfile(env);
  await codexThread("switch-now", env);
  const runtime = fakeRuntime();
  t.after(setExecutorSwitchRuntimeForTest(runtime));
  await switchThreadExecutor("switch-now", "claude", { runtime }, env);
  await fs.writeFile(delayFile, "5000", "utf8");
  const message = await enqueueThreadInput("switch-now", { text: "very long turn", source: "test" }, env);
  const turn = sendClaudeCodeInput(await getThread("switch-now", env), message, env).catch((error) => error);
  for (let index = 0; index < 100 && !hasActiveClaudeCodeSupervisor("switch-now"); index += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await switchThreadExecutor("switch-now", "codex", { runtime, when: "now" }, env);
  await turn;
  assert.equal(result.changed, true, JSON.stringify(result));
  const after = await getThread("switch-now", env);
  assert.equal(threadUsesClaudeCode(after), false);
  assert.equal(after.executor.id, "codex");
  assert.equal(isCodexRuntimeThread(after), true);
});

test("agent self-switch is always deferred to after the turn and rate limited", async (t) => {
  const { env } = await fixture(t, "self");
  await readyProfile(env);
  await codexThread("self-switch", env);
  const runtime = fakeRuntime();
  const limited = { ...env, ORKESTR_EXECUTOR_SELF_SWITCH_INTERVAL_MS: "600000" };
  await updateThread("self-switch", { state: "working", runtime: { runtimeKind: "codex-app-server", state: "working", activeTurnId: "turn-1", codexThreadId: OLD_CODEX_ID } }, env);
  await assert.rejects(
    switchThreadExecutor("self-switch", "claude", { runtime, actor: "self" }, limited),
    (error) => error.code === "executor_self_switch_reason_required",
  );
  const first = await switchThreadExecutor("self-switch", "claude", { runtime, actor: "self", when: "now", reason: "needs a different model" }, limited);
  assert.equal(first.deferred, true);
  assert.equal((await getThread("self-switch", env)).pendingExecutorSwitch.when, "after_turn");
  await assert.rejects(
    switchThreadExecutor("self-switch", "claude", { runtime, actor: "self", reason: "again" }, limited),
    (error) => error.code === "executor_self_switch_rate_limited" && error.statusCode === 429,
  );
  await updateThread("self-switch", { state: "ready", runtime: { runtimeKind: "codex-app-server", state: "ready", activeTurnId: null, codexThreadId: OLD_CODEX_ID } }, env);
  const applied = await applyPendingExecutorSwitch("self-switch", { runtime }, env);
  assert.equal(applied.changed, true);
  assert.equal(threadUsesClaudeCode(await getThread("self-switch", env)), true);
  const event = (await listEvents(env)).find((entry) => entry.type === "thread_executor_switched");
  assert.equal(event.actor, "self");
});

test("workers copy the parent's current executor after a switch", async (t) => {
  const { env } = await fixture(t, "worker");
  const profile = await readyProfile(env);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-executor-switch-repo-"));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "initial"], { cwd: repo });
  await codexThread("worker-parent", env, { cwd: repo, workspace: repo });
  await switchThreadExecutor("worker-parent", "claude", { runtime: fakeRuntime(), model: "opus" }, env);
  const { worker } = await createThreadWorker("worker-parent", { label: "Switch Worker" }, env);
  t.after(() => fs.rm(worker.worktreePath, { recursive: true, force: true }));
  assert.equal(threadUsesClaudeCode(worker), true);
  assert.equal(isCodexRuntimeThread(worker), false);
  assert.equal(worker.executor.metadata.accountProfileId, profile.id);
  assert.equal(worker.executor.metadata.claudeModel, "opus");

  const handoffRole = await switchThreadExecutor(worker.id, "codex", { runtime: fakeRuntime() }, env);
  const handoff = await fs.readFile(handoffRole.handoffPath, "utf8");
  assert.match(handoff, /Role: worker thread/);
  assert.match(handoff, /Parent Orkestr thread: worker-parent/);
});

test("a deferred switch is applied from the Codex app-server turn completion", async (t) => {
  const { env, home } = await fixture(t, "codex-completion");
  await readyProfile(env);
  await codexThread("codex-completion", env, {
    state: "working",
    runtime: { runtimeKind: "codex-app-server", state: "working", activeTurnId: "turn-9", codexThreadId: OLD_CODEX_ID, runtimeGeneration: OLD_CODEX_ID },
  });
  const runtime = fakeRuntime();
  t.after(setExecutorSwitchRuntimeForTest(runtime));
  const deferred = await switchThreadExecutor("codex-completion", "claude", { runtime, model: "sonnet" }, env);
  assert.equal(deferred.deferred, true);

  const client = new CodexAppServerClient({ env, home });
  client.request = async () => ({ thread: { id: OLD_CODEX_ID, status: { type: "idle" }, turns: [{ id: "turn-9", status: "completed", items: [] }] } });
  await client.handleNotification({
    method: "turn/completed",
    params: { turn: { id: "turn-9", threadId: OLD_CODEX_ID, status: "completed" } },
  });
  const after = await getThread("codex-completion", env);
  assert.equal(threadUsesClaudeCode(after), true);
  assert.equal(isCodexRuntimeThread(after), false);
  assert.equal(after.claudeModel, "sonnet");
  assert.equal(after.pendingExecutorSwitch, undefined);
  assert.equal(after.executorStates.codex.codexThreadId, OLD_CODEX_ID);
});
