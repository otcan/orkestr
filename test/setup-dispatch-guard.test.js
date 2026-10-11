// Subscription-only check at provider dispatch for Setup threads. Fake
// providers only: a fake Codex app-server reports whatever login type the
// test writes; no real account is used and nothing is billed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverCodexAppServerPendingInputs, stopCodexAppServerClients } from "../packages/core/src/codex-app-server.js";
import { createThread, enqueueThreadInput, getThread, listThreadMessages, updateThread } from "../packages/core/src/threads.js";
import { checkSetupClaudeSubscription, checkSetupCodexSubscription } from "../packages/core/src/setups/setup-dispatch-guard.js";

const setupThread = { id: "t", setupInstanceId: "setup_x", setupId: "fitness-tracker" };
const plainThread = { id: "p" };
const fakeClient = (account, fail = false) => ({ request: async (method) => {
  assert.equal(method, "account/read");
  if (fail) throw new Error("app-server unavailable");
  return { account, requiresOpenaiAuth: true };
} });

test("Codex check: only a ChatGPT login passes for Setup threads; others are unaffected", async () => {
  assert.deepEqual(await checkSetupCodexSubscription(fakeClient({ type: "chatgpt", email: null, planType: "plus" }), setupThread), { ok: true, applies: true });
  assert.equal((await checkSetupCodexSubscription(fakeClient({ type: "apiKey" }), setupThread)).reason, "codex_api_key_not_subscription");
  assert.equal((await checkSetupCodexSubscription(fakeClient(null), setupThread)).reason, "codex_not_logged_in");
  assert.equal((await checkSetupCodexSubscription(fakeClient({ type: "amazonBedrock" }), setupThread)).reason, "codex_auth_mode_not_subscription");
  assert.equal((await checkSetupCodexSubscription(fakeClient({ type: "somethingNew" }), setupThread)).reason, "codex_auth_mode_not_subscription");
  assert.equal((await checkSetupCodexSubscription(fakeClient(null, true), setupThread)).reason, "codex_auth_state_unavailable");
  assert.deepEqual(await checkSetupCodexSubscription(fakeClient({ type: "apiKey" }), plainThread), { ok: true, applies: false });
});

// Fake `claude` CLI: `auth status --json` prints $FAKE_CLAUDE_STATUS, or
// status.json next to the script when the runner's allowlisted env drops it (and
// exits 1 when loggedIn is false, like the real CLI); any other invocation
// is recorded in $FAKE_CLAUDE_RAN, so a refused turn proves nothing ran.
async function fakeClaude(dir) {
  const bin = path.join(dir, "claude");
  await fs.writeFile(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  const raw = fs.readFileSync(process.env.FAKE_CLAUDE_STATUS || require("node:path").join(__dirname, "status.json"), "utf8");
  process.stdout.write(raw);
  let loggedIn = false; try { loggedIn = JSON.parse(raw).loggedIn === true; } catch {}
  process.exit(loggedIn ? 0 : 1);
}
fs.appendFileSync(process.env.FAKE_CLAUDE_RAN || require("node:path").join(__dirname, "ran"), args.join(" ") + "\\n");
`, { mode: 0o755 });
  return bin;
}

test("Claude check needs positive subscription evidence from the CLI in the child env", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-claude-auth-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const command = await fakeClaude(dir);
  const statusFile = path.join(dir, "status.json");
  const childEnv = { PATH: process.env.PATH, HOME: dir, FAKE_CLAUDE_STATUS: statusFile, FAKE_CLAUDE_RAN: path.join(dir, "ran") };
  const subscriptionProfile = { authMode: "subscription" };
  const check = async (status, profile = subscriptionProfile, env = childEnv) => {
    await fs.writeFile(statusFile, typeof status === "string" ? status : JSON.stringify(status));
    return checkSetupClaudeSubscription(setupThread, profile, env, { command });
  };
  const base = { apiProvider: "firstParty", analyticsDisabled: false };
  assert.deepEqual(await check({ ...base, loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }), { ok: true, applies: true });
  assert.deepEqual(await check({ ...base, loggedIn: true, authMethod: "oauth_token" }), { ok: true, applies: true });
  // Declared subscription profile, but the CLI is actually on an API key.
  assert.equal((await check({ ...base, loggedIn: true, authMethod: "api_key", apiKeySource: "/login managed key" })).reason, "claude_login_not_subscription");
  assert.equal((await check({ ...base, loggedIn: true, authMethod: "claude.ai" })).reason, "claude_login_not_subscription", "claude.ai without a subscription type is not evidence");
  assert.equal((await check({ loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" })).reason, "claude_login_not_subscription");
  assert.equal((await check({ ...base, loggedIn: true, authMethod: "something_new" })).reason, "claude_login_not_subscription");
  assert.equal((await check({ ...base, loggedIn: false, authMethod: "none" })).reason, "claude_not_logged_in");
  assert.equal((await check("not json at all")).reason, "claude_auth_status_unavailable");
  assert.equal((await checkSetupClaudeSubscription(setupThread, subscriptionProfile, childEnv, { command: path.join(dir, "missing") })).reason, "claude_auth_status_unavailable");
  // Declaration and environment checks still apply first.
  assert.equal((await check({ ...base, loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }, {})).reason, "claude_profile_not_subscription");
  assert.equal((await check({ ...base, loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }, subscriptionProfile, { ...childEnv, ANTHROPIC_API_KEY: "fake-value" })).reason, "claude_api_billing_env_present");
  // Ordinary threads are never checked.
  let called = false;
  assert.deepEqual(await checkSetupClaudeSubscription(plainThread, {}, { ANTHROPIC_API_KEY: "fake-value" }, { command, readStatus: async () => { called = true; return { ok: false }; } }), { ok: true, applies: false });
  assert.equal(called, false);
  await assert.rejects(fs.stat(path.join(dir, "ran")), { code: "ENOENT" }, "status checks never start a Claude turn");
});

test("a Setup Claude turn is refused before the CLI starts when the login is an API key", async (t) => {
  const { runClaudeCodeProcess } = await import("../packages/core/src/claude-code-process-runner.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-claude-run-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const command = await fakeClaude(dir);
  const statusFile = path.join(dir, "status.json");
  await fs.writeFile(statusFile, JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "/login managed key" }));
  const env = { ...process.env, ORKESTR_HOME: path.join(dir, "home"), ORKESTR_CLAUDE_CODE_BIN: command, FAKE_CLAUDE_STATUS: statusFile, FAKE_CLAUDE_RAN: path.join(dir, "ran") };
  const thread = { id: "setup-claude", setupInstanceId: "setup_x", setupId: "fitness-tracker", cwd: dir };
  const profile = { authMode: "subscription", credentialRoot: path.join(dir, "profile") };
  await assert.rejects(
    runClaudeCodeProcess({ thread, profile, prompt: "hi", sessionId: "", attemptId: "a1", assertProfileReady: async () => {}, activeTurns: new Map(), env }),
    (error) => error.code === "claude_login_not_subscription",
  );
  await assert.rejects(fs.stat(path.join(dir, "ran")), { code: "ENOENT" }, "the Claude turn never started");
});

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Fake app-server: account/read returns the type in $FAKE_CODEX_DIR/account
// ("none" means not logged in); every turn/start is appended to turns.log.
async function createFakeCodex(home) {
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli fake"); process.exit(0); }
if (args[0] === "app-server" && args.includes("--help")) { console.log("Usage: codex app-server"); process.exit(0); }
if (args[0] !== "app-server") process.exit(0);
const dir = process.env.FAKE_CODEX_DIR;
const threads = new Map();
let count = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "initialize") return send({ id, result: { userAgent: "fake", platformFamily: "linux", platformOs: "linux" } });
  if (method === "initialized") return;
  if (method === "account/read") {
    const type = fs.readFileSync(path.join(dir, "account"), "utf8").trim();
    return send({ id, result: { account: type === "none" ? null : { type, email: null, planType: "plus" }, requiresOpenaiAuth: true } });
  }
  if (method === "thread/start") {
    const thread = { id: "thr_" + String(threads.size + 1).padStart(3, "0"), cwd: params.cwd || "", status: { type: "idle" }, turns: [] };
    threads.set(thread.id, thread);
    send({ id, result: { thread } });
    return send({ method: "thread/started", params: { thread } });
  }
  if (method === "thread/read" || method === "thread/resume") return send({ id, result: { thread: threads.get(params.threadId) || { id: params.threadId, turns: [] } } });
  if (method === "turn/start" || method === "turn/steer") {
    count += 1;
    fs.appendFileSync(path.join(dir, "turns.log"), params.threadId + "\\n");
    const turn = { id: "turn_" + count, threadId: params.threadId, status: "inProgress", items: [] };
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { turn } });
    const agent = { type: "agentMessage", id: "agent_" + turn.id, text: "ok", phase: "final_answer" };
    send({ method: "item/completed", params: { threadId: params.threadId, turnId: turn.id, item: agent } });
    return send({ method: "turn/completed", params: { turn: { ...turn, status: "completed", items: [agent] } } });
  }
  send({ id, result: {} });
});
`, { mode: 0o755 });
  return bin;
}

test("Codex dispatch refuses Setup turns after the login changes; ordinary threads are unchanged", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ork-setup-dispatch-"));
  t.after(async () => {
    stopCodexAppServerClients();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const bin = await createFakeCodex(home);
  const env = { ORKESTR_HOME: path.join(home, "orkestr"), HOME: path.join(home, "runtime-home"), PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`, FAKE_CODEX_DIR: home };
  const account = (type) => fs.writeFile(path.join(home, "account"), type);
  const turns = async () => (await fs.readFile(path.join(home, "turns.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  const codex = { cwd: home, workspace: home, runtimeKind: "codex-app-server", runtime: { runtimeKind: "codex-app-server" }, executorId: "codex", executor: { id: "codex", type: "codex", transport: "app-server" } };
  await createThread({ id: "setup-fitness", name: "Setup fitness", ...codex }, env);
  await updateThread("setup-fitness", { setupInstanceId: "setup_abc", setupId: "fitness-tracker" }, env);
  await createThread({ id: "plain-codex", name: "Plain codex", ...codex }, env);
  const deliver = async (threadId, input) => {
    const message = await enqueueThreadInput(threadId, input, env);
    await deliverCodexAppServerPendingInputs(await getThread(threadId, env), env);
    return message;
  };
  const stateOf = async (threadId, messageId) => (await listThreadMessages(threadId, env)).find((message) => message.id === messageId);

  // Subscription login at install time: an owner message runs.
  await account("chatgpt");
  await deliver("setup-fitness", { text: "squat 3x5 100kg" });
  await waitFor(async () => (await turns()) === 1);

  // The login is switched to an API key later. A scheduled check-in on the
  // already-started (resumed) session is refused before turn/start.
  await account("apiKey");
  const scheduled = await deliver("setup-fitness", { text: "evening check-in", source: "timer_due", timerId: "setup_abc-evening-check-in" });
  const refused = await waitFor(async () => { const message = await stateOf("setup-fitness", scheduled.id); return message?.state === "failed" ? message : null; });
  assert.equal(refused.error, "codex_api_key_not_subscription");
  assert.equal(refused.deliveryState, "refused_setup_subscription");
  // An interactive message is refused the same way.
  const interactive = await deliver("setup-fitness", { text: "what should I do today?" });
  assert.equal((await waitFor(async () => { const message = await stateOf("setup-fitness", interactive.id); return message?.state === "failed" ? message : null; })).error, "codex_api_key_not_subscription");
  // Not logged in at all: refused too.
  await account("none");
  const unknown = await deliver("setup-fitness", { text: "hello?" });
  assert.equal((await waitFor(async () => { const message = await stateOf("setup-fitness", unknown.id); return message?.state === "failed" ? message : null; })).error, "codex_not_logged_in");
  assert.equal(await turns(), 1, "no Setup turn reached the provider after the login changed");

  // A thread not created by a Setup keeps today's behaviour on an API key.
  await account("apiKey");
  await deliver("plain-codex", { text: "ordinary work" });
  await waitFor(async () => (await turns()) === 2);
});
