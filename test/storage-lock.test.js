import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withStorageFileLock } from "../packages/storage/src/storage-lock.js";

function waitForLine(child, expected) {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(expected)) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => code && reject(new Error(`lock holder exited ${code}: ${output}`)));
  });
}

test("storage lock heartbeat prevents stale takeover of a live cross-process owner", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-storage-lock-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const target = path.join(home, "canonical");
  const lockUrl = new URL("../packages/storage/src/storage-lock.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { withStorageFileLock } from ${JSON.stringify(lockUrl)};
    await withStorageFileLock(${JSON.stringify(target)}, async () => {
      process.stdout.write("held\\n");
      await new Promise((resolve) => setTimeout(resolve, 220));
    }, { heartbeatMs: 10, staleMs: 40, timeoutMs: 500 });
  `], { stdio: ["ignore", "pipe", "pipe"] });
  await waitForLine(child, "held");
  await assert.rejects(withStorageFileLock(target, async () => {}, {
    heartbeatMs: 10, staleMs: 40, timeoutMs: 90,
  }), /runtime_lease_store_locked/);
  assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
});

test("storage lock serializes three cross-process contenders without lost writes", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-storage-lock-stress-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const target = path.join(home, "canonical");
  const counter = path.join(home, "counter.txt");
  await fs.writeFile(counter, "0");
  const lockUrl = new URL("../packages/storage/src/storage-lock.js", import.meta.url).href;
  const script = `
    import fs from "node:fs/promises";
    import { withStorageFileLock } from ${JSON.stringify(lockUrl)};
    for (let index = 0; index < 15; index += 1) {
      await withStorageFileLock(${JSON.stringify(target)}, async () => {
        const value = Number(await fs.readFile(${JSON.stringify(counter)}, "utf8"));
        await new Promise((resolve) => setTimeout(resolve, 2 + Math.floor(Math.random() * 5)));
        await fs.writeFile(${JSON.stringify(counter)}, String(value + 1));
      }, { heartbeatMs: 5, staleMs: 30, timeoutMs: 5000 });
    }
  `;
  const children = Array.from({ length: 3 }, () => spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" }));
  const results = await Promise.all(children.map((child) => new Promise((resolve) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => resolve({ code, stderr }));
  })));
  assert.deepEqual(results.map((item) => item.code), [0, 0, 0], results.map((item) => item.stderr).join("\n"));
  assert.equal(await fs.readFile(counter, "utf8"), "45");
});

test("storage lock release cannot remove a successor lock", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-storage-lock-successor-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const target = path.join(home, "canonical");
  const lockPath = `${target}.lock`;
  const successorToken = "successor-token";
  await withStorageFileLock(target, async () => {
    const displaced = `${lockPath}.displaced`;
    await fs.rename(lockPath, displaced);
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token: successorToken }));
    await fs.rm(displaced, { recursive: true, force: true });
  }, { heartbeatMs: 0 });
  const successor = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
  assert.equal(successor.token, successorToken);
});
