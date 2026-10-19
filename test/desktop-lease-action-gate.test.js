import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { DesktopLeaseStore } from "../packages/browsers/src/desktop-lease-store.js";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/desktop-lease-gate-worker.mjs", import.meta.url));

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("owned subprocess fixture deadline");
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-lease-gate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "leases.json");
  const store = new DesktopLeaseStore(file, { lockTimeoutMs: 200 });
  const { lease } = await store.acquire({ desktopSlug: "synthetic-desk", ownerUserId: "synthetic-owner",
    threadId: "thread-a", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const binding = { desktopSlug: lease.desktopSlug, ownerUserId: lease.ownerUserId, threadId: lease.threadId,
    leaseId: lease.id, fencingVersion: lease.fencingVersion, fencingToken: lease.fencingToken };
  return { root, file, store, lease, binding };
}

async function childCall(file, mode, options = {}) {
  const optionsFile = `${file}.${mode}.${randomUUID()}.options.json`;
  await fs.writeFile(optionsFile, JSON.stringify(options));
  const { stdout } = await run(process.execPath, [fixture, file, mode, `${file}.signal`, optionsFile], { timeout: 5000 });
  return JSON.parse(stdout);
}

async function paused(t, file, mode = "hold", options = {}) {
  const signal = `${file}.paused`;
  const optionsFile = `${file}.holder-options.json`;
  await fs.writeFile(optionsFile, JSON.stringify(options));
  const child = spawn(process.execPath, [fixture, file, mode, signal, optionsFile], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  let extra;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(extra ? "SIGCONT" : "SIGKILL");
    await ended;
  });
  const metadata = await waitFor(async () => {
    const data = await fs.readFile(signal, "utf8").catch(() => "");
    if (!data) return false;
    const status = await fs.readFile(`/proc/${child.pid}/status`, "utf8");
    return /^State:\s+T/m.test(status) && JSON.parse(data);
  });
  extra = metadata.child;
  return { child, extra, ended, output: () => JSON.parse(output), errors: () => errors };
}

test("paused stale holder keeps the kernel gate after helper exit; all writers and init refuse", async (t) => {
  const { file, store } = await setup(t);
  const holder = await paused(t, file);
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(`${file}.lock`, old, old);
  const before = await fs.readFile(file, "utf8");
  for (const operation of ["acquire", "release", "heartbeat", "init"]) {
    assert.deepEqual(await childCall(file, operation), { ok: false, error: "desktop_lease_store_locked", statusCode: 503 });
    assert.equal(await fs.readFile(file, "utf8"), before);
  }
  holder.child.kill("SIGCONT");
  assert.deepEqual(await holder.ended, { code: 0, signal: null });
  assert.equal(holder.output().ok, true);
  assert.equal((await store.activeLease("synthetic-desk", "synthetic-owner")).purpose, "holder-finished");
});

test("owner death releases kernel lock", async (t) => {
  const { file, store } = await setup(t);
  const holder = await paused(t, file);
  holder.child.kill("SIGKILL");
  assert.equal((await holder.ended).signal, "SIGKILL");
  assert.equal((await childCall(file, "acquire")).ok, true);
  assert.equal((await store.activeLease("synthetic-desk", "synthetic-owner")).threadId, "thread-b");
});

test("unrelated child does not inherit the kernel lock descriptor", async (t) => {
  const { file } = await setup(t);
  const holder = await paused(t, file, "hold-with-child");
  assert.ok(holder.extra);
  const lock = await fs.stat(`${file}.lock`);
  for (const fd of await fs.readdir(`/proc/${holder.extra}/fd`)) {
    const observed = await fs.stat(`/proc/${holder.extra}/fd/${fd}`).catch(() => null);
    assert.ok(!observed || observed.dev !== lock.dev || observed.ino !== lock.ino);
  }
  holder.child.kill("SIGCONT");
  assert.equal((await holder.ended).code, 0);
  assert.equal(holder.output().ok, true);
  await assert.rejects(fs.stat(`/proc/${holder.extra}`), { code: "ENOENT" });
});

test("action and revocation share the gate; revocation before entry prevents effects", async (t) => {
  const { root, file, store, binding } = await setup(t);
  const effect = path.join(root, "effect");
  const holder = await paused(t, file, "action", { binding, effect, pause: true });
  assert.equal((await childCall(file, "release")).error, "desktop_lease_store_locked");
  holder.child.kill("SIGCONT");
  await holder.ended;
  assert.equal(holder.output().ok, true);
  assert.equal(await fs.readFile(effect, "utf8"), "action\n");
  assert.equal((await childCall(file, "release")).result.ok, true);
  await assert.rejects(store.withCurrentLeaseAction(binding, () => assert.fail("revoked callback entered")), /desktop_lease_action_revoked/);
});

test("exact owner, thread, lease, generation and token are mandatory without bypasses", async (t) => {
  const { store, binding } = await setup(t);
  let effects = 0;
  assert.equal(await store.withCurrentLeaseAction(binding, () => ++effects), 1);
  for (const key of Object.keys(binding)) {
    const wrong = { ...binding, [key]: key === "fencingVersion" ? binding[key] + 1 : "foreign" };
    await assert.rejects(store.withCurrentLeaseAction(wrong, () => ++effects), /desktop_lease_action_revoked/);
    const missing = { ...binding }; delete missing[key];
    await assert.rejects(store.withCurrentLeaseAction(missing, () => ++effects), /desktop_lease_action_binding_required/);
  }
  for (const bad of [null, {}, { ...binding, authorizedBreakGlass: true }, { ...binding, fencingVersion: "1" }]) {
    await assert.rejects(store.withCurrentLeaseAction(bad, () => ++effects), /desktop_lease_action_binding_required/);
  }
  await assert.rejects(store.withCurrentLeaseAction(binding, async () => ++effects), /synchronous_callback_required/);
  assert.equal(effects, 1);
});

test("expired, invalid, stale or nonexclusive current leases cannot enter actions", async (t) => {
  for (const mutation of [
    { expiresAt: null }, { expiresAt: "invalid" }, { expiresAt: new Date(Date.now() - 1).toISOString() },
    { heartbeatAt: "invalid" }, { heartbeatAt: new Date(Date.now() - 16 * 60_000).toISOString() },
    { heartbeatAt: new Date(Date.now() + 120_000).toISOString() }, { mode: "sharedRead" },
  ]) {
    const { store, binding } = await setup(t);
    await store.mutateState((state) => Object.assign(state.desktopLeases[0], mutation));
    await assert.rejects(store.withCurrentLeaseAction(binding, () => assert.fail("invalid lease entered")), /desktop_lease_(expiry_invalid|expired|heartbeat_invalid|heartbeat_stale|must_be_exclusive)/);
  }
});

test("supersession burns old binding; heartbeat preserves the exact current generation", async (t) => {
  const { store, binding } = await setup(t);
  assert.equal((await store.heartbeat("synthetic-desk", "thread-a", "synthetic-owner", binding.fencingToken)).ok, true);
  await store.withCurrentLeaseAction(binding, () => {});
  const replacement = await store.acquire({ desktopSlug: "synthetic-desk", ownerUserId: "synthetic-owner", threadId: "thread-b",
    expiresAt: new Date(Date.now() + 60_000).toISOString() }, { force: true });
  assert.equal(replacement.lease.fencingVersion, binding.fencingVersion + 1);
  await assert.rejects(store.withCurrentLeaseAction(binding, () => assert.fail("old callback entered")), /action_revoked/);
  assert.equal((await store.readAll({ includeReleased: true })).length, 2);
});

test("callback exceptions and malformed async returns release the gate", async (t) => {
  const { file, store, binding } = await setup(t);
  await assert.rejects(store.withCurrentLeaseAction(binding, () => { throw new Error("synthetic_failure"); }), /synthetic_failure/);
  assert.equal((await childCall(file, "heartbeat")).result.ok, true);
  await assert.rejects(store.withCurrentLeaseAction(binding, () => Promise.resolve("invalid")), /synchronous_callback_required/);
  assert.equal((await childCall(file, "heartbeat")).result.ok, true);
  await assert.rejects(store.mutateState(() => { throw new Error("mutation_failed"); }), /mutation_failed/);
  assert.equal((await childCall(file, "heartbeat")).result.ok, true);
});

test("corrupt state and missing initialized state refuse init without silent reset", async (t) => {
  for (const corrupt of ["{", "[]", "null", '{"fencingCounter":0,"desktopLeases":"bad"}']) {
    const { file, store } = await setup(t);
    const original = await fs.readFile(file, "utf8");
    await fs.writeFile(file, corrupt);
    await assert.rejects(store.init(), /desktop_lease_/);
    await assert.rejects(store.acquire({ desktopSlug: "other", threadId: "other" }), /desktop_lease_/);
    assert.equal(await fs.readFile(file, "utf8"), corrupt);
    await fs.writeFile(file, original);
    assert.equal((await childCall(file, "heartbeat")).result.ok, true);
  }
  const { file, store } = await setup(t);
  await fs.unlink(file);
  await assert.rejects(store.init(), /desktop_lease_state_unavailable/);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("malformed lease evidence is rejected, never filtered or assigned new authority", async (t) => {
  for (const field of ["id", "threadId", "fencingToken", "fencingVersion", "ownerUserId"]) {
    const { file, store } = await setup(t);
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    delete state.desktopLeases[0][field];
    const corrupt = JSON.stringify(state);
    await fs.writeFile(file, corrupt);
    await assert.rejects(store.init(), /desktop_lease_state_invalid/);
    assert.equal(await fs.readFile(file, "utf8"), corrupt);
  }
});

test("legacy directory lock is never stolen or removed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-legacy-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "leases.json");
  await fs.mkdir(`${file}.lock`);
  const old = new Date(Date.now() - 120_000); await fs.utimes(`${file}.lock`, old, old);
  await assert.rejects(new DesktopLeaseStore(file).init(), /desktop_lease_lock_path_invalid/);
  assert.equal((await fs.stat(`${file}.lock`)).isDirectory(), true);
});

test("a paused live legacy directory holder must exit before new source can initialize", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-live-legacy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "leases.json");
  const original = '{"fencingCounter":0,"desktopLeases":[]}';
  await fs.writeFile(file, original);
  const holder = await paused(t, file, "legacy-hold");
  const old = new Date(Date.now() - 120_000); await fs.utimes(`${file}.lock`, old, old);
  assert.equal((await childCall(file, "init")).error, "desktop_lease_lock_path_invalid");
  assert.equal((await fs.stat(`${file}.lock`)).isDirectory(), true);
  assert.equal(await fs.readFile(file, "utf8"), original);
  holder.child.kill("SIGCONT"); await holder.ended;
  assert.equal(holder.output().result.legacyHolder, true);
  assert.equal((await childCall(file, "init")).ok, true);
});

test("symlinks and replaced lock inode cannot create a second action domain", async (t) => {
  const { file, store, binding } = await setup(t);
  const holder = await paused(t, file);
  await fs.rename(`${file}.lock`, `${file}.original-lock`);
  await fs.writeFile(`${file}.lock`, "");
  assert.equal((await childCall(file, "init")).error, "desktop_lease_lock_identity_changed");
  await assert.rejects(store.withCurrentLeaseAction(binding, () => assert.fail("replacement entered")), /identity_changed/);
  holder.child.kill("SIGCONT"); await holder.ended;
  assert.equal(holder.output().error, "desktop_lease_lock_identity_changed");
  await fs.unlink(`${file}.lock`);
  await fs.symlink(`${file}.original-lock`, `${file}.lock`);
  await assert.rejects(store.init(), /desktop_lease_lock_path_invalid/);
});

test("state symlink and hardlink refuse; canonical parent alias shares the same gate", async (t) => {
  const { root, file, store } = await setup(t);
  const holder = await paused(t, file);
  const alias = `${root}-alias`;
  await fs.symlink(root, alias); t.after(() => fs.unlink(alias));
  await assert.rejects(new DesktopLeaseStore(path.join(alias, "leases.json"), { lockTimeoutMs: 200 }).init(), /store_locked/);
  holder.child.kill("SIGCONT"); await holder.ended;
  await fs.rename(file, `${file}.original`);
  await fs.symlink(`${file}.original`, file);
  await assert.rejects(store.init(), /state_unavailable/);
  await fs.unlink(file); await fs.link(`${file}.original`, file);
  await assert.rejects(store.init(), /state_invalid/);
});

test("replacing the canonical parent refuses both old and new lock holders", async (t) => {
  const { root, file } = await setup(t);
  const original = await fs.readFile(file, "utf8");
  const holder = await paused(t, file);
  const moved = `${root}-moved`;
  t.after(() => fs.rm(moved, { recursive: true, force: true }));
  await fs.rename(root, moved);
  await fs.mkdir(root);
  await fs.writeFile(file, original);
  assert.equal((await childCall(file, "init")).error, "desktop_lease_lock_identity_changed");
  holder.child.kill("SIGCONT"); await holder.ended;
  assert.equal(holder.output().error, "desktop_lease_lock_identity_changed");
  assert.equal(await fs.readFile(path.join(moved, "leases.json"), "utf8"), original);
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("independent acquisitions and init retain every generation without lost updates", async (t) => {
  const { file, store } = await setup(t);
  const operations = Array.from({ length: 6 }, (_, index) => childCall(file, "acquire", {
    desktopSlug: `synthetic-desk-${index}`, threadId: `thread-${index}`, timeoutMs: 3000,
  }));
  operations.push(childCall(file, "init", { timeoutMs: 3000 }), childCall(file, "init", { timeoutMs: 3000 }));
  for (const result of await Promise.all(operations)) assert.equal(result.ok, true, JSON.stringify(result));
  const state = await store.readState();
  assert.equal(state.fencingCounter, 7);
  assert.equal(state.desktopLeases.length, 7);
  assert.deepEqual(state.desktopLeases.map((lease) => lease.fencingVersion).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(state.desktopLeases.map((lease) => lease.desktopSlug)).size, 7);
});

test("valid offline legacy adoption preserves every field and init is idempotent", async (t) => {
  const { root, store } = await setup(t);
  const { lease } = await store.acquire({ desktopSlug: "synthetic-desk", ownerUserId: "synthetic-owner", threadId: "thread-b",
    expiresAt: new Date(Date.now() + 60_000).toISOString() }, { force: true });
  const legacy = await store.readState();
  delete legacy.lockIdentity;
  legacy.extension = { retained: true };
  legacy.desktopLeases[1].extension = "retained historical field";
  const file = path.join(root, "legacy.json");
  const original = JSON.stringify(legacy);
  await fs.writeFile(file, original);
  const adopted = new DesktopLeaseStore(file);
  const binding = { desktopSlug: lease.desktopSlug, ownerUserId: lease.ownerUserId, threadId: lease.threadId,
    leaseId: lease.id, fencingVersion: lease.fencingVersion, fencingToken: lease.fencingToken };
  await assert.rejects(adopted.withCurrentLeaseAction(binding, () => assert.fail("uninitialized entry")), /store_uninitialized/);
  assert.equal(await fs.readFile(file, "utf8"), original);
  await adopted.init();
  const initialized = await fs.readFile(file, "utf8");
  const retained = JSON.parse(initialized); delete retained.lockIdentity;
  assert.deepEqual(retained, legacy);
  await adopted.init();
  assert.equal(await fs.readFile(file, "utf8"), initialized);
  assert.equal(await adopted.withCurrentLeaseAction(binding, () => "current"), "current");
});

test("counter regression and exhaustion fail without state loss and release the gate", async (t) => {
  const { file, store } = await setup(t);
  const original = await fs.readFile(file, "utf8");
  await assert.rejects(store.mutateState((state) => { state.fencingCounter = 0; }), /generation_regressed/);
  assert.equal(await fs.readFile(file, "utf8"), original);
  assert.equal((await childCall(file, "heartbeat")).result.ok, true);
  await store.mutateState((state) => { state.fencingCounter = Number.MAX_SAFE_INTEGER; });
  const exhausted = await fs.readFile(file, "utf8");
  assert.equal((await childCall(file, "acquire")).error, "desktop_lease_generation_exhausted");
  assert.equal(await fs.readFile(file, "utf8"), exhausted);
  assert.equal((await childCall(file, "heartbeat")).result.ok, true);
});

test("hardlinked lock and corrupt marker refuse without changing lease evidence", async (t) => {
  const { file, store } = await setup(t);
  const original = await fs.readFile(file, "utf8");
  await fs.link(`${file}.lock`, `${file}.other-lock`);
  await assert.rejects(store.init(), /lock_path_invalid/);
  await fs.unlink(`${file}.other-lock`);
  await fs.writeFile(`${file}.lock`, "corrupt");
  await assert.rejects(store.init(), /lock_marker_invalid/);
  assert.equal(await fs.readFile(file, "utf8"), original);
});
