import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPersonalAgentSessionRuntimes } from "../packages/core/src/personal-agent-session-runtimes.js";
import { createPersonalAgentSessionManager } from "../packages/core/src/personal-agent-session-manager.js";
import { CodexJobSession } from "../packages/core/src/codex-job-session.js";
import { getCodexJobClient, stopCodexJobClients } from "../packages/core/src/codex-job-client.js";
import { claudeJobArgs } from "../packages/core/src/agent-job-claude-code.js";
import { codexJobEnv, readFakeCodex } from "./fixtures/codex-job-fixtures.js";
import { fakeClaude } from "./fixtures/claude-job-fixtures.js";
import { sessionHarness, sessionInput, sessionProfile, sessionStore, supervisor } from "./fixtures/personal-agent-session-fixtures.js";

const row = { ownerUserId: "owner", ...sessionProfile };
const profile = { id: "profile-example", ownerUserId: "owner", provider: "codex", authMode: "subscription", state: "ready", credentialRoot: "/tmp/synthetic-profile" };
const options = { cwd: "/tmp/example-project", env: { ORKESTR_PERSONAL_AGENT_ENABLED: "1" }, resolveProfile: async () => profile,
  codexLogin: async () => ({ available: true, connected: true, authMode: "chatgpt" }), codexStatus: async () => ({ ok: true }) };
test.afterEach(() => stopCodexJobClients());

test("discovery requires enabled subscription profile, native executor, CLI and ChatGPT auth", async () => {
  assert.deepEqual(await createPersonalAgentSessionRuntimes(options).codex.probe(row), { available: true });
  for (const [override, reason] of [
    [{ env: {} }, "runtime_unavailable"],
    [{ resolveProfile: async () => ({ ...profile, state: "rate_limited" }) }, "rate_limited"],
    [{ resolveProfile: async () => ({ ...profile, ownerUserId: "other" }) }, "authentication_required"],
    [{ resolveProfile: async () => ({ ...profile, authMode: "api_key" }) }, "authentication_required"],
    [{ codexLogin: async () => ({ available: true, connected: true, authMode: "api_key" }) }, "authentication_required"],
    [{ codexLogin: async () => ({ available: false }) }, "runtime_unavailable"],
    [{ codexStatus: async () => ({ ok: false }) }, "runtime_unavailable"],
    [{ env: { ...options.env, ORKESTR_AGENT_JOB_CODEX_EXECUTOR: "0" } }, "runtime_unavailable"],
  ]) assert.deepEqual(await createPersonalAgentSessionRuntimes({ ...options, ...override }).codex.probe(row), { available: false, reason });
});

test("Claude subscription discovery is explicit and never auto-enables its executor", async () => {
  const claudeRow = { ...row, provider: "claude-code" };
  const settings = { ...options, resolveProfile: async () => ({ ...profile, provider: "claude-code" }), claudeEnv: async () => ({}),
    claudeDiagnostics: async () => ({ available: true, authenticated: true, authMethod: "claude.ai" }) };
  assert.equal((await createPersonalAgentSessionRuntimes(settings)["claude-code"].probe(claudeRow)).available, false);
  settings.env = { ...options.env, ORKESTR_AGENT_JOB_CLAUDE_CODE_EXECUTOR: "1" };
  const runtime = createPersonalAgentSessionRuntimes(settings)["claude-code"];
  assert.deepEqual(await runtime.probe(claudeRow), { available: true });
  assert.deepEqual(await runtime.open(claudeRow), { nativeSessionId: undefined, lifecycle: "starting" });
  await assert.rejects(runtime.open(claudeRow, { parent: row }), /fork_unsupported/);
  assert.equal((await createPersonalAgentSessionRuntimes({ ...settings, claudeDiagnostics: async () => ({ available: true, authenticated: true, authMethod: "api_key" }) })["claude-code"].probe(claudeRow)).available, false);
});

test("Codex open uses method-specific supported fields and retains an empty loaded session", async () => {
  const requests = [];
  const client = { async request(method, params) { requests.push({ method, params }); return { thread: { id: params.threadId || "native-empty", turns: [] } }; } };
  const runtime = createPersonalAgentSessionRuntimes({ ...options, codexClient: async () => client }).codex;
  const opened = await runtime.open(row);
  assert.equal(opened.lifecycle, "starting");
  assert.equal(requests[0].params.allowProviderModelFallback, false);
  assert.match(requests[0].params.developerInstructions, /must use the provided Orkestr tools/);
  await runtime.open({ ...row, nativeSessionId: opened.nativeSessionId });
  assert.equal(requests.length, 1, "empty session uses the original loaded app-server, no failed durable resume");
  await runtime.open({ ...row, nativeSessionId: "durable-session" });
  assert.equal(requests.at(-1).method, "thread/resume");
  assert.equal(requests.at(-1).params.dynamicTools, undefined);
  await runtime.open(row, { parent: { ...row, nativeSessionId: "durable-parent" } });
  assert.equal(requests.at(-1).method, "thread/fork");
  assert.equal(requests.at(-1).params.serviceName, undefined);
});

test("lost history and active native turns block rather than creating or interrupting another session", async () => {
  for (const response of [async () => { throw new Error("not found"); }, async () => ({ thread: { id: "native-session", turns: [{ status: "inProgress" }] } })]) {
    const requests = [];
    const runtime = createPersonalAgentSessionRuntimes({ ...options, codexClient: async () => ({ request(method) { requests.push(method); return response(); } }) }).codex;
    await assert.rejects(runtime.open({ ...row, nativeSessionId: "native-session" }), /native_resume/);
    assert.deepEqual(requests, ["thread/resume"]);
  }
});

test("bridge pins account/model/effort, scrubs API keys and requires the conversation workspace", async () => {
  let captured;
  const runtime = createPersonalAgentSessionRuntimes({ ...options, env: { ...options.env, OPENAI_API_KEY: "synthetic-not-real" }, executors: {
    codex: { enabled: () => true, async run(ctx, input) { captured = { ctx, input }; await ctx.prepareWorkspace(input); return { type: "final" }; } },
  } }).codex;
  const ctx = supervisor();
  await runtime.run({ ...row, id: "ags-example", nativeSessionId: "native-example" }, ctx, { model: "untrusted-override" });
  assert.equal(captured.input.model, row.model);
  assert.equal(captured.ctx.personalAgentSession.effort, row.effort);
  assert.equal(captured.ctx.resume.sessionRef, "native-example");
  assert.equal(captured.ctx.env.CODEX_HOME, profile.credentialRoot);
  assert.equal(captured.ctx.env.OPENAI_API_KEY, "");
  assert.equal(captured.ctx.env.CODEX_API_KEY, "");
  assert.equal(captured.ctx.toolDecision, ctx.toolDecision);
  await assert.rejects(runtime.run(row, { ...ctx, prepareWorkspace: async () => ({ path: "/tmp/other-project" }) }, {}), /workspace_mismatch/);
});

test("real Codex bridge with fake CLI keeps FAST/DEEP IDs, new prompts and changed models on resume", async t => {
  const env = { ...await codexJobEnv(), ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
  t.after(() => fs.rm(env.ORKESTR_HOME, { recursive: true, force: true }));
  const cwd = path.join(env.ORKESTR_HOME, "project");
  await fs.mkdir(cwd);
  const account = { ...profile, credentialRoot: path.join(env.ORKESTR_HOME, "profile") };
  const runtimes = createPersonalAgentSessionRuntimes({ ...options, env, cwd, resolveProfile: async () => account });
  const manager = createPersonalAgentSessionManager({ store: sessionStore(), ownerUserId: "owner", runtimes, env });
  const roles = await manager.ensureScope({ ...sessionInput, profiles: { fast: sessionProfile, deep: sessionProfile } });
  assert.notEqual(roles.fast.nativeSessionId, roles.deep.nativeSessionId);
  const runtimeEnv = { ...env, HOME: path.join(account.credentialRoot, "runtime-home"), CODEX_HOME: account.credentialRoot, OPENAI_API_KEY: "", CODEX_API_KEY: "", ORKESTR_CODEX_APP_SERVER_MODE: "stdio", ORKESTR_CODEX_APP_SERVER_SOCKET: "" };
  const client = await getCodexJobClient({ env: runtimeEnv, home: runtimeEnv.HOME });
  const request = client.request.bind(client), turns = [];
  client.request = (method, params) => { if (method === "turn/start") turns.push(params); return request(method, params); };
  const ctx = { ...supervisor(), job: "example-job", runId: "example-run", prepareWorkspace: async () => ({ path: cwd, kind: "project" }) };
  assert.equal((await manager.runTurn(roles.fast.id, ctx, { prompt: "first synthetic question" })).type, "final");
  manager.changeProfile(roles.fast.id, { ...sessionProfile, model: "gpt-next", effort: "low" });
  assert.equal((await manager.runTurn(roles.fast.id, ctx, { prompt: "second synthetic question" })).type, "final");
  assert.match(turns[1].input[0].text, /second synthetic question/);
  assert.equal(turns[1].model, "gpt-next");
  assert.equal(turns[1].effort, "low");
  assert.equal(turns[0].threadId, turns[1].threadId);
  assert.equal(manager.get(roles.fast.id).conversationId, "conversation-global");
  assert.equal((await readFakeCodex(env)).threads.length, 2);
});

test("strict Codex resume failure does not silently start another thread; ordinary jobs keep old behavior", async t => {
  const env = await codexJobEnv();
  t.after(() => fs.rm(env.ORKESTR_HOME, { recursive: true, force: true }));
  const strict = new CodexJobSession({ env });
  await assert.rejects(strict.open({ sessionRef: "missing-native", strictResume: true }), /native_resume_failed/);
  strict.close();
  assert.equal((await readFakeCodex(env)).threads.length, 0);
  const normal = new CodexJobSession({ env });
  assert.equal((await normal.open({ sessionRef: "missing-native" })).resumed, false);
  normal.close();
  assert.equal((await readFakeCodex(env)).threads.length, 1);
});

test("real Claude bridge with fake CLI persists native ID, sends new prompts and preserves approval hook denial", async t => {
  const fake = await fakeClaude([{ final: "first answer" }, { tools: [{ name: "Bash", input: { command: "synthetic action" } }], final: "second answer" }], { ORKESTR_PERSONAL_AGENT_ENABLED: "1" });
  const env = fake.env;
  t.after(() => fs.rm(env.ORKESTR_HOME, { recursive: true, force: true }));
  const cwd = path.join(env.ORKESTR_HOME, "project");
  await fs.mkdir(cwd);
  const account = { ...profile, provider: "claude-code", credentialRoot: path.join(env.ORKESTR_HOME, "profile") };
  const runtimes = createPersonalAgentSessionRuntimes({ ...options, env, cwd, resolveProfile: async () => account,
    claudeEnv: async () => ({ HOME: env.HOME, CLAUDE_CONFIG_DIR: account.credentialRoot }),
    claudeDiagnostics: async () => ({ available: true, authenticated: true, authMethod: "claude.ai" }) });
  const h = sessionHarness({ runtimes, env });
  const row = h.manager.ensure({ ...sessionInput, profile: { ...sessionProfile, provider: "claude-code", model: "sonnet" } });
  const opened = await h.manager.startOrResume(row.id);
  assert.equal(opened.lifecycle, "starting");
  assert.equal(opened.nativeSessionId, null);
  const ctx = { ...supervisor(), job: "example-job", runId: "example-run", prepareWorkspace: async () => ({ path: cwd, kind: "project" }) };
  await h.manager.runTurn(row.id, ctx, { prompt: "first synthetic question" });
  const native = h.manager.get(row.id).nativeSessionId;
  assert.ok(native);
  h.manager.changeProfile(row.id, { ...sessionProfile, provider: "claude-code", model: "opus", effort: "high" });
  await h.manager.runTurn(row.id, ctx, { prompt: "second synthetic question" });
  assert.equal(h.manager.get(row.id).nativeSessionId, native);
  const calls = await fake.calls();
  assert.equal(calls[1].resumed, native);
  assert.match(calls[1].prompt, /second synthetic question/);
  assert.equal(calls[1].configDir, account.credentialRoot);
  assert.deepEqual(calls[1].leaked, []);
  assert.deepEqual(await fake.ran(), [], "Bash was denied by the existing permission broker");
  assert.ok(claudeJobArgs({ personalAgentSession: true, effort: "high" }).includes("--effort"));
  assert.ok(!claudeJobArgs({ effort: "high" }).includes("--effort"));
});
