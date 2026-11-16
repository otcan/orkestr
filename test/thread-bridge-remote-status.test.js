import assert from "node:assert/strict";
import test from "node:test";
import { remoteBridgeStatus, remoteInputActivity } from "../packages/core/src/thread-bridge-remote-status.js";

const stamp = 1_800_000_000_000;
const thread = { id: "synthetic-thread", runtime: { activeTurnId: "obsolete" }, binding: { remoteThreadId: "remote-thread", remoteBackend: "rust" } };
const env = { ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify({ rust: { baseUrl: "http://127.0.0.1:12345", token: "synthetic-token" } }) };
const role = (phase, extra = {}) => ({ phase, runId: "00000000-0000-4000-8000-00000000000a", observedAtMs: stamp, lastProgressAtMs: stamp - 100, ...extra });
const projection = () => ({ version: 1, source: "core", publicThreadId: thread.id, conversationId: "00000000-0000-4000-8000-0000000000c1", observedAtMs: stamp,
  roles: { fast: null, deep: role("running") }, queuedInputs: [], taskOutcome: "unknown" });
const options = (value, calls = [], extra = {}) => ({ now: () => stamp, ...extra, fetchImpl: async (url, init) => {
  calls.push({ url: String(url), init });
  return { ok: true, status: 200, json: async () => value };
} });
const failing = (status, error) => ({ now: () => stamp, fetchImpl: async () => ({ ok: false, status, json: async () => ({ ok: false, error }) }) });

test("Core status replaces obsolete terminal state and exposes exact run provenance", async () => {
  const calls = [];
  const value = projection();
  value.roles.deep = role("running", { provider: "codex", model: "gpt-5.5-codex" });
  const status = await remoteBridgeStatus(thread, env, options(value, calls));
  assert.equal(status.state, "working");
  assert.equal(status.runtime, "rust-v2");
  assert.equal(status.provider, "codex");
  assert.equal(status.model, "gpt-5.5-codex");
  assert.equal(status.execution.available, true);
  assert.equal(status.execution.phase, "running");
  assert.equal(status.execution.activeRole, "deep");
  assert.equal(status.execution.roles.deep.runId, "00000000-0000-4000-8000-00000000000a");
  assert.equal(status.taskOutcome, "unknown");
  assert.equal(status.queuedMessages, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /threads\/remote-thread\/status$/);
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.method, undefined, "a plain GET");
  assert.equal(calls[0].init.headers.authorization, "Bearer synthetic-token", "the binding's configured transport credential");
  assert.ok(calls[0].init.signal, "bounded by a timeout");
});

test("starting, stop-requested and Fast-only activity are working", async () => {
  for (const [deep, fast, activeRole] of [[role("starting"), null, "deep"], [role("cancel_requested"), null, "deep"],
    [role("completed"), role("running", { provider: "claude", model: "claude-opus-5-5" }), "fast"]]) {
    const value = projection(); value.roles.deep = deep; value.roles.fast = fast;
    const status = await remoteBridgeStatus(thread, env, options(value));
    assert.equal(status.state, "working");
    assert.equal(status.execution.activeRole, activeRole);
  }
  const value = projection(); value.roles.deep = null; value.roles.fast = role("running", { provider: "claude", model: "claude-opus-5-5" });
  const status = await remoteBridgeStatus(thread, env, options(value));
  assert.equal(status.provider, "claude");
  assert.equal(status.execution.phase, "none");
});

test("queued native input is queued, with a count only where Core gives one", async () => {
  const value = projection(); value.roles.deep = role("completed");
  value.queuedInputs.push({ inputMessageId: "native-input", inputEventId: "native-event", queuedAtMs: stamp - 10, position: 1 });
  const windowed = await remoteBridgeStatus(thread, env, options(value));
  assert.equal(windowed.state, "queued");
  assert.equal(windowed.queuedMessages, 1);
  const inbox = projection(); inbox.roles.deep = { phase: "queued", runId: null, observedAtMs: stamp };
  const status = await remoteBridgeStatus(thread, env, options(inbox));
  assert.equal(status.state, "queued");
  assert.equal(status.queuedMessages, null, "queued, count not observed - never zero");
  assert.equal(status.execution.phase, "queued");
});

test("completion, acceptance and failures stay distinct from task success", async () => {
  for (const [phase, failure, expected, lastError] of [
    ["completed", undefined, "idle", null],
    ["awaiting_acceptance", undefined, "awaiting_acceptance", null],
    ["failed", "quota", "last_turn_failed", "quota"],
    ["failed", undefined, "last_turn_failed", "native_run_failed"],
    ["blocked", undefined, "blocked", "native_run_blocked"],
    ["cancelled", undefined, "last_turn_cancelled", null],
    ["cancelled", "policy", "last_turn_cancelled", "policy"],
  ]) {
    const value = projection(); value.roles.deep = role(phase, failure ? { failure } : {});
    const status = await remoteBridgeStatus(thread, env, options(value));
    assert.equal(status.state, expected, phase);
    assert.equal(status.execution.phase, phase);
    assert.equal(status.lastError, lastError, phase);
    assert.equal(status.taskOutcome, "unknown", "a native run that ended is not proof the task succeeded");
  }
  const none = projection(); none.roles.deep = null;
  const status = await remoteBridgeStatus(thread, env, options(none));
  assert.equal(status.state, "idle");
  assert.equal(status.execution.phase, "none");
});

test("unreadable native status is unknown with a closed reason, never idle", async () => {
  const cases = [
    [options(Object.assign(projection(), { observedAtMs: stamp - 5001 })), "native_status_stale"],
    [options((() => { const v = projection(); v.roles.deep.observedAtMs = stamp + 1; return v; })()), "native_status_stale"],
    [options(Object.assign(projection(), { publicThreadId: "other-thread" })), "native_scope_mismatch"],
    [options((() => { const v = projection(); v.roles.deep.phase = "invented"; return v; })()), "native_status_invalid"],
    [options((() => { const v = projection(); delete v.roles.fast; return v; })()), "native_status_invalid"],
    [options(Object.assign(projection(), { version: 2 })), "native_status_invalid"],
    [options(null), "native_status_invalid"],
    [failing(503, "core_status_unavailable"), "native_status_unavailable"],
    [failing(410, "binding_revoked"), "native_binding_revoked"],
    [failing(404, "route_not_found"), "native_binding_not_found"],
    [failing(401, "unauthorized"), "native_auth_rejected"],
    [{ now: () => stamp, fetchImpl: async () => { throw new TypeError("fetch failed"); } }, "native_status_unavailable"],
  ];
  for (const [option, reason] of cases) {
    const status = await remoteBridgeStatus(thread, env, option);
    assert.equal(status.state, "unknown", reason);
    assert.equal(status.queuedMessages, null);
    assert.equal(status.lastError, reason);
    assert.deepEqual(status.execution, { available: false, reason });
    assert.equal(status.taskOutcome, "unknown");
  }
  const unconfigured = await remoteBridgeStatus({ ...thread, binding: { ...thread.binding, remoteBackend: "missing" } }, env, options(projection()));
  assert.equal(unconfigured.state, "unknown");
  assert.equal(unconfigured.lastError, "native_backend_not_configured");
});

test("a hanging adapter times out quickly as unknown", async () => {
  const started = Date.now();
  // AbortSignal.timeout does not hold the event loop open; a server does.
  const loop = setTimeout(() => {}, 10_000);
  const status = await remoteBridgeStatus(thread, env, { now: () => stamp, timeoutMs: 50, fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }) }).finally(() => clearTimeout(loop));
  assert.equal(status.state, "unknown");
  assert.equal(status.lastError, "native_status_timeout");
  assert.ok(Date.now() - started < 2000);
});

test("V1 inputs the adapter has not acknowledged stay visible next to native state", async () => {
  const value = projection(); value.roles.deep = role("completed");
  const inputs = [
    { role: "user", state: "delivered", remoteMessageId: "remote-1" },
    { role: "user", state: "queued", remoteMessageId: "remote-2" },
    { role: "user", state: "queued" },
  ];
  const status = await remoteBridgeStatus(thread, env, { ...options(value), inputs });
  assert.equal(status.state, "queued");
  assert.equal(status.pendingForwardMessages, 1, "only the input native Core has not received");
  assert.equal(status.queuedMessages, 1);
  const refused = { role: "user", state: "failed", observedVia: "remote_runtime_refused", error: "remote_runtime_input_expired:unavailable" };
  const failed = await remoteBridgeStatus(thread, env, { ...options(value), inputs: [refused] });
  assert.equal(failed.state, "last_turn_failed", "Core never received the latest request");
  assert.equal(failed.lastError, "remote_runtime_input_expired:unavailable");
  const text = await remoteBridgeStatus(thread, env, { ...options(value), inputs: [{ ...refused, error: "refused at /srv/private path" }] });
  assert.equal(text.lastError, "remote_forward_failed");
  const reached = await remoteBridgeStatus(thread, env, { ...options(value), inputs: [{ role: "user", state: "failed", remoteMessageId: "remote-3" }] });
  assert.equal(reached.state, "idle", "a mirror state of an input Core received is not its execution");
  const local = await remoteBridgeStatus(thread, env, { ...options(value), inputs: [{ role: "user", state: "failed", error: "pre-delegation turn failed" }] });
  assert.equal(local.state, "idle", "an old local runtime failure is not native evidence");
  const unavailable = await remoteBridgeStatus(thread, env, { ...failing(503), inputs: [{ role: "user", state: "queued" }] });
  assert.equal(unavailable.state, "unknown");
  assert.equal(unavailable.pendingForwardMessages, 1);
});

test("the status exposes no native identifiers beyond run ids, paths or unvalidated text", async () => {
  const value = projection();
  value.roles.deep = role("failed", { failure: "/srv/secret/path", provider: "other", model: "/home/user/.codex/model", runId: "../../etc/passwd" });
  value.queuedInputs.push({ inputMessageId: "native-input-id", inputEventId: "native-event-id" });
  const status = await remoteBridgeStatus(thread, env, options(value));
  const text = JSON.stringify(status);
  for (const leaked of ["0000000000c1", "native-input-id", "native-event-id", "/srv/", "/home/", "passwd", "remote-thread"]) {
    assert.equal(text.includes(leaked), false, leaked);
  }
  assert.equal(status.execution.roles.deep.failure, null);
  assert.equal(status.execution.roles.deep.provider, null);
  assert.equal(status.execution.roles.deep.model, null);
  assert.equal(status.execution.roles.deep.runId, null);
  assert.equal(status.state, "queued", "queued input outranks the earlier failed run");
  value.queuedInputs = [];
  const failed = await remoteBridgeStatus(thread, env, options(value));
  assert.equal(failed.state, "last_turn_failed");
  assert.equal(failed.lastError, "native_run_failed", "unknown failure text is replaced by a closed code");
});

test("exact-input readiness means waiting for delivery, without claiming business completion", async () => {
  const input = { id: "input-a" };
  const value = { publicThreadId: thread.id, publicMessageId: input.id, observedAtMs: stamp, active: false, finalReady: true };
  assert.equal((await remoteInputActivity(thread, input, env, options(value))).state, "awaiting_delivery");
  value.publicMessageId = "other-input";
  assert.equal((await remoteInputActivity(thread, input, env, options(value))).state, "unknown");
});

test("legacy and disabled-delegation threads do not contact a remote runtime", async () => {
  const calls = [];
  assert.equal(await remoteBridgeStatus({ id: "local" }, env, options({}, calls)), null);
  assert.equal(await remoteBridgeStatus({ ...thread, binding: { ...thread.binding, remoteRuntimeEnabled: false } }, env, options({}, calls)), null);
  assert.equal(await remoteBridgeStatus({ ...thread, binding: { ...thread.binding, connector: "telegram" } }, env, options({}, calls)), null);
  assert.equal(calls.length, 0);
});
