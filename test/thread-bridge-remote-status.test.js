import assert from "node:assert/strict";
import test from "node:test";
import { remoteBridgeStatus, remoteInputActivity } from "../packages/core/src/thread-bridge-remote-status.js";

const stamp = 1_800_000_000_000;
const thread = { id: "synthetic-thread", runtime: { activeTurnId: "obsolete" }, binding: { remoteThreadId: "remote-thread", remoteBackend: "rust" } };
const env = { ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify({ rust: { baseUrl: "http://127.0.0.1:12345", token: "synthetic-token" } }) };
const projection = () => ({ version: 1, source: "core", publicThreadId: thread.id, observedAtMs: stamp,
  roles: { fast: null, deep: { phase: "running", runId: "synthetic-run", observedAtMs: stamp, lastProgressAtMs: stamp - 100 } }, queuedInputs: [] });
const options = (value, calls = []) => ({ now: () => stamp, fetchImpl: async (url, init) => {
  calls.push({ url: String(url), init });
  return { ok: true, json: async () => value };
} });

test("Core status replaces obsolete terminal state and exposes exact run provenance", async () => {
  const calls = [];
  const status = await remoteBridgeStatus(thread, env, options(projection(), calls));
  assert.equal(status.state, "working");
  assert.equal(status.runtime, "rust-v2");
  assert.equal(status.roles.deep.runId, "synthetic-run");
  assert.equal(status.taskOutcome, "unknown");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /threads\/remote-thread\/status$/);
  assert.equal(calls[0].init.body, undefined);
});

test("failed, blocked and queued states remain distinct from model completion", async () => {
  for (const [phase, expected] of [["failed", "last_turn_failed"], ["blocked", "blocked"], ["completed", "idle"], ["awaiting_acceptance", "awaiting_acceptance"]]) {
    const value = projection(); value.roles.deep.phase = phase;
    const status = await remoteBridgeStatus(thread, env, options(value));
    assert.equal(status.state, expected);
    assert.equal(status.taskOutcome, "unknown");
  }
  const value = projection(); value.roles.deep.phase = "completed";
  value.queuedInputs.push({ inputMessageId: "queued-input" });
  assert.equal((await remoteBridgeStatus(thread, env, options(value))).state, "queued");
});

test("stale, foreign or malformed Core status is unknown, never legacy idle or working", async () => {
  for (const mutate of [v => v.observedAtMs -= 5001, v => v.roles.deep.observedAtMs += 1,
    v => v.publicThreadId = "other-thread", v => v.roles.deep.phase = "invented"]) {
    const value = projection(); mutate(value);
    assert.equal((await remoteBridgeStatus(thread, env, options(value))).state, "unknown");
  }
  assert.equal((await remoteBridgeStatus(thread, env, { fetchImpl: async () => { throw Error("unavailable"); } })).state, "unknown");
});

test("exact-input readiness means waiting for delivery, without claiming business completion", async () => {
  const input = { id: "input-a" };
  const value = { publicThreadId: thread.id, publicMessageId: input.id, observedAtMs: stamp, active: false, finalReady: true };
  assert.equal((await remoteInputActivity(thread, input, env, options(value))).state, "awaiting_delivery");
  value.publicMessageId = "other-input";
  assert.equal((await remoteInputActivity(thread, input, env, options(value))).state, "unknown");
});

test("legacy threads do not contact a remote runtime", async () => {
  const calls = [];
  assert.equal(await remoteBridgeStatus({ id: "local" }, env, options({}, calls)), null);
  assert.equal(calls.length, 0);
});
