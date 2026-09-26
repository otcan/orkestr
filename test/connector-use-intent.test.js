import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConnectorUseIntent, consumeConnectorUseIntent } from "../packages/core/src/connector-use-intent.js";

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-intent-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function intentsPath(dir, userId) {
  return path.join(dir, "users", userId, "secrets", "connector-intents.json");
}

// ORK-512 / ORK-513: one-time intent creation and consumption

test("createConnectorUseIntent returns intentId and plaintext token", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const result = await createConnectorUseIntent("alice", { connector: "gmail", purpose: "oauth_start" }, env);
  assert.ok(result.intentId.startsWith("cintent_"), "intentId must start with cintent_");
  assert.ok(typeof result.token === "string" && result.token.length >= 32);
  assert.notEqual(result.intentId, result.token);
});

test("createConnectorUseIntent stores hash, not plaintext token", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const { token } = await createConnectorUseIntent("alice", { connector: "gmail", purpose: "oauth_start" }, env);
  const raw = JSON.parse(await fs.readFile(intentsPath(dir, "alice"), "utf8"));
  assert.equal(raw.length, 1);
  assert.ok(!JSON.stringify(raw).includes(token), "plaintext token must not appear in stored file");
  assert.ok(raw[0].tokenHash && !raw[0].token, "stored entry must have tokenHash, not token");
});

test("consumeConnectorUseIntent succeeds with correct credentials", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const { intentId, token } = await createConnectorUseIntent("alice", { connector: "gmail", purpose: "oauth_start" }, env);
  const consumed = await consumeConnectorUseIntent(intentId, token, { userId: "alice", connector: "gmail", purpose: "oauth_start" }, env);
  assert.equal(consumed.intentId, intentId);
  assert.equal(consumed.connector, "gmail");
  assert.equal(consumed.purpose, "oauth_start");
});

test("consumeConnectorUseIntent removes the entry — replay returns not_found", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const { intentId, token } = await createConnectorUseIntent("alice", { connector: "gmail", purpose: "oauth_start" }, env);
  await consumeConnectorUseIntent(intentId, token, { userId: "alice", connector: "gmail", purpose: "oauth_start" }, env);
  await assert.rejects(
    consumeConnectorUseIntent(intentId, token, { userId: "alice", connector: "gmail", purpose: "oauth_start" }, env),
    { code: "connector_use_intent_not_found" },
    "replay must fail with not_found after consumption",
  );
});

test("consumeConnectorUseIntent wrong token is rejected with token_invalid", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const { intentId } = await createConnectorUseIntent("alice", { connector: "gmail", purpose: "oauth_start" }, env);
  await assert.rejects(
    consumeConnectorUseIntent(intentId, "a".repeat(64), { userId: "alice", connector: "gmail", purpose: "oauth_start" }, env),
    { code: "connector_use_intent_token_invalid" },
  );
  // Original intent must remain unconsumed after a failed attempt.
  const raw = JSON.parse(await fs.readFile(intentsPath(dir, "alice"), "utf8"));
  assert.equal(raw.length, 1, "failed attempt must not delete the entry");
});

test("consumeConnectorUseIntent expired intent is rejected with expired", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const { intentId, token } = await createConnectorUseIntent("alice", { connector: "gmail", purpose: "oauth_start" }, env);
  const file = intentsPath(dir, "alice");
  const intents = JSON.parse(await fs.readFile(file, "utf8"));
  intents[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(file, JSON.stringify(intents));
  await assert.rejects(
    consumeConnectorUseIntent(intentId, token, { userId: "alice", connector: "gmail", purpose: "oauth_start" }, env),
    { code: "connector_use_intent_expired" },
  );
});

test("consumeConnectorUseIntent wrong connector is rejected with connector_mismatch", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const { intentId, token } = await createConnectorUseIntent("alice", { connector: "gmail", purpose: "oauth_start" }, env);
  // Patch the entry to simulate a different connector value (cross-connector substitution).
  const file = intentsPath(dir, "alice");
  const intents = JSON.parse(await fs.readFile(file, "utf8"));
  intents[0].connector = "whatsapp";
  await fs.writeFile(file, JSON.stringify(intents));
  await assert.rejects(
    consumeConnectorUseIntent(intentId, token, { userId: "alice", connector: "gmail", purpose: "oauth_start" }, env),
    { code: "connector_use_intent_connector_mismatch" },
  );
});

test("consumeConnectorUseIntent host mismatch is rejected with host_mismatch", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const { intentId, token } = await createConnectorUseIntent(
    "alice",
    { connector: "gmail", purpose: "oauth_start", host: "orkestr.example.com" },
    env,
  );
  await assert.rejects(
    consumeConnectorUseIntent(intentId, token, {
      userId: "alice", connector: "gmail", purpose: "oauth_start", host: "attacker.example.com",
    }, env),
    { code: "connector_use_intent_host_mismatch" },
  );
});

test("cross-user: bob cannot access alice's intent — returns not_found", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const { intentId, token } = await createConnectorUseIntent("alice", { connector: "gmail", purpose: "oauth_start" }, env);
  // Bob's intents file is separate from Alice's — the intentId doesn't exist there.
  await assert.rejects(
    consumeConnectorUseIntent(intentId, token, { userId: "bob", connector: "gmail", purpose: "oauth_start" }, env),
    { code: "connector_use_intent_not_found" },
    "bob must not be able to find alice's intent",
  );
  // Alice's intent must be untouched.
  const raw = JSON.parse(await fs.readFile(intentsPath(dir, "alice"), "utf8"));
  assert.equal(raw.length, 1, "alice's intent must remain after bob's failed lookup");
});

test("createConnectorUseIntent rejects at limit of 5 pending per connector", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  for (let i = 0; i < 5; i++) {
    await createConnectorUseIntent("alice", { connector: "gmail", purpose: "oauth_start" }, env);
  }
  await assert.rejects(
    createConnectorUseIntent("alice", { connector: "gmail", purpose: "oauth_start" }, env),
    { code: "connector_use_intent_limit" },
  );
});

test("expired intents are pruned on create, freeing limit space", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  for (let i = 0; i < 5; i++) {
    await createConnectorUseIntent("alice", { connector: "gmail", purpose: "oauth_start" }, env);
  }
  // Expire all five entries.
  const file = intentsPath(dir, "alice");
  const intents = JSON.parse(await fs.readFile(file, "utf8"));
  const expired = intents.map((e) => ({ ...e, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  await fs.writeFile(file, JSON.stringify(expired));
  // A new create must succeed because expired ones are pruned first.
  const result = await createConnectorUseIntent("alice", { connector: "gmail", purpose: "oauth_start" }, env);
  assert.ok(result.intentId, "create must succeed after pruning expired entries");
  // Only one entry should remain.
  const after = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(after.length, 1, "only the new intent must remain after pruning");
});

test("intent limit is per-connector: alice can create gmail and whatsapp intents independently", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  for (let i = 0; i < 5; i++) {
    await createConnectorUseIntent("alice", { connector: "gmail", purpose: "oauth_start" }, env);
  }
  // gmail is at limit; whatsapp should still allow creation.
  const r = await createConnectorUseIntent("alice", { connector: "whatsapp", purpose: "repair" }, env);
  assert.ok(r.intentId, "whatsapp intent must succeed when gmail is at limit");
});

test("missing intentId or token in consumeConnectorUseIntent throws invalid", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  await assert.rejects(
    consumeConnectorUseIntent("", "sometoken", { userId: "alice", connector: "gmail", purpose: "oauth_start" }, env),
    { code: "connector_use_intent_invalid" },
  );
  await assert.rejects(
    consumeConnectorUseIntent("cintent_abc", "", { userId: "alice", connector: "gmail", purpose: "oauth_start" }, env),
    { code: "connector_use_intent_invalid" },
  );
});

// ORK-512/513: binding field validation — account, capabilities, instanceId substitution guards

test("accountId binding: mismatched accountId is rejected with account_mismatch", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const { intentId, token } = await createConnectorUseIntent(
    "alice",
    { connector: "gmail", purpose: "oauth_start", accountId: "alice@example.com" },
    env,
  );
  await assert.rejects(
    consumeConnectorUseIntent(intentId, token, {
      userId: "alice", connector: "gmail", purpose: "oauth_start",
      accountId: "bob@example.com",
    }, env),
    { code: "connector_use_intent_account_mismatch" },
    "accountId substitution must be rejected",
  );
  // Intent must remain unconsumed after a rejected attempt.
  const raw = JSON.parse(await fs.readFile(intentsPath(dir, "alice"), "utf8"));
  assert.equal(raw.length, 1, "intent must remain after account_mismatch");
});

test("capabilities binding: mismatched capabilities are rejected with capabilities_mismatch", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const { intentId, token } = await createConnectorUseIntent(
    "alice",
    { connector: "gmail", purpose: "oauth_start", capabilities: ["gmail_read", "gmail_send"] },
    env,
  );
  await assert.rejects(
    consumeConnectorUseIntent(intentId, token, {
      userId: "alice", connector: "gmail", purpose: "oauth_start",
      capabilities: ["gmail_read"],
    }, env),
    { code: "connector_use_intent_capabilities_mismatch" },
    "capability set reduction must be rejected",
  );
});

test("instanceId binding: mismatched instanceId is rejected with instance_mismatch", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const { intentId, token } = await createConnectorUseIntent(
    "alice",
    { connector: "gmail", purpose: "oauth_start", instanceId: "instance-A" },
    env,
  );
  await assert.rejects(
    consumeConnectorUseIntent(intentId, token, {
      userId: "alice", connector: "gmail", purpose: "oauth_start",
      instanceId: "instance-B",
    }, env),
    { code: "connector_use_intent_instance_mismatch" },
    "instanceId substitution must be rejected",
  );
});

test("consumed entry contains all stored binding fields", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  const { intentId, token } = await createConnectorUseIntent(
    "alice",
    { connector: "gmail", purpose: "oauth_start", accountId: "alice@example.com", capabilities: ["gmail_read"], instanceId: "instance-X" },
    env,
  );
  const consumed = await consumeConnectorUseIntent(intentId, token, {
    userId: "alice", connector: "gmail", purpose: "oauth_start",
    accountId: "alice@example.com", capabilities: ["gmail_read"], instanceId: "instance-X",
  }, env);
  assert.equal(consumed.accountId, "alice@example.com");
  assert.deepEqual(consumed.capabilities, ["gmail_read"]);
  assert.equal(consumed.instanceId, "instance-X");
});

test("not_found rejection emits audit event without intentId (prevents enumeration)", async (t) => {
  const dir = await tmpDir(t);
  const env = { ORKESTR_HOME: dir };
  await assert.rejects(
    consumeConnectorUseIntent("cintent_doesnotexist99", "a".repeat(64), {
      userId: "alice", connector: "gmail", purpose: "oauth_start",
    }, env),
    { code: "connector_use_intent_not_found" },
  );
  const eventsFile = path.join(dir, "events.jsonl");
  const lines = (await fs.readFile(eventsFile, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const notFoundEvent = events.find((e) => e.type === "connector_use_intent_rejected" && e.reason === "not_found");
  assert.ok(notFoundEvent, "not_found rejection must emit a connector_use_intent_rejected event");
  assert.equal(notFoundEvent.userId, "alice");
  assert.equal(notFoundEvent.connector, "gmail");
  assert.equal("intentId" in notFoundEvent, false, "not_found audit event must not include intentId to prevent enumeration");
});
