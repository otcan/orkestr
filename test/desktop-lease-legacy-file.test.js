import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desktopLeaseStore } from "../packages/browsers/src/desktop-lease-store.js";
import { prepared, sha } from "./fixtures/desktop-lease-legacy-state.js";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/desktop-lease-legacy-worker.mjs", import.meta.url));
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-legacy-receipt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = prepared(), file = path.join(root, "desktop-leases.json"), receipt = path.join(root, "operator-receipt.json");
  const receiptBytes = Buffer.from(`${JSON.stringify(result.adoption)}\n`);
  await fs.writeFile(file, result.bytes, { mode: 0o600 });
  await fs.writeFile(receipt, receiptBytes, { mode: 0o400 });
  const env = { ORKESTR_HOME: root, ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_PATH: receipt,
    ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_SHA256: sha(receiptBytes) };
  return { root, file, receipt, receiptBytes, env, ...result };
}

test("ordinary factory loads only explicitly pinned protected receipt; subprocess reopens the same contract", async (t) => {
  const { env, file, bytes } = await setup(t);
  await assert.rejects(desktopLeaseStore({ ORKESTR_HOME: env.ORKESTR_HOME }).init(), /legacy_adoption_invalid/);
  assert.deepEqual(await fs.readFile(file), bytes);
  const { stdout } = await run(process.execPath, [fixture], { env: { ...env, PATH: "/usr/bin:/bin" }, timeout: 5000 });
  assert.deepEqual(JSON.parse(stdout), { version: 9, retired: 2 });
  const reopened = desktopLeaseStore(env); await reopened.init();
  assert.equal((await reopened.readAll({ includeReleased: true })).length, 3);
});

test("partial/malformed configuration cannot silently fall back to ordinary state", async (t) => {
  const { env, file, bytes } = await setup(t);
  for (const config of [
    { ...env, ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_SHA256: undefined },
    { ...env, ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_PATH: undefined },
    { ...env, ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_PATH: "relative.json" },
    { ...env, ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_SHA256: "invalid" },
  ]) assert.throws(() => desktopLeaseStore(config), /adoption_config_invalid/);
  await assert.rejects(desktopLeaseStore({ ...env, ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_SHA256: "0".repeat(64) }).init(), /adoption_unavailable/);
  assert.deepEqual(await fs.readFile(file), bytes);
  await assert.rejects(fs.stat(`${file}.lock`), { code: "ENOENT" });
});

test("receipt symlink, parent alias, hardlink, FIFO and writable mode refuse without touching state", async (t) => {
  for (const kind of ["symlink", "parent-alias", "hardlink", "fifo", "mode"]) {
    const { root, receipt, env, file, bytes } = await setup(t);
    let target = receipt;
    if (kind === "symlink" || kind === "hardlink") {
      target = path.join(root, "alias.json");
      if (kind === "symlink") await fs.symlink(receipt, target); else await fs.link(receipt, target);
    } else if (kind === "parent-alias") {
      const alias = path.join(root, "directory-alias"); await fs.symlink(root, alias);
      target = path.join(alias, path.basename(receipt));
    } else if (kind === "fifo") {
      target = path.join(root, "pipe"); await run("/usr/bin/mkfifo", [target]);
    } else await fs.chmod(receipt, 0o622);
    await assert.rejects(desktopLeaseStore({ ...env, ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_PATH: target }).init(), /adoption_unavailable/);
    assert.deepEqual(await fs.readFile(file), bytes);
    await assert.rejects(fs.stat(`${file}.lock`), { code: "ENOENT" });
  }
});

test("pinned receipt still rejects duplicate keys, malformed content and oversize input", async (t) => {
  for (const raw of ["{", '{"format":"a","format":"b"}', "x".repeat(1024 * 1024 + 1)]) {
    const { receipt, env, file, bytes } = await setup(t);
    await fs.chmod(receipt, 0o600); await fs.writeFile(receipt, raw);
    await assert.rejects(desktopLeaseStore({ ...env, ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_SHA256: sha(raw) }).init(), /desktop_lease_/);
    assert.deepEqual(await fs.readFile(file), bytes);
  }
});

test("failed configuration stays failed for its store instance; state marker cannot heal it", async (t) => {
  const { env, receipt, receiptBytes, file, bytes } = await setup(t);
  await fs.chmod(receipt, 0o600); await fs.writeFile(receipt, "{}");
  const store = desktopLeaseStore(env);
  await assert.rejects(store.init(), /adoption_unavailable/);
  await fs.writeFile(receipt, receiptBytes);
  await assert.rejects(store.init(), /adoption_unavailable/);
  assert.deepEqual(await fs.readFile(file), bytes);
  await desktopLeaseStore(env).init();
});

test("correctly pinned BOM receipt refuses before acquiring the state lock", async (t) => {
  const { receipt, receiptBytes, env, file, bytes } = await setup(t);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), receiptBytes]);
  await fs.chmod(receipt, 0o600); await fs.writeFile(receipt, bom);
  await assert.rejects(desktopLeaseStore({ ...env, ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_SHA256: sha(bom) }).init(), /legacy_encoding_invalid/);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual(await fs.readFile(receipt), bom);
  await assert.rejects(fs.stat(`${file}.lock`), { code: "ENOENT" });
});

test("correctly pinned BOM prepared state refuses without adoption or rewriting", async (t) => {
  const { receipt, env, file, bytes, adoption } = await setup(t);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
  const receiptBytes = Buffer.from(JSON.stringify({ ...adoption, preparedSha256: sha(bom) }));
  await fs.writeFile(file, bom);
  await fs.chmod(receipt, 0o600); await fs.writeFile(receipt, receiptBytes);
  await assert.rejects(desktopLeaseStore({ ...env, ORKESTR_DESKTOP_LEASE_LEGACY_ADOPTION_SHA256: sha(receiptBytes) }).init(), /state_invalid/);
  assert.deepEqual(await fs.readFile(file), bom);
  assert.deepEqual(await fs.readFile(receipt), receiptBytes);
  assert.equal((await fs.stat(`${file}.lock`)).size, 0);
});
