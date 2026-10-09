import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { userPrincipal } from "../packages/core/src/principal.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { agentListItems, agentReadSecret } from "../packages/core/src/vault-agent.js";
import {
  createVaultRequestLink,
  listVaultRequests,
  revokeVaultRequest,
  submitVaultRequestLink,
} from "../packages/core/src/vault-requests.js";
import { createVaultItem, listVaultItems, setVaultGrants } from "../packages/core/src/vault-service.js";
import { mutateVault, vaultFilePath } from "../packages/core/src/vault-store.js";

// Synthetic users, threads and values only.

const managed = ["ORKESTR_HOME", "ORKESTR_VAULT_AGENT_READ_LIMIT"];
let home;

test.before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-vault-single-use-"));
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_VAULT_AGENT_READ_LIMIT = "1000";
  await createThread({ id: "su-thread", name: "Single-use worker", ownerUserId: "alice" }, process.env);
  await createThread({ id: "su-other", name: "Other worker", ownerUserId: "alice" }, process.env);
});

test.after(async () => {
  for (const key of managed) delete process.env[key];
  await fs.rm(home, { recursive: true, force: true });
});

function owner(id) {
  return { ...userPrincipal({ id, role: "user" }), vaultOwner: true, authenticatedAt: new Date().toISOString() };
}

async function treeText(root) {
  let text = "";
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(root, entry.name);
    text += entry.isDirectory() ? await treeText(full) : await fs.readFile(full, "utf8").catch(() => "");
  }
  return text;
}

async function storedRecord(ownerId, itemId) {
  const raw = JSON.parse(await fs.readFile(await vaultFilePath(ownerId), "utf8"));
  return raw.items.find((item) => item.id === itemId);
}

test("single-use item is released exactly once under concurrent agent reads", async () => {
  const alice = owner("alice");
  const password = "synthetic-once-password-5d1a";
  const { item } = await createVaultItem(alice, { name: "Once Mail", username: "a@example.com", password, singleUse: true, ttl: "10m" });
  assert.equal(item.singleUse, true);
  assert.equal(item.singleUseStatus, "active");
  await setVaultGrants(alice, item.id, ["su-thread"]);

  const results = await Promise.allSettled(Array.from({ length: 8 }, () => agentReadSecret("su-thread", item.id, ["username", "password"])));
  const released = results.filter((result) => result.status === "fulfilled");
  assert.equal(released.length, 1, "exactly one release");
  assert.equal(released[0].value.password, password);
  for (const result of results.filter((entry) => entry.status === "rejected")) {
    assert.equal(result.reason.statusCode, 410);
    assert.equal(result.reason.code, "vault_item_used");
  }

  const record = await storedRecord("alice", item.id);
  assert.equal(record.secret, undefined, "ciphertext destroyed");
  assert.equal(record.singleUseStatus, "used");
  assert.equal(record.usedByThreadId, "su-thread");
  const listed = (await listVaultItems(alice)).items.find((entry) => entry.id === item.id);
  assert.equal(listed.singleUseStatus, "used");
  assert.equal(listed.hasPassword, false);
  const agentView = (await agentListItems("su-thread")).items.find((entry) => entry.id === item.id);
  assert.equal(agentView.singleUseStatus, "used");

  const allText = await treeText(home);
  assert.equal(allText.includes(password), false, "value never stored in clear or logged");
  assert.match(allText, /vault_single_use_consumed/);
});

test("expired single-use item is wiped and never released", async () => {
  const alice = owner("alice");
  const { item } = await createVaultItem(alice, { name: "Expiring", password: "synthetic-expiring-81f0", singleUse: true, ttl: "1m" });
  await setVaultGrants(alice, item.id, ["su-thread"]);
  await mutateVault("alice", (store) => {
    store.items.find((entry) => entry.id === item.id).singleUseExpiresAt = new Date(Date.now() - 1000).toISOString();
  });
  const listed = (await listVaultItems(alice)).items.find((entry) => entry.id === item.id);
  assert.equal(listed.singleUseStatus, "expired");
  assert.equal((await storedRecord("alice", item.id)).secret, undefined, "expiry wipes ciphertext");
  await assert.rejects(agentReadSecret("su-thread", item.id), (error) => error.code === "vault_item_expired" && error.statusCode === 410);
  assert.match(await treeText(home), /vault_single_use_expired/);
});

test("request into vault: owner submission becomes an item granted only to the requesting thread", async () => {
  const password = "synthetic-requested-password-2be7";
  const created = await createVaultRequestLink("su-thread", { name: "Example Bank", once: true, usernameToo: true, ttl: "15m", label: "Login for the report" });
  assert.match(created.url, /\/s\/[A-Za-z0-9_-]{43}$/);
  assert.equal(created.request.status, "active");
  assert.equal(created.request.once, true);
  const token = created.url.split("/").pop();

  assert.equal((await submitVaultRequestLink(token, { password }, { userId: "bob" })).state, "unknown", "other users cannot submit");
  const attempts = [password, `${password}-concurrent`];
  const submits = await Promise.all(attempts.map((value) => submitVaultRequestLink(token, { password: value, username: "alice@example.com" }, { userId: "alice" })));
  assert.deepEqual(submits.map((result) => result.state).sort(), ["ended", "submitted"]);
  const submitted = submits.find((result) => result.state === "submitted");
  const stored = attempts[submits.indexOf(submitted)];
  const itemId = submitted.item.id;

  const items = (await listVaultItems(owner("alice"))).items.filter((entry) => entry.name === "Example Bank");
  assert.equal(items.length, 1, "concurrent submits store one item");
  assert.deepEqual(items[0].threadGrants, [{ threadId: "su-thread" }]);
  assert.equal(items[0].singleUse, true);
  await assert.rejects(agentReadSecret("su-other", "Example Bank"), (error) => error.code === "vault_item_not_found");
  const read = await agentReadSecret("su-thread", "Example Bank");
  assert.equal(read.password, stored);
  assert.equal(read.username, "alice@example.com");

  const messages = await listThreadMessages("su-thread", process.env);
  const note = messages.find((message) => message.source === "vault_request");
  assert.ok(note, "record-only note appended");
  assert.match(note.text, new RegExp(itemId));
  assert.equal(JSON.stringify(messages).includes(password), false);
  const requests = (await listVaultRequests(owner("alice"))).requests;
  assert.equal(requests.find((entry) => entry.id === created.request.id).status, "used");
  assert.equal((await listVaultRequests(owner("bob"))).requests.length, 0);
  assert.equal((await treeText(home)).includes(password), false);
  assert.equal((await treeText(home)).includes(token), false);
});

test("saved request items persist; pending requests can be revoked by their owner only", async () => {
  const created = await createVaultRequestLink("su-other", { name: "Saved Portal" });
  const token = created.url.split("/").pop();
  await assert.rejects(revokeVaultRequest(owner("bob"), created.request.id), (error) => error.statusCode === 404);
  assert.equal((await revokeVaultRequest(owner("alice"), created.request.id)).status, "revoked");
  assert.equal((await submitVaultRequestLink(token, { password: "synthetic-late" }, { userId: "alice" })).state, "ended");

  const saved = await createVaultRequestLink("su-other", { name: "Saved Portal" });
  await submitVaultRequestLink(saved.url.split("/").pop(), { password: "synthetic-saved-6a0c" }, { userId: "alice" });
  for (let index = 0; index < 2; index += 1) assert.equal((await agentReadSecret("su-other", "Saved Portal")).password, "synthetic-saved-6a0c");
});
