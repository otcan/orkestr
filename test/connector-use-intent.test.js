import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { consumeConnectorUseIntent, createConnectorUseIntent } from "../packages/core/src/connector-use-intent.js";
import { listEvents } from "../packages/storage/src/store.js";

async function fixture(t, extra = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-intent-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { ORKESTR_HOME: home, ...extra };
}

const binding = {
  connector: "gmail",
  purpose: "oauth_start",
  host: "app.example.test",
  sessionId: "session-a",
  instanceId: "",
  subjectUserId: "",
  params: { account: "owner@example.test", capabilities: ["gmail_send", "gmail_read"], threadId: "thread-1" },
};

function expected(overrides = {}) {
  return { userId: "alice", ...binding, params: {}, ...overrides };
}

test("intent stores only a token hash and consumes exactly once", async (t) => {
  const env = await fixture(t);
  const created = await createConnectorUseIntent("alice", binding, env);
  const raw = await fs.readFile(path.join(env.ORKESTR_HOME, "users", "alice", "secrets", "connector-intents.json"), "utf8");
  assert.equal(raw.includes(created.token), false);

  const consumed = await consumeConnectorUseIntent(created.intentId, created.token, expected(), env);
  assert.deepEqual(consumed.params.capabilities, ["gmail_read", "gmail_send"]);
  assert.equal(consumed.params.account, "owner@example.test");

  await assert.rejects(consumeConnectorUseIntent(created.intentId, created.token, expected(), env), { code: "connector_use_intent_replayed" });
  const events = await listEvents(env, 20);
  assert.ok(events.some((event) => event.type === "connector_use_intent_replayed"));
});

test("concurrent consumption of one intent succeeds once", async (t) => {
  const env = await fixture(t);
  const created = await createConnectorUseIntent("alice", binding, env);
  const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
    consumeConnectorUseIntent(created.intentId, created.token, expected(), env)));
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.reason?.code === "connector_use_intent_replayed").length, 4);
});

for (const [name, overrides, code] of [
  ["another principal", { userId: "mallory" }, "connector_use_intent_not_found"],
  ["another host", { host: "attacker.example.test" }, "connector_use_intent_host_mismatch"],
  ["another session", { sessionId: "session-b" }, "connector_use_intent_session_mismatch"],
  ["another instance", { instanceId: "tenant-2" }, "connector_use_intent_instance_mismatch"],
  ["another subject user", { subjectUserId: "bob" }, "connector_use_intent_subject_mismatch"],
  ["another purpose", { purpose: "user_oauth_start" }, "connector_use_intent_purpose_mismatch"],
  ["a substituted account", { params: { account: "attacker@example.test" } }, "connector_use_intent_binding_mismatch"],
  ["substituted capabilities", { params: { capabilities: ["gmail_read"] } }, "connector_use_intent_binding_mismatch"],
  ["a parameter the intent never bound", { params: { returnTarget: "https://attacker.example.test/" } }, "connector_use_intent_binding_mismatch"],
]) {
  test(`intent rejects ${name} and cannot be retried`, async (t) => {
    const env = await fixture(t);
    const created = await createConnectorUseIntent("alice", binding, env);
    await assert.rejects(consumeConnectorUseIntent(created.intentId, created.token, expected(overrides), env), { code });
    if (code !== "connector_use_intent_not_found") {
      // A token-valid intent presented with a mismatch is burned.
      await assert.rejects(consumeConnectorUseIntent(created.intentId, created.token, expected(), env), { code: "connector_use_intent_replayed" });
    }
  });
}

test("intent accepts matching supplied parameters in any order", async (t) => {
  const env = await fixture(t);
  const created = await createConnectorUseIntent("alice", binding, env);
  const consumed = await consumeConnectorUseIntent(created.intentId, created.token, expected({
    params: { capabilities: ["gmail_read", "gmail_send"], account: "owner@example.test" },
  }), env);
  assert.equal(consumed.intentId, created.intentId);
});

test("wrong token, missing credentials and expiry fail closed", async (t) => {
  const env = await fixture(t, { ORKESTR_CONNECTOR_INTENT_TTL_MS: "1000" });
  const created = await createConnectorUseIntent("alice", binding, env);
  await assert.rejects(consumeConnectorUseIntent(created.intentId, "wrong", expected(), env), { code: "connector_use_intent_token_invalid" });
  await assert.rejects(consumeConnectorUseIntent("", "", expected(), env), { code: "connector_use_intent_required" });
  await assert.rejects(
    consumeConnectorUseIntent(created.intentId, created.token, expected({ nowMs: Date.now() + 5_000 }), env),
    { code: "connector_use_intent_expired" },
  );
});

test("pending intents and creation rate are bounded per principal", async (t) => {
  const env = await fixture(t, { ORKESTR_CONNECTOR_INTENT_RATE_LIMIT: "6" });
  for (let index = 0; index < 5; index += 1) await createConnectorUseIntent("alice", binding, env);
  await assert.rejects(createConnectorUseIntent("alice", binding, env), { code: "connector_use_intent_limit" });
  // Another principal has its own budget.
  await createConnectorUseIntent("bob", binding, env);
  await createConnectorUseIntent("bob", binding, env);
  // The creation budget is durable: it counts attempts, including the refused one.
  await assert.rejects(createConnectorUseIntent("alice", binding, env), { code: "connector_use_intent_rate_limited" });
  const events = await listEvents(env, 50);
  assert.ok(events.some((event) => event.type === "connector_use_intent_rate_limited" && event.userId === "alice"));
});
