import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  activateThreadInputDeliveryScheduler,
  closeThreadInputDeliveryScheduler,
  requestThreadInputDelivery,
  threadInputDeliverySchedulerStatus,
} from "../packages/core/src/runtime-leases.js";
import { openBrokerDatabase } from "../packages/core/src/broker-instance-sqlite-store.js";
import { openThreadResourcePolicyDatabase } from "../packages/core/src/thread-resource-policy-store.js";
import { writeConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { stageConnectorAttachment } from "../packages/connectors/src/connector-staged-attachments.js";
import { spoolPostfixMailboxMessage } from "../packages/connectors/src/postfix-mailbox-adapter.js";
import { ensureConnectorInboxEvent } from "../packages/storage/src/connector-inbox.js";
import { createConnectorStateRepository, createThreadRepository } from "../packages/storage/src/repositories.js";
import { listThreadMessageRows } from "../packages/storage/src/thread-message-registry.js";
import {
  closeThreadRegistryCache,
  listThreadRecords,
  saveThreadRecords,
} from "../packages/storage/src/thread-registry.js";

function threadRecords(count, prefix = "thread") {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    name: `${prefix} ${index + 1}`,
    createdAt: new Date(index * 1000).toISOString(),
  }));
}

test("node:test refuses registry writes outside the system temporary root", async () => {
  const unsafeHome = path.join(os.homedir(), `.orkestr-test-storage-sentinel-${randomUUID()}`);
  const env = { ...process.env, ORKESTR_HOME: unsafeHome, ORKESTR_THREAD_STORE: "sqlite" };

  await assert.rejects(
    saveThreadRecords([{ id: "must-not-exist", name: "must-not-exist" }], env),
    (error) => error?.code === "test_storage_requires_temp_path",
  );
  await assert.rejects(
    createConnectorStateRepository(env).writeWhatsAppState({ bindings: [{ id: "must-not-exist" }] }),
    (error) => error?.code === "test_storage_requires_temp_path",
  );
  await assert.rejects(fs.stat(unsafeHome), { code: "ENOENT" });
});

test("node:test storage fence covers the audited SQLite and replace-all stores", async () => {
  const safeHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-store-fence-"));
  const unsafeRoot = path.join(os.homedir(), `.orkestr-store-fence-sentinel-${randomUUID()}`);
  const base = { ...process.env, ORKESTR_HOME: safeHome };
  const attempts = [
    () => ensureConnectorInboxEvent({ id: "unsafe-inbox-event" }, {
      ...base,
      ORKESTR_CONNECTOR_INBOX_DB: path.join(unsafeRoot, "connector-inbox.sqlite"),
    }),
    () => writeConnectorOutbox({ jobs: [] }, {
      ...base,
      ORKESTR_CONNECTOR_OUTBOX_STORE: "sqlite",
      ORKESTR_CONNECTOR_OUTBOX_DB: path.join(unsafeRoot, "connector-outbox.sqlite"),
    }),
    () => openBrokerDatabase({
      ...base,
      ORKESTR_BROKER_INSTANCE_STORE: "sqlite",
      ORKESTR_BROKER_INSTANCES_DB: path.join(unsafeRoot, "broker-instances.sqlite"),
    }),
    () => openThreadResourcePolicyDatabase({
      ...base,
      ORKESTR_THREAD_RESOURCE_POLICY_STORE: "sqlite",
      ORKESTR_THREAD_RESOURCE_POLICY_DB: path.join(unsafeRoot, "thread-resource-policy.sqlite"),
    }),
    () => listThreadMessageRows("unsafe-thread", {
      ...base,
      ORKESTR_HOME: unsafeRoot,
      ORKESTR_THREAD_MESSAGE_STORE: "sqlite",
    }),
    () => stageConnectorAttachment({ bytes: Buffer.from("unsafe") }, {
      ...base,
      ORKESTR_CONNECTOR_STAGE_DIR: path.join(unsafeRoot, "connector-stage"),
    }),
    () => spoolPostfixMailboxMessage(Buffer.from("unsafe"), {
      ...base,
      ORKESTR_MAILBOX_SPOOL_DIR: path.join(unsafeRoot, "mailbox-spool"),
    }),
  ];

  for (const attempt of attempts) {
    await assert.rejects(attempt, (error) => error?.code === "test_storage_requires_temp_path");
  }
  await assert.rejects(fs.stat(unsafeRoot), { code: "ENOENT" });
});

test("repositories retain their immutable storage target after caller env mutation", async () => {
  const firstHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-env-snapshot-a-"));
  const secondHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-env-snapshot-b-"));
  const mutableEnv = { ...process.env, ORKESTR_HOME: firstHome, ORKESTR_THREAD_STORE: "json" };
  const threads = createThreadRepository(mutableEnv);
  const connector = createConnectorStateRepository(mutableEnv);

  mutableEnv.ORKESTR_HOME = secondHome;
  await threads.save([{ id: "isolated-thread", name: "Isolated thread" }]);
  await connector.writeWhatsAppState({ bindings: [{ id: "isolated-binding" }] });

  assert.equal((await listThreadRecords({ ...mutableEnv, ORKESTR_HOME: firstHome }))[0].id, "isolated-thread");
  assert.equal(JSON.parse(await fs.readFile(path.join(firstHome, "whatsapp.json"), "utf8")).bindings[0].id, "isolated-binding");
  await assert.rejects(fs.stat(path.join(secondHome, "threads.json")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(secondHome, "whatsapp.json")), { code: "ENOENT" });
});

test("thread registry rejects catastrophic replacement and stale snapshots", async () => {
  for (const store of ["sqlite", "json"]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-registry-fence-${store}-`));
    const env = { ...process.env, ORKESTR_HOME: home, ORKESTR_THREAD_STORE: store };
    const baseline = threadRecords(134, store);
    await saveThreadRecords(baseline, env);

    await assert.rejects(
      saveThreadRecords([{ id: "thread-ui-input-authority", name: "UI input authority" }], env),
      (error) => error?.code === "thread_registry_unexpected_removal" && error.previousCount === 134 && error.nextCount === 1,
    );
    assert.equal((await listThreadRecords(env)).length, 134);
    const audit = await fs.readFile(path.join(home, "events.jsonl"), "utf8");
    assert.match(audit, /"type":"thread_registry_write_rejected"/);
    assert.match(audit, /"severity":"critical"/);
    assert.match(audit, /"previousCount":134/);
    assert.match(audit, /"nextCount":1/);

    const stale = await listThreadRecords(env);
    const current = await listThreadRecords(env);
    current.push({ id: "current-addition", name: "Current addition" });
    await saveThreadRecords(current, env);
    stale.push({ id: "stale-addition", name: "Stale addition" });
    await assert.rejects(
      saveThreadRecords(stale, env),
      (error) => error?.code === "thread_registry_revision_conflict",
    );
    const final = await listThreadRecords(env);
    assert.equal(final.length, 135);
    assert.equal(final.some((record) => record.id === "current-addition"), true);
    assert.equal(final.some((record) => record.id === "stale-addition"), false);
    await closeThreadRegistryCache(env);
  }
});

test("delivery scheduling captures its home and scoped shutdown removes pending work", async () => {
  const firstHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-delivery-scope-a-"));
  const secondHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-delivery-scope-b-"));
  const firstEnv = { ...process.env, ORKESTR_HOME: firstHome };
  const mutableEnv = { ...firstEnv };
  activateThreadInputDeliveryScheduler(firstEnv);

  requestThreadInputDelivery("scheduled-thread", mutableEnv, 60_000);
  mutableEnv.ORKESTR_HOME = secondHome;

  assert.equal(threadInputDeliverySchedulerStatus(firstEnv).timers, 1);
  assert.equal(threadInputDeliverySchedulerStatus(mutableEnv).timers, 0);
  await closeThreadInputDeliveryScheduler(firstEnv);
  assert.deepEqual(threadInputDeliverySchedulerStatus(firstEnv), {
    scope: firstHome,
    active: false,
    timers: 0,
    tasks: 0,
    locks: 0,
  });
});
