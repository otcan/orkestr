import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { acquireDesktopLease } from "../packages/browsers/src/desktop-leases.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { createThread } from "../packages/core/src/threads.js";
import { agentReadSecret } from "../packages/core/src/vault-agent.js";
import { agentFillDesktop } from "../packages/core/src/vault-fill.js";
import { createVaultReceiveLink, submitVaultReceiveLink } from "../packages/core/src/vault-receive-links.js";
import { createVaultRequestLink, submitVaultRequestLink } from "../packages/core/src/vault-requests.js";
import { readVault } from "../packages/core/src/vault-store.js";

// Integration of the Vault link features with single-use items: a
// request-into-vault `--once` item is released by one desktop fill, and a
// receive `--once` item by one `vault exec` read. Synthetic users, threads,
// desktops and values only; browserctl, xdotool and DevTools are fakes.

const PASSWORD = "synthetic-links-password-41c9";
const alice = userPrincipal({ id: "alice", role: "user" });
const managed = ["ORKESTR_HOME", "ORKESTR_BROWSERCTL_PATH", "ORKESTR_DESKTOP_KEYSTROKE_COMMAND", "ORKESTR_VAULT_AGENT_READ_LIMIT", "ORKESTR_BROWSER_SESSIONS_CACHE_MS"];
const saved = Object.fromEntries(managed.map((key) => [key, process.env[key]]));
let cdp;
let typistLog;

async function startFakeCdp() {
  const server = http.createServer((request, response) => {
    const { port } = server.address();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/json/list" ? [{ type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }] : {}));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.on("message", (data) => {
    const focused = { focused: true, tag: "input", type: "password", writable: true, formHasPassword: true };
    socket.send(JSON.stringify({ id: JSON.parse(String(data)).id, result: { result: { value: focused } } }));
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, wss, url: `http://127.0.0.1:${server.address().port}` };
}

async function writeExecutable(file, content) {
  await fs.writeFile(file, content, { mode: 0o755 });
  return file;
}

function encryptFor(publicKey, value) {
  const key = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
  const raw = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", raw, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify({ u: "", p: value })), cipher.final(), cipher.getAuthTag()]);
  const wk = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, raw);
  return { v: 1, alg: "RSA-OAEP-256+A256GCM", wk: wk.toString("base64url"), iv: iv.toString("base64url"), ct: ct.toString("base64url") };
}

async function itemStatus(itemId) {
  return (await readVault("alice")).items.find((item) => item.id === itemId);
}

test.before(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-vault-links-"));
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-vault-links-bin-"));
  typistLog = path.join(bin, "typist.log");
  cdp = await startFakeCdp();
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_BROWSERCTL_PATH: await writeExecutable(path.join(bin, "fake-browserctl"), `#!/usr/bin/env node
const session = { slug: "example-desk", display: ":95", cdp_url: ${JSON.stringify(cdp.url)} };
process.stdout.write(JSON.stringify(process.argv[2] === "target" ? { ok: true, session } : { ok: true, sessions: [session] }));
`),
    ORKESTR_DESKTOP_KEYSTROKE_COMMAND: await writeExecutable(path.join(bin, "fake-xdotool"), `#!/bin/sh
cat >> ${JSON.stringify(typistLog)}
`),
    ORKESTR_VAULT_AGENT_READ_LIMIT: "1000",
    ORKESTR_BROWSER_SESSIONS_CACHE_MS: "0",
  });
  await createThread({ id: "alice-thread", name: "alice-thread", ownerUserId: "alice" }, process.env);
  await acquireDesktopLease("example-desk", { threadId: "alice-thread", threadName: "alice-thread" }, process.env, { principal: alice });
});

test.after(async () => {
  cdp?.wss.close();
  await new Promise((resolve) => cdp?.server.close(resolve));
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("request-into-vault --once: the first fill consumes the item, the second is refused", async () => {
  const created = await createVaultRequestLink("alice-thread", { name: "Example Bank", once: true, ttl: "15m" });
  const token = new URL(created.url).pathname.split("/").pop();
  const submitted = await submitVaultRequestLink(token, { password: PASSWORD }, alice);
  assert.equal(submitted.state, "submitted");
  assert.equal((await itemStatus(submitted.item.id)).singleUseStatus, "active");

  assert.deepEqual(await agentFillDesktop("alice-thread", "Example Bank", { desktop: "example-desk" }), { status: "filled" });
  assert.equal(await fs.readFile(typistLog, "utf8"), PASSWORD);
  const used = await itemStatus(submitted.item.id);
  assert.equal(used.singleUseStatus, "used");
  assert.equal(used.secret, undefined);

  await assert.rejects(agentFillDesktop("alice-thread", "Example Bank", { desktop: "example-desk" }), { code: "vault_item_used" });
  await assert.rejects(agentReadSecret("alice-thread", "Example Bank", ["password"]), { code: "vault_item_used" });
  assert.equal(await fs.readFile(typistLog, "utf8"), PASSWORD, "nothing typed after the release");
});

test("receive --once: vault exec releases the item exactly once", async () => {
  const created = await createVaultReceiveLink({ name: "Example Portal", once: true, threadId: "alice-thread" }, alice);
  const store = JSON.parse(await fs.readFile(path.join(process.env.ORKESTR_HOME, "secrets", "secret-links.json"), "utf8"));
  const publicKey = store.links.find((link) => link.id === created.link.id).publicKey;
  const submitted = await submitVaultReceiveLink(new URL(created.url).pathname.split("/").pop(), encryptFor(publicKey, PASSWORD));
  assert.equal(submitted.state, "submitted");
  const itemId = submitted.link.itemId;
  const received = await itemStatus(itemId);
  assert.equal(received.singleUseStatus, "active");
  assert.ok(Date.parse(received.singleUseExpiresAt) > Date.now() + 23 * 60 * 60 * 1000);

  const reads = await Promise.allSettled([agentReadSecret("alice-thread", itemId, ["password"]), agentReadSecret("alice-thread", itemId, ["password"])]);
  assert.deepEqual(reads.filter((read) => read.status === "fulfilled").map((read) => read.value.password), [PASSWORD]);
  assert.equal(reads.find((read) => read.status === "rejected").reason.code, "vault_item_used");
  assert.equal((await itemStatus(itemId)).singleUseStatus, "used");
});
