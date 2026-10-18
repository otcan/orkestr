import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { closeAgentJobDbs, openAgentJobDb } from "../packages/core/src/agent-job-store.js";
import {
  acceptPersonalAgentMessage,
  listPersonalAgentReasoningInbox,
} from "../packages/core/src/personal-agent-ingress.js";
import {
  migratePersonalAgentIngress,
  planPersonalAgentIngressMigration,
} from "../packages/core/src/personal-agent-ingress-migration.js";
import { dispatchPersonalAgentEvents } from "../packages/core/src/personal-agent-events.js";

const owner = { orkestrPrincipal: { kind: "user", userId: "owner-fixture", role: "admin" } };

async function fixture(t, enabled = true) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pa-ingress-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: enabled ? "1" : "0" };
  t.after(async () => {
    if (env.ORKESTR_PERSONAL_AGENT_ENABLED === "1") await dispatchPersonalAgentEvents(env);
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  });
  return { env, home };
}

function message(idempotencyKey, overrides = {}) {
  return {
    scope: { kind: "global" },
    message: `fixture message ${idempotencyKey}`,
    idempotencyKey,
    ...overrides,
  };
}

test("ingress schema dry-runs, applies idempotently, and rejects incompatible partial schema", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const plan = planPersonalAgentIngressMigration(db);
    assert.equal(plan.dryRun, true);
    assert.deepEqual(plan.missingTables, ["personal_agent_conversations", "personal_agent_messages", "personal_agent_reasoning_inbox"]);
    assert.equal(db.prepare("select count(*) as count from sqlite_master where type = 'table'").get().count, 0);
    migratePersonalAgentIngress(db, { dryRun: false });
    migratePersonalAgentIngress(db, { dryRun: false });
    assert.deepEqual(db.prepare("select name from sqlite_master where type = 'table' and name like 'personal_agent_%' order by name").all().map((row) => row.name), [
      "personal_agent_conversations", "personal_agent_messages", "personal_agent_reasoning_inbox",
    ]);

    const incompatible = new DatabaseSync(":memory:");
    try {
      incompatible.exec("create table personal_agent_conversations (legacy text)");
      assert.throws(() => migratePersonalAgentIngress(incompatible, { dryRun: false }), { message: "personal_agent_ingress_schema_incompatible" });
      assert.deepEqual(incompatible.prepare("select name from sqlite_master where type = 'table' and name like 'personal_agent_%'").all().map((row) => row.name), ["personal_agent_conversations"]);
    } finally {
      incompatible.close();
    }
  } finally {
    db.close();
  }
});

test("ingress persists acceptance before a deliberately slow reasoning consumer completes", async (t) => {
  const { env } = await fixture(t);
  let markConsumerBusy;
  const consumerStarted = new Promise((resolve) => { markConsumerBusy = resolve; });
  let releaseConsumer;
  let consumerFinished = false;
  let consumerBusy = false;
  const slowConsumer = (async () => {
    let item;
    while (!item) {
      item = (await listPersonalAgentReasoningInbox(owner, { scope: { kind: "global" } }, env))[0];
      if (!item) await new Promise((resolve) => setTimeout(resolve, 2));
    }
    consumerBusy = true;
    markConsumerBusy(item);
    await new Promise((resolve) => { releaseConsumer = resolve; });
    consumerFinished = true;
  })();
  const startedAt = performance.now();
  const receipt = await acceptPersonalAgentMessage(owner, message("slow-consumer"), env);
  const receiptLatencyMs = performance.now() - startedAt;
  const consumed = await consumerStarted;
  assert.equal(receipt.accepted, true);
  assert.equal(consumed.inboxItemId, receipt.inboxItemId);
  assert.equal(consumerBusy, true);
  assert.equal(consumerFinished, false);
  assert.ok(receiptLatencyMs < 1000, `receipt took ${receiptLatencyMs.toFixed(1)}ms while reasoning was held`);
  releaseConsumer();
  await slowConsumer;
});

test("duplicate ingress returns the durable receipt and rejects changed payload reuse", async (t) => {
  const { env } = await fixture(t);
  const first = await acceptPersonalAgentMessage(owner, message("replay-key"), env);
  const replay = await acceptPersonalAgentMessage(owner, message("replay-key"), env);
  assert.equal(replay.replayed, true);
  for (const key of ["conversationId", "messageId", "eventId", "cursor", "inboxItemId", "causalSequence"]) {
    assert.equal(replay[key], first[key]);
  }
  await assert.rejects(
    () => acceptPersonalAgentMessage(owner, message("replay-key", { message: "different content" }), env),
    { code: "personal_agent_ingress_idempotency_conflict", statusCode: 409 },
  );
  const db = await openAgentJobDb(env);
  assert.equal(db.prepare("select count(*) as count from personal_agent_messages").get().count, 1);
  assert.equal(db.prepare("select count(*) as count from personal_agent_reasoning_inbox").get().count, 1);
});

test("inbox order and event correlations survive Agent Job store restart", async (t) => {
  const { env } = await fixture(t);
  const first = await acceptPersonalAgentMessage(owner, message("order-1", { priority: "high" }), env);
  const second = await acceptPersonalAgentMessage(owner, message("order-2"), env);
  assert.equal(first.causalSequence, 1);
  assert.equal(second.causalSequence, 2);
  await dispatchPersonalAgentEvents(env);
  await closeAgentJobDbs();

  const restored = await listPersonalAgentReasoningInbox(owner, { scope: { kind: "global" } }, env);
  assert.deepEqual(restored.map((item) => item.messageId), [first.messageId, second.messageId]);
  assert.deepEqual(restored.map((item) => item.causalSequence), [1, 2]);
  assert.equal(restored[0].priority, 2);
  assert.equal(restored[0].eventId, first.eventId);
  assert.equal(restored[0].cursor, first.cursor);
  assert.equal(restored[0].channel, "owner_api");
});

test("ingress requires authenticated owner, validates scope, and leaves feature-off schema unchanged", async (t) => {
  const { env } = await fixture(t, false);
  await assert.rejects(() => acceptPersonalAgentMessage({}, message("unauth"), env), { statusCode: 403 });
  await assert.rejects(() => acceptPersonalAgentMessage(owner, message("disabled"), env), { code: "personal_agent_disabled" });
  const db = await openAgentJobDb(env);
  assert.equal(db.prepare("select count(*) as count from sqlite_master where type = 'table' and name like 'personal_agent_%'").get().count, 0);
  await closeAgentJobDbs();

  env.ORKESTR_PERSONAL_AGENT_ENABLED = "1";
  await assert.rejects(() => acceptPersonalAgentMessage(owner, message("bad-scope", { scope: { kind: "project", projectId: "missing" } }), env), { code: "personal_agent_project_not_found" });
});

test("control flags are bounded metadata and cannot claim arbitrary channel identity", async (t) => {
  const { env } = await fixture(t);
  await assert.rejects(() => acceptPersonalAgentMessage(owner, message("bad-control", { controlFlags: { deploy: true } }), env), { code: "personal_agent_ingress_control_flags_invalid" });
  const accepted = await acceptPersonalAgentMessage(owner, message("control-flags", { channel: "untrusted-connector", controlFlags: { hold: true } }), env);
  const rows = await listPersonalAgentReasoningInbox(owner, { scope: { kind: "global" } }, env);
  assert.deepEqual(rows.find((row) => row.messageId === accepted.messageId).controlFlags, { cancel: false, hold: true, pause: false });
});

test("ingress validates and carries task/run correlation without conflating provider sessions", async (t) => {
  const { env } = await fixture(t);
  const db = await openAgentJobDb(env);
  const at = new Date().toISOString();
  db.prepare(`insert into personal_agent_projects (id, title, created_at, updated_at)
    values ('project-fixture', 'Fixture project', ?, ?)`).run(at, at);
  db.prepare(`insert into runs (id, job, run_key, spec_hash, trigger_json, state, created_at, updated_at)
    values ('run-fixture', 'fixture-job', 'fixture-run-key', 'fixture-spec', '{}', 'running', ?, ?)`).run(at, at);
  db.prepare(`insert into personal_agent_tasks
    (id, project_id, title, outcome, acceptance_json, state, run_id, data_json, created_at, updated_at, contract_json, completion_json)
    values ('task-fixture', 'project-fixture', 'Fixture task', 'Fixture outcome', '[]', 'running', 'run-fixture', '{}', ?, ?, '{}', '{}')`)
    .run(at, at);

  const accepted = await acceptPersonalAgentMessage(owner, message("correlated", {
    scope: { kind: "project", projectId: "project-fixture" },
    taskId: "task-fixture",
    runId: "run-fixture",
  }), env);
  const replay = await acceptPersonalAgentMessage(owner, message("correlated", {
    scope: { kind: "project", projectId: "project-fixture" },
    taskId: "task-fixture",
    runId: "run-fixture",
  }), env);
  assert.equal(accepted.taskId, "task-fixture");
  assert.equal(accepted.runId, "run-fixture");
  assert.equal(replay.taskId, accepted.taskId);
  assert.equal(replay.runId, accepted.runId);
  const inbox = await listPersonalAgentReasoningInbox(owner, { scope: { kind: "project", projectId: "project-fixture" } }, env);
  assert.equal(inbox[0].taskId, "task-fixture");
  assert.equal(inbox[0].runId, "run-fixture");
  const event = db.prepare("select payload_json from personal_agent_event_outbox where event_id = ?").get(accepted.eventId);
  assert.equal(JSON.parse(event.payload_json).taskId, "task-fixture");
  assert.equal(JSON.parse(event.payload_json).runId, "run-fixture");
  await assert.rejects(() => acceptPersonalAgentMessage(owner, message("wrong-run", {
    scope: { kind: "project", projectId: "project-fixture" }, taskId: "task-fixture", runId: "missing-run",
  }), env), { code: "personal_agent_task_run_mismatch", statusCode: 409 });
});
