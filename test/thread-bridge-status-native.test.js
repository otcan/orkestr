// get_thread_status for a thread delegated to Orkestr V2, end to end through
// the bridge grant checks and the real remote-runtime HTTP transport against
// a synthetic loopback adapter. No real accounts, chats or runtimes.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread, updateThread } from "../packages/core/src/threads.js";
import { createUser } from "../packages/core/src/users.js";
import { bridgeThreadStatus } from "../packages/core/src/thread-bridge-messaging.js";
import { callThreadBridgeTool } from "../packages/core/src/thread-bridge-mcp.js";
import { closeThreadMessageRegistryCache } from "../packages/storage/src/thread-message-registry.js";

const principal = { kind: "delegated-agent", ownerUserId: "owner-a", agentId: "agent-a", grantId: "grant-a", issuer: "orkestr", authMethod: "orkestr-oauth",
  scopes: ["threads:read"] };
const grant = { id: "grant-a", ownerUserId: "owner-a", agentId: "agent-a", issuer: "orkestr", authMethod: "orkestr-oauth", enabled: true,
  expiresAt: "2099-01-01T00:00:00Z", observe: "all", reply: "all", message: "all" };
const TOKEN = "synthetic-adapter-token";

const role = (phase, extra = {}) => ({ phase, runId: "00000000-0000-4000-8000-00000000000a", observedAtMs: Date.now(), ...extra });
const projection = (publicThreadId, deep, fast = null, queuedInputs = []) => ({ ok: true, version: 1, source: "core", publicThreadId,
  conversationId: "00000000-0000-4000-8000-0000000000c1", observedAtMs: Date.now(), roles: { deep, fast }, queuedInputs, taskOutcome: "unknown" });

async function adapter(t) {
  const requests = [];
  let handler = (_request, response) => { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: false, error: "core_status_unavailable" })); };
  const server = http.createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    await handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const answer = (status, body) => (handler = (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  return { requests, answer, set: (next) => { handler = next; }, url: `http://127.0.0.1:${server.address().port}` };
}

async function fixture(t, grantOverride = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-bridge-native-"));
  const remote = await adapter(t);
  const env = { ORKESTR_HOME: home, ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite", ORKESTR_THREAD_BRIDGE_ENABLED: "1", ORKESTR_AUTO_RUN_THREAD_INPUT: "0",
    ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify({ "rust-test": { baseUrl: remote.url, token: TOKEN, timeoutMs: 10_000 } }) };
  const grants = path.join(home, "thread-bridge-grants.json");
  await fs.writeFile(grants, JSON.stringify([{ ...grant, ...grantOverride }]));
  await createUser({ id: "owner-a" }, env);
  for (const [id, remoteThreadId] of [["thread-a", "remote-a"], ["thread-b", "remote-b"]]) {
    await createThread({ id, ownerUserId: "owner-a", name: id, binding: { connector: "whatsapp", chatId: `${id}@g.us`, remoteThreadId, remoteBackend: "rust-test" } }, env);
  }
  await createThread({ id: "thread-local", ownerUserId: "owner-a", name: "Local", binding: { connector: "whatsapp", chatId: "local@g.us" } }, env);
  t.after(async () => { await closeThreadMessageRegistryCache(); await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return { env, remote, grants };
}

// What the V1 mirror shows for a delegated thread: the input was handed to
// the adapter ("delivered") and an earlier answer is in the history.
async function mirroredHistory(env, threadId = "thread-a") {
  const answer = await appendThreadMessage(threadId, { role: "assistant", source: "remote-runtime", phase: "final_answer", state: "completed", text: "Earlier answer." }, env);
  await appendThreadMessage(threadId, { role: "user", source: "whatsapp", text: "Run the analysis", state: "delivered", deliveryState: "delivered", remoteMessageId: "remote-input-1" }, env);
  return answer;
}

test("a running native Codex run reads as working although the V1 mirror looks idle", async (t) => {
  const { env, remote } = await fixture(t);
  const answer = await mirroredHistory(env);
  remote.answer(200, projection("thread-a", role("running", { provider: "codex", model: "gpt-5.5-codex" })));
  const status = await bridgeThreadStatus("thread-a", principal, env);
  assert.equal(status.state, "working");
  assert.equal(status.runtime, "rust-v2");
  assert.equal(status.provider, "codex");
  assert.equal(status.execution.phase, "running");
  assert.equal(status.taskOutcome, "unknown");
  assert.equal(status.lastAnswer.messageId, answer.id, "history and lastAnswer stay the V1 thread's");
  assert.deepEqual(remote.requests, [{ method: "GET", url: "/threads/remote-a/status", authorization: `Bearer ${TOKEN}` }]);
  const viaMcp = await callThreadBridgeTool("get_thread_status", { thread_id: "thread-a" }, principal, env);
  assert.equal(viaMcp.isError, undefined);
  assert.equal(viaMcp.structuredContent.state, "working");
});

test("a running native Claude run, a queued input and a completed run are reported as such", async (t) => {
  const { env, remote } = await fixture(t);
  const answer = await mirroredHistory(env);
  remote.answer(200, projection("thread-a", role("completed"), role("running", { provider: "claude", model: "claude-opus-5-5" })));
  const fast = await bridgeThreadStatus("thread-a", principal, env);
  assert.equal(fast.state, "working");
  assert.equal(fast.provider, "claude");
  assert.equal(fast.execution.activeRole, "fast");
  remote.answer(200, projection("thread-a", role("completed"), null, [{ inputMessageId: "native-input", queuedAtMs: Date.now(), position: 1 }]));
  const queued = await bridgeThreadStatus("thread-a", principal, env);
  assert.equal(queued.state, "queued");
  assert.equal(queued.queuedMessages, 1);
  remote.answer(200, projection("thread-a", role("completed")));
  const done = await bridgeThreadStatus("thread-a", principal, env);
  assert.equal(done.state, "idle");
  assert.equal(done.execution.phase, "completed", "native completion, accepted by Core");
  assert.equal(done.taskOutcome, "unknown", "not proof that the task succeeded");
  assert.equal(done.lastAnswer.messageId, answer.id);
});

test("failed, blocked and cancelled native runs are not idle", async (t) => {
  const { env, remote } = await fixture(t);
  await mirroredHistory(env);
  for (const [deep, state] of [[role("failed", { failure: "authentication" }), "last_turn_failed"], [role("blocked"), "blocked"], [role("cancelled"), "last_turn_cancelled"]]) {
    remote.answer(200, projection("thread-a", deep));
    const status = await bridgeThreadStatus("thread-a", principal, env);
    assert.equal(status.state, state);
    assert.equal(status.execution.phase, deep.phase);
  }
});

test("an unavailable native observation is unknown, never idle", async (t) => {
  const { env, remote } = await fixture(t);
  await mirroredHistory(env);
  remote.answer(503, { ok: false, error: "core_status_unavailable" });
  const unavailable = await bridgeThreadStatus("thread-a", principal, env);
  assert.equal(unavailable.state, "unknown");
  assert.equal(unavailable.queuedMessages, null);
  assert.equal(unavailable.lastError, "native_status_unavailable");
  assert.deepEqual(unavailable.execution, { available: false, reason: "native_status_unavailable" });
  remote.answer(410, { ok: false, error: "binding_revoked" });
  assert.equal((await bridgeThreadStatus("thread-a", principal, env)).lastError, "native_binding_revoked");
  remote.set((request) => request.socket.destroy());
  const reset = await bridgeThreadStatus("thread-a", principal, env);
  assert.equal(reset.state, "unknown");
  assert.equal(reset.lastError, "native_status_unavailable");
  remote.set(() => {});
  const hanging = await bridgeThreadStatus("thread-a", principal, env, { timeoutMs: 100 });
  assert.equal(hanging.state, "unknown");
  assert.equal(hanging.lastError, "native_status_timeout");
});

test("a thread sees only its own remote status", async (t) => {
  const { env, remote } = await fixture(t);
  remote.answer(200, projection("thread-b", role("running")));
  const foreign = await bridgeThreadStatus("thread-a", principal, env);
  assert.equal(foreign.state, "unknown", "another thread's projection is no evidence for this one");
  assert.equal(foreign.lastError, "native_scope_mismatch");
  assert.equal(remote.requests.at(-1).url, "/threads/remote-a/status");
  remote.answer(200, projection("thread-b", role("running")));
  assert.equal((await bridgeThreadStatus("thread-b", principal, env)).state, "working");
  assert.equal(remote.requests.at(-1).url, "/threads/remote-b/status");
});

test("thread scope and revocation are checked before and after the native read", async (t) => {
  const scoped = await fixture(t, { observe: ["thread-b"] });
  await assert.rejects(bridgeThreadStatus("thread-a", principal, scoped.env), /bridge_thread_not_found/);
  assert.equal(scoped.remote.requests.length, 0, "an out-of-scope thread never reaches the adapter");
  const revoked = await fixture(t, { enabled: false });
  await assert.rejects(bridgeThreadStatus("thread-a", principal, revoked.env), /bridge_grant_revoked/);
  assert.equal(revoked.remote.requests.length, 0);
  const racing = await fixture(t);
  racing.remote.set(async (_request, response) => {
    await fs.writeFile(racing.grants, JSON.stringify([{ ...grant, enabled: false }]));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(projection("thread-a", role("running"))));
  });
  await assert.rejects(bridgeThreadStatus("thread-a", principal, racing.env), /bridge_grant_revoked/);
  const viaMcp = await callThreadBridgeTool("get_thread_status", { thread_id: "thread-a" }, principal, racing.env);
  assert.equal(viaMcp.isError, true);
});

test("a delegation disabled or rebound during the native read yields no stale native status", async (t) => {
  const { env, remote } = await fixture(t);
  await mirroredHistory(env);
  const binding = { connector: "whatsapp", chatId: "thread-a@g.us", remoteThreadId: "remote-a", remoteBackend: "rust-test", remoteRuntimeEnabled: true };
  const environments = { "rust-test": { baseUrl: remote.url, token: TOKEN }, "rust-other": { baseUrl: remote.url, token: TOKEN } };
  const changedEnv = { ...env, ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify(environments) };
  for (const change of [{ remoteRuntimeEnabled: false }, { remoteThreadId: "remote-other" }, { remoteBackend: "rust-other" }]) {
    await updateThread("thread-a", { binding }, changedEnv);
    remote.set(async (_request, response) => {
      await updateThread("thread-a", { binding: { ...binding, ...change } }, changedEnv);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(projection("thread-a", role("running"))));
    });
    const status = await bridgeThreadStatus("thread-a", principal, changedEnv);
    assert.equal(status.state, "unknown", JSON.stringify(change));
    assert.equal(status.lastError, "native_binding_changed");
    assert.deepEqual(status.execution, { available: false, reason: "native_binding_changed" });
    assert.equal(status.queuedMessages, null);
  }
  await updateThread("thread-a", { binding }, changedEnv);
  remote.answer(200, projection("thread-a", role("running")));
  assert.equal((await bridgeThreadStatus("thread-a", principal, changedEnv)).state, "working", "an unchanged binding still reports");
});

test("local threads keep the V1 status and contact no remote runtime", async (t) => {
  const { env, remote } = await fixture(t);
  await appendThreadMessage("thread-local", { role: "user", source: "cli", text: "queued", state: "queued" }, env);
  const status = await bridgeThreadStatus("thread-local", principal, env);
  assert.equal(status.state, "queued");
  assert.equal(status.queuedMessages, 1);
  assert.equal(status.execution, undefined);
  assert.equal(status.taskOutcome, undefined);
  assert.equal(remote.requests.length, 0);
});
