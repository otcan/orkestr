import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyStateFile, cleanupStaleStateFiles } from "../packages/storage/src/state-file-cleanup.js";
import { writeJson } from "../packages/storage/src/store.js";

const hour = 60 * 60 * 1000;
const day = 24 * hour;

async function makeHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-state-cleanup-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, "thread-messages"));
  return home;
}

async function touch(filePath, ageMs, now, content = "x") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  const at = new Date(now - ageMs);
  await fs.utimes(filePath, at, at);
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

test("classifies only the exact temp and pre-backup patterns", () => {
  assert.deepEqual(classifyStateFile(".threads.json.1234.1760000000000.a1b2c3.tmp"), { kind: "temp", source: "threads.json" });
  assert.deepEqual(classifyStateFile("whatsapp.json.pre-history-scrub-20260101T120000Z"), { kind: "pre-backup", source: "whatsapp.json" });
  assert.deepEqual(classifyStateFile("threads.json.pre-migration-20260101T120000+0200"), { kind: "pre-backup", source: "threads.json" });
  for (const name of [
    "threads.json",
    "threads.sqlite.pre-migration-20260101T120000+0200",
    "threads.sqlite-wal.pre-migration-20260101T120000+0200",
    "threads.json.tmp",
    ".threads.json.1234.abc.def.tmp",
    "desktop-leases.json.1234.8c5e4a40-0000-4000-8000-000000000000.tmp",
    "owner.1234.8c5e4a40-0000-4000-8000-000000000000.tmp",
    "whatsapp.json.pre-scrub",
    "whatsapp.json.pre-Scrub-20260101T120000Z",
  ]) assert.equal(classifyStateFile(name), null, name);
});

test("removes stale temp files and old surplus pre-backups only", async (t) => {
  const home = await makeHome(t);
  const now = Date.now();
  const env = { ORKESTR_HOME: home };
  const p = (...parts) => path.join(home, ...parts);

  await touch(p(".threads.json.11.1760000000000.ab12.tmp"), 2 * hour, now);
  await touch(p(".whatsapp.json.12.1760000000001.cd34.tmp"), 10 * 60 * 1000, now);
  await touch(p("thread-messages", ".thread-a.json.13.1760000000002.ef56.tmp"), 3 * hour, now);
  for (let i = 0; i < 5; i += 1) {
    await touch(p(`whatsapp.json.pre-scrub-${i}-20260101T12000${i}Z`), (10 + i) * day, now, "backup");
  }
  await touch(p("thread-messages", "thread-a.json.pre-footer-scrub-20260101T120000Z"), 30 * day, now);
  await touch(p("threads.json.pre-a-20260101T120000Z"), 3 * hour, now);
  await touch(p("threads.json.pre-b-20260101T120000Z"), 2 * hour, now);
  await touch(p("threads.json.pre-c-20260101T120000Z"), 1 * hour, now);
  await touch(p("threads.json.pre-d-20260101T120000Z"), 0, now);
  const kept = [
    p("threads.sqlite.pre-migration-20260101T120000+0200"),
    p("secrets", ".token.json.1.1760000000000.ab.tmp"),
    p("users", "user-1", ".threads.json.1.1760000000000.ab.tmp"),
    p("thread-messages", "thread-a.json.lock", "owner.1.8c5e4a40-0000-4000-8000-000000000000.tmp"),
    p("threads.json"),
  ];
  for (const filePath of kept) await touch(filePath, 90 * day, now);

  const preview = await cleanupStaleStateFiles(env, { now, dryRun: true });
  assert.equal(preview.removed.length, 4);
  assert.equal(await exists(p(".threads.json.11.1760000000000.ab12.tmp")), true);

  const result = await cleanupStaleStateFiles(env, { now });
  assert.deepEqual(result.removed.map((item) => path.relative(home, item.path)).sort(), [
    ".threads.json.11.1760000000000.ab12.tmp",
    path.join("thread-messages", ".thread-a.json.13.1760000000002.ef56.tmp"),
    "whatsapp.json.pre-scrub-3-20260101T120003Z",
    "whatsapp.json.pre-scrub-4-20260101T120004Z",
  ].sort());
  assert.equal(result.removedBytes, 1 + 1 + 6 + 6);
  assert.deepEqual(result.errors, []);
  assert.equal(await exists(p(".whatsapp.json.12.1760000000001.cd34.tmp")), true);
  for (let i = 0; i < 3; i += 1) assert.equal(await exists(p(`whatsapp.json.pre-scrub-${i}-20260101T12000${i}Z`)), true);
  assert.equal(await exists(p("thread-messages", "thread-a.json.pre-footer-scrub-20260101T120000Z")), true);
  for (const name of ["a", "b", "c", "d"]) assert.equal(await exists(p(`threads.json.pre-${name}-20260101T120000Z`)), true);
  for (const filePath of kept) assert.equal(await exists(filePath), true, filePath);
});

test("ignores symlinks and directories that match the patterns", async (t) => {
  const home = await makeHome(t);
  const now = Date.now();
  const outside = path.join(home, "outside.json");
  await touch(outside, 2 * hour, now);
  await fs.symlink(outside, path.join(home, ".threads.json.1.1760000000000.ab.tmp"));
  await fs.mkdir(path.join(home, ".whatsapp.json.1.1760000000000.ab.tmp"));
  const result = await cleanupStaleStateFiles({ ORKESTR_HOME: home }, { now: now + day });
  assert.deepEqual(result.removed, []);
  assert.equal(await exists(outside), true);
});

test("cleanup tolerates a missing ORKESTR_HOME", async () => {
  const result = await cleanupStaleStateFiles({ ORKESTR_HOME: path.join(os.tmpdir(), "orkestr-missing-home-does-not-exist") });
  assert.deepEqual(result.removed, []);
});

test("atomic JSON writes remove their temp file when the write fails", async (t) => {
  const home = await makeHome(t);
  const target = path.join(home, "target.json");
  await fs.mkdir(target);
  await assert.rejects(writeJson(target, { ok: true }));
  const leftovers = (await fs.readdir(home)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});
