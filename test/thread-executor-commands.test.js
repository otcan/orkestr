import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { runCli } from "../apps/cli/src/commands.js";
import { executeSettingsCommand } from "../packages/core/src/codex-settings-command-control.js";
import { createLlmAccountProfile, updateLlmAccountProfileState } from "../packages/core/src/llm-account-profiles.js";
import { threadUsesClaudeCode } from "../packages/core/src/claude-code-runtime-policy.js";
import { parseThreadInputCommand } from "../packages/core/src/thread-commands.js";
import { parseExecutorCommandText, processQueuedExecutorCommands } from "../packages/core/src/thread-executor-commands.js";
import { createThread, enqueueThreadInput, getThread, getThreadMessage, listThreadMessages, updateThread } from "../packages/core/src/threads.js";

async function tempHome(t, name) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-executor-commands-${name}-`));
  const prior = { home: process.env.ORKESTR_HOME, claude: process.env.ORKESTR_CLAUDE_CODE_ENABLED, recover: process.env.ORKESTR_RECOVER_RUNNING_ON_START };
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_CLAUDE_CODE_ENABLED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  t.after(async () => {
    for (const [key, value] of [["ORKESTR_HOME", prior.home], ["ORKESTR_CLAUDE_CODE_ENABLED", prior.claude], ["ORKESTR_RECOVER_RUNNING_ON_START", prior.recover]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { home, env: { ...process.env, ORKESTR_HOME: home } };
}

async function readyProfile(env) {
  const created = await createLlmAccountProfile("admin", { provider: "claude-code", label: "Primary", authMode: "subscription" }, env);
  await updateLlmAccountProfileState("admin", created.id, "ready", { verified: true }, env);
  return created;
}

function codexThreadInput(id) {
  return {
    id,
    name: id,
    ownerUserId: "admin",
    runtimeKind: "codex-app-server",
    executorId: "codex",
    codexThreadId: `${id}-codex`,
    executor: { id: "codex", type: "codex", transport: "app-server", codexThreadId: `${id}-codex`, metadata: { runtimeKind: "codex-app-server", transport: "app-server" } },
    runtime: { runtimeKind: "codex-app-server", state: "ready", codexThreadId: `${id}-codex` },
  };
}

const idleRuntime = {
  startClaude: async (thread) => ({ thread }),
  startCodex: async (thread) => ({ thread }),
  resumeCodex: async (thread) => ({ thread }),
  interruptClaude: async () => ({ interrupted: false }),
  interruptCodex: async () => ({ interrupted: false }),
  claudeTurnActive: () => false,
  requestDelivery: () => {},
};

test("executor commands parse /agent, /claude and /codex while /agent api keeps the runtime surface meaning", () => {
  assert.deepEqual(parseThreadInputCommand({ text: "/agent" }), { command: "executor", rawCommand: "agent", text: "" });
  assert.deepEqual(parseThreadInputCommand({ text: "/agent claude opus" }), { command: "executor", rawCommand: "agent", text: "claude opus" });
  assert.deepEqual(parseThreadInputCommand({ text: "/claude" }), { command: "executor", rawCommand: "claude", text: "claude" });
  assert.deepEqual(parseThreadInputCommand({ text: "/codex gpt-test now" }), { command: "executor", rawCommand: "codex", text: "codex gpt-test now" });
  assert.deepEqual(parseThreadInputCommand({ text: "/agent api" }), { command: "runtime_type", rawCommand: "agent", text: "api" });
  assert.equal(parseThreadInputCommand({ text: "/claude", commandProcessing: "disabled" }).command, null);
  assert.deepEqual(parseExecutorCommandText(""), { action: "show" });
  assert.deepEqual(parseExecutorCommandText("codex gpt-test now"), { action: "switch", target: "codex", model: "gpt-test", effort: "", when: "now" });
  assert.deepEqual(parseExecutorCommandText("claude opus high"), { action: "switch", target: "claude-code", model: "opus", effort: "high", when: "after_turn" });
  assert.deepEqual(parseExecutorCommandText("gemini"), { action: "invalid" });
});

test("queued chat executor commands are answered before any executor sees them", async (t) => {
  const { env } = await tempHome(t, "queued");
  await readyProfile(env);
  await createThread(codexThreadInput("queued-commands"), env);
  const show = await enqueueThreadInput("queued-commands", { text: "/agent", source: "test" }, env);
  const denied = await enqueueThreadInput("queued-commands", {
    text: "/claude", source: "whatsapp_inbound", connector: "whatsapp", chatId: "group-1@g.us", accountId: "wa-1", senderEffectiveRole: "guest",
  }, env);
  const handled = await processQueuedExecutorCommands(await getThread("queued-commands", env), env, { runtime: idleRuntime });
  assert.deepEqual(handled, [show.id, denied.id]);
  assert.equal((await getThreadMessage("queued-commands", show.id, env)).state, "completed");
  assert.equal((await getThreadMessage("queued-commands", denied.id, env)).state, "failed");
  assert.equal(threadUsesClaudeCode(await getThread("queued-commands", env)), false);

  const switchMessage = await enqueueThreadInput("queued-commands", {
    text: "/claude opus", source: "whatsapp_inbound", connector: "whatsapp", chatId: "group-1@g.us", accountId: "wa-1", senderEffectiveRole: "owner",
  }, env);
  await processQueuedExecutorCommands(await getThread("queued-commands", env), env, { runtime: idleRuntime });
  const thread = await getThread("queued-commands", env);
  assert.equal(threadUsesClaudeCode(thread), true);
  assert.equal(thread.claudeModel, "opus");
  const replies = (await listThreadMessages("queued-commands", env)).filter((message) => message.role === "assistant");
  assert.match(replies[0].text, /Active executor: Codex/);
  assert.match(replies[1].text, /Only the thread owner/);
  const switchReply = replies.find((message) => message.parentMessageId === switchMessage.id);
  assert.match(switchReply.text, /Executor switched to Claude Code \(model opus\)/);
  assert.equal(switchReply.connector, "whatsapp");
  assert.equal(switchReply.chatId, "group-1@g.us");
});

test("/model and /effort set Claude settings on Claude threads while /fast stays Codex-only", async (t) => {
  const { env } = await tempHome(t, "settings");
  const profile = await readyProfile(env);
  await createThread({
    id: "claude-settings",
    name: "claude-settings",
    ownerUserId: "admin",
    runtimeKind: "claude-code",
    executorId: "claude-code",
    executor: { id: "claude-code", type: "claude-code", metadata: { runtimeKind: "claude-code", accountProfileId: profile.id } },
  }, env);
  const principal = { userId: "admin", role: "admin" };
  const thread = await getThread("claude-settings", env);
  const model = await executeSettingsCommand({ thread, text: "/model opus", principal, surface: "webui", sourceOperationKey: "a".repeat(64) }, env);
  assert.equal(model.ok, true, JSON.stringify(model));
  const effort = await executeSettingsCommand({ thread, text: "/effort max", principal, surface: "webui", sourceOperationKey: "b".repeat(64) }, env);
  assert.equal(effort.ok, true);
  const updated = await getThread("claude-settings", env);
  assert.equal(updated.claudeModel, "opus");
  assert.equal(updated.executor.metadata.claudeEffort, "max");
  const fast = await executeSettingsCommand({ thread, text: "/fast on", principal, surface: "webui", sourceOperationKey: "c".repeat(64) }, env);
  assert.equal(fast.ok, false);
  assert.match(fast.replyText, /Codex-only/);
  const restricted = await executeSettingsCommand({ thread, text: "/model opus", principal, surface: "webui", sourceOperationKey: "d".repeat(64) }, { ...env, ORKESTR_CLAUDE_CODE_MODELS: "sonnet" });
  assert.equal(restricted.ok, false);
  assert.match(restricted.replyText, /not available/);
});

test("executor API reads and switches the executor; surface switches are rejected on Claude threads", async (t) => {
  const { env } = await tempHome(t, "api");
  const profile = await readyProfile(env);
  await createThread(codexThreadInput("api-executor"), env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/threads/api-executor`;
  const json = async (url, options = {}) => {
    const response = await fetch(url, { headers: { "content-type": "application/json" }, ...options });
    return { status: response.status, body: await response.json() };
  };

  const initial = await json(`${base}/executor`);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.executor.executor, "codex");

  const invalid = await json(`${base}/executor`, { method: "PUT", body: JSON.stringify({ executor: "gemini" }) });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, "executor_target_invalid");

  const switched = await json(`${base}/executor`, { method: "PUT", body: JSON.stringify({ executor: "claude", model: "opus", reason: "quota" }) });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(switched.body.changed, true);
  assert.equal(switched.body.executor.executor, "claude-code");
  assert.equal(switched.body.executor.profileId, profile.id);
  assert.equal(switched.body.executor.executorStates.codex.codexThreadId, "api-executor-codex");
  assert.match(switched.body.replyText, /Executor switched to Claude Code \(model opus\)/);

  const surface = await json(`${base}/input`, { method: "POST", body: JSON.stringify({ text: "/switch api", source: "test", parseCommands: true }) });
  assert.equal(surface.status, 409);
  assert.equal(surface.body.error, "claude_code_runtime_surface_switch_unsupported");
  assert.match(surface.body.hint, /\/agent codex/);

  const show = await json(`${base}/input`, { method: "POST", body: JSON.stringify({ text: "/agent", source: "test", parseCommands: true }) });
  assert.equal(show.status, 202);
  assert.match(show.body.replyText, /Active executor: Claude Code \(model opus\)/);

  await updateThread("api-executor", { state: "working", runtime: { runtimeKind: "claude-code", state: "working", activeTurnId: "turn-1" } }, env);
  const deferred = await json(`${base}/executor`, { method: "PUT", body: JSON.stringify({ executor: "codex" }) });
  assert.equal(deferred.status, 200);
  assert.equal(deferred.body.deferred, true);
  const pending = await json(`${base}/executor`);
  assert.equal(pending.body.executor.pendingExecutorSwitch.target, "codex");
  assert.equal(JSON.stringify(pending.body).includes("sessionId"), false);
});

test("CLI switch resolves --self through whereiam and sends an after-turn self switch", async () => {
  const seen = [];
  let text = "";
  const code = await runCli(["switch", "--self", "claude", "--reason", "needs long context", "--now"], {
    cwd: "/workspace/demo",
    env: {},
    stdout: { write: (value) => { text += value; } },
    stderr: { write: () => {} },
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      seen.push({ key: `${options.method || "GET"} ${parsed.pathname}`, search: parsed.search, body: options.body ? JSON.parse(options.body) : null });
      if (parsed.pathname === "/api/whereiam") return Response.json({ ok: true, thread: { id: "thread-1" } });
      return Response.json({ ok: true, deferred: true, replyText: "Executor switch to Claude Code queued; it applies when the current turn finishes." });
    },
  });
  assert.equal(code, 0);
  assert.equal(seen[0].key, "GET /api/whereiam");
  assert.equal(seen[0].search, `?cwd=${encodeURIComponent("/workspace/demo")}`);
  assert.equal(seen[1].key, "PUT /api/threads/thread-1/executor");
  assert.deepEqual(seen[1].body, { executor: "claude", reason: "needs long context", when: "after_turn", actor: "self" });
  assert.match(text, /queued/);
});
