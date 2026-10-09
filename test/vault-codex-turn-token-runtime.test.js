import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverCodexAppServerPendingInputs, stopCodexAppServerClients } from "../packages/core/src/codex-app-server.js";
import { createThread, enqueueThreadInput, listThreadMessages } from "../packages/core/src/threads.js";
import { codexVaultTokenFile } from "../packages/core/src/vault-codex-turn-tokens.js";
import { threadIdForVaultToken } from "../packages/core/src/vault-thread-tokens.js";

// A minimal fake Codex app-server: on turn/start it copies the turn's vault
// token file (as `orkestr vault` would read it via CODEX_THREAD_ID), then
// holds the turn open until the test creates the go file. Synthetic values only.

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function treeIncludes(root, value, skip) {
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(root, entry.name);
    if (skip.has(full)) continue;
    if (entry.isDirectory() ? await treeIncludes(full, value, skip) : (await fs.readFile(full, "utf8").catch(() => "")).includes(value)) return true;
  }
  return false;
}

async function createFakeCodex(home) {
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), `#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli fake"); process.exit(0); }
if (args[0] === "login") { console.log("Logged in using API key"); process.exit(0); }
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
  if (method === "thread/start") {
    const thread = { id: "thr_" + String(threads.size + 1).padStart(3, "0"), cwd: params.cwd || "", status: { type: "idle" }, turns: [] };
    threads.set(thread.id, thread);
    send({ id, result: { thread } });
    return send({ method: "thread/started", params: { thread } });
  }
  if (method === "thread/read" || method === "thread/resume") return send({ id, result: { thread: threads.get(params.threadId) || { id: params.threadId, turns: [] } } });
  if (method === "turn/start") {
    count += 1;
    const turn = { id: "turn_" + count, threadId: params.threadId, status: "inProgress", items: [] };
    const file = path.join(process.env.ORKESTR_HOME, "secrets", "vault-turn-tokens", createHash("sha256").update(params.threadId).digest("hex") + ".json");
    fs.writeFileSync(path.join(dir, "seen-" + params.threadId), fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).token : "");
    send({ id, result: { turn } });
    send({ method: "turn/started", params: { turn } });
    const go = path.join(dir, "go-" + params.threadId);
    const timer = setInterval(() => {
      if (!fs.existsSync(go)) return;
      clearInterval(timer);
      const agent = { type: "agentMessage", id: "agent_" + turn.id, text: "done", phase: "final_answer" };
      send({ method: "item/completed", params: { threadId: params.threadId, turnId: turn.id, item: agent } });
      send({ method: "turn/completed", params: { turn: { ...turn, status: "completed", items: [agent] } } });
    }, 20);
    return;
  }
  send({ id, result: {} });
});
`, { mode: 0o755 });
  return bin;
}

test("codex turns get their own thread-bound vault token, revoked at turn end", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ork-vault-codex-runtime-"));
  t.after(async () => {
    stopCodexAppServerClients();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const bin = await createFakeCodex(home);
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_DIR: home,
  };
  const threads = [];
  for (const name of ["a", "b"]) {
    threads.push(await createThread({
      id: `codex-vault-${name}`,
      name: `Codex vault ${name}`,
      cwd: home,
      workspace: home,
      runtimeKind: "codex-app-server",
      runtime: { runtimeKind: "codex-app-server" },
      executorId: "codex",
      executor: { id: "codex", type: "codex", transport: "app-server" },
    }, env));
  }
  for (const thread of threads) {
    await enqueueThreadInput(thread.id, { text: "use the vault" }, env);
    await deliverCodexAppServerPendingInputs(thread, env);
  }

  const tokenA = await waitFor(async () => (await fs.readFile(path.join(home, "seen-thr_001"), "utf8").catch(() => "")).trim());
  const tokenB = await waitFor(async () => (await fs.readFile(path.join(home, "seen-thr_002"), "utf8").catch(() => "")).trim());
  assert.match(tokenA, /^ovt_/);
  assert.notEqual(tokenA, tokenB);
  assert.equal(await threadIdForVaultToken(tokenA, env), "codex-vault-a");
  assert.equal(await threadIdForVaultToken(tokenB, env), "codex-vault-b");

  await fs.writeFile(path.join(home, "go-thr_001"), "");
  await waitFor(async () => (await threadIdForVaultToken(tokenA, env)) === "");
  await assert.rejects(fs.stat(codexVaultTokenFile("thr_001", env.ORKESTR_HOME)), { code: "ENOENT" });
  assert.equal(await threadIdForVaultToken(tokenB, env), "codex-vault-b", "thread B keeps its token while its turn runs");
  await fs.writeFile(path.join(home, "go-thr_002"), "");
  await waitFor(async () => (await threadIdForVaultToken(tokenB, env)) === "");
  await waitFor(async () => (await listThreadMessages(threads[1].id, env)).some((message) => message.phase === "final_answer"));

  const skip = new Set([path.join(home, "seen-thr_001"), path.join(home, "seen-thr_002")]);
  for (const token of [tokenA, tokenB]) {
    assert.equal(await treeIncludes(home, token, skip), false, "token never lands in logs, events, messages or the perf log");
  }
});
