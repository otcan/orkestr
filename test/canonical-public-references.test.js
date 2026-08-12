import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertPublicRefInvariant,
  assertUniquePublicRefs,
  canonicalInstanceUrlsEnabled,
  generateInstancePublicRef,
  generateThreadPublicRef,
  generateUniquePublicRef,
  isInstancePublicRef,
  isThreadPublicRef,
  parseInstancePublicRef,
  parseThreadPublicRef,
} from "../packages/core/src/canonical-public-references.js";
import {
  migrateCanonicalPublicReferences,
  planCanonicalPublicReferenceMigration,
} from "../packages/core/src/canonical-public-reference-migration.js";
import { readInstanceIdentity } from "../packages/core/src/instance-identity.js";
import { createThread, getThread, listThreads, updateThread } from "../packages/core/src/threads.js";
import { createThreadRepository } from "../packages/storage/src/repositories.js";
import { closeThreadRegistryCache } from "../packages/storage/src/thread-registry.js";
import {
  readBrokerInstanceRegistry,
  writeBrokerInstanceRegistry,
} from "../packages/core/src/broker-instance-registry.js";

function bytes(fill) {
  return () => Buffer.alloc(16, fill);
}

async function temporaryEnv(store = "json") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-public-refs-"));
  return {
    home,
    env: {
      ORKESTR_HOME: home,
      ORKESTR_THREAD_STORE: store,
      ORKESTR_BROKER_INSTANCE_STORE: store,
      ORKESTR_INSTANCE_ID: "synthetic-instance",
      ORKESTR_CANONICAL_INSTANCE_URLS: "1",
    },
  };
}

test("canonical public references use strict opaque formats", () => {
  const instanceRef = generateInstancePublicRef(bytes(1));
  const threadRef = generateThreadPublicRef(bytes(2));
  assert.equal(instanceRef, "ins_AQEBAQEBAQEBAQEBAQEBAQ");
  assert.equal(threadRef, "thr_AgICAgICAgICAgICAgICAg");
  assert.equal(parseInstancePublicRef(instanceRef), instanceRef);
  assert.equal(parseThreadPublicRef(threadRef), threadRef);
  assert.equal(isInstancePublicRef(instanceRef), true);
  assert.equal(isThreadPublicRef(threadRef), true);
  assert.equal(isThreadPublicRef(instanceRef), false);
});

test("canonical public reference parsers reject malformed and non-canonical values", () => {
  for (const value of ["", "ins_short", "ins_AQEBAQEBAQEBAQEBAQEBAQ ", "INS_AQEBAQEBAQEBAQEBAQEBAQ", "ins_AQEBAQEBAQEBAQEBAQEBAR", "thr_AQEBAQEBAQEBAQEBAQEBA!"]) {
    assert.throws(() => parseInstancePublicRef(value), /instance_public_ref_invalid/);
  }
  assert.throws(() => parseThreadPublicRef("ins_AQEBAQEBAQEBAQEBAQEBAQ"), /thread_public_ref_invalid/);
});

test("unique generation retries collisions and invariant checks fail closed", () => {
  let calls = 0;
  const source = () => Buffer.alloc(16, calls++ === 0 ? 3 : 4);
  const reserved = new Set([generateThreadPublicRef(bytes(3))]);
  const generated = generateUniquePublicRef("thread", reserved, source);
  assert.equal(generated, generateThreadPublicRef(bytes(4)));
  assert.throws(() => assertUniquePublicRefs([{ id: "one", publicRef: generated }, { id: "two", publicRef: generated }], "thread"), /thread_public_ref_collision/);
  assert.throws(() => assertPublicRefInvariant(generated, generateThreadPublicRef(bytes(5)), "thread"), /thread_public_ref_immutable/);
  assert.throws(() => assertPublicRefInvariant("", generated, "thread"), /thread_public_ref_immutable/);
  assert.equal(assertPublicRefInvariant("", generated, "thread", { allowAssignment: true }), generated);
});

test("canonical URL feature flag is explicit and defaults off", () => {
  assert.equal(canonicalInstanceUrlsEnabled({}), false);
  assert.equal(canonicalInstanceUrlsEnabled({ ORKESTR_CANONICAL_INSTANCE_URLS: "true" }), true);
  assert.equal(canonicalInstanceUrlsEnabled({ ORKESTR_CANONICAL_INSTANCE_URLS: "0" }), false);
});

test("new thread public references remain stable across rename", async (t) => {
  const { home, env } = await temporaryEnv("json");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const created = await createThread({ id: "legacy-thread-id", name: "Original name" }, env);
  const renamed = await updateThread(created.id, { name: "Renamed thread" }, env);
  assert.equal(isThreadPublicRef(created.publicRef), true);
  assert.equal(renamed.id, "legacy-thread-id");
  assert.equal(renamed.publicRef, created.publicRef);
  await assert.rejects(updateThread(created.id, { publicRef: generateThreadPublicRef() }, env), /thread_public_ref_immutable/);
  const legacy = await createThread({ id: "legacy-after-disable", name: "Legacy" }, { ...env, ORKESTR_CANONICAL_INSTANCE_URLS: "0" });
  assert.equal(legacy.publicRef, undefined);
  await assert.rejects(updateThread(legacy.id, { publicRef: generateThreadPublicRef() }, env), /thread_public_ref_immutable/);
});

test("migration plans reject malformed references and collisions before writes", () => {
  assert.throws(() => planCanonicalPublicReferenceMigration({
    identity: { internalInstanceId: "local", publicRef: "ins_bad" },
    threads: [],
  }), /instance_public_ref_invalid/);
  const duplicate = generateThreadPublicRef(bytes(6));
  assert.throws(() => planCanonicalPublicReferenceMigration({
    identity: null,
    threads: [{ id: "one", publicRef: duplicate }, { id: "two", publicRef: duplicate }],
  }), /thread_public_ref_collision/);
});

for (const store of ["json", "sqlite"]) {
  test(`canonical public reference migration is dry-run safe, idempotent, and rollback-compatible (${store})`, async (t) => {
    const { home, env } = await temporaryEnv(store);
    t.after(async () => {
      await closeThreadRegistryCache(env);
      await fs.rm(home, { recursive: true, force: true });
    });
    const repository = createThreadRepository(env);
    await repository.save([
      { id: "legacy-one", ownerUserId: "admin", name: "Legacy one", createdAt: "2026-08-12T08:00:00.000Z" },
      { id: "legacy-two", ownerUserId: "admin", name: "Legacy two", createdAt: "2026-08-12T08:01:00.000Z" },
    ]);
    await writeBrokerInstanceRegistry({
      broker: {},
      instances: [{
        instanceId: "00000000-0000-4000-8000-000000000001",
        channelId: "synthetic-channel",
        status: "registered",
        displayName: "Synthetic broker instance",
        encryptionPublicKey: "synthetic-public-key",
        createdAt: "2026-08-12T08:02:00.000Z",
      }],
      rateLimits: {},
    }, env);

    const dryRun = await migrateCanonicalPublicReferences({ mode: "dry-run", env, now: "2026-08-12T09:00:00.000Z" });
    assert.equal(dryRun.applied, false);
    assert.equal(dryRun.summary.instancesToBackfill, 2);
    assert.equal(dryRun.summary.brokerInstancesScanned, 1);
    assert.equal(dryRun.summary.threadsToBackfill, 2);
    assert.equal(dryRun.instance.publicRef, null);
    assert.deepEqual(dryRun.threads.map((item) => item.publicRef), [null, null]);
    assert.deepEqual(dryRun.brokerInstances.map((item) => item.publicRef), [null]);
    assert.equal(await readInstanceIdentity(env), null);
    assert.deepEqual((await listThreads(env)).map((thread) => thread.publicRef), [undefined, undefined]);

    const applied = await migrateCanonicalPublicReferences({ mode: "apply", env, now: "2026-08-12T09:01:00.000Z" });
    const identity = await readInstanceIdentity(env);
    const migrated = await listThreads(env);
    const migratedBroker = await readBrokerInstanceRegistry(env);
    assert.equal(applied.applied, true);
    assert.equal(identity.internalInstanceId, "synthetic-instance");
    assert.equal(isInstancePublicRef(identity.publicRef), true);
    assert.equal(migrated.every((thread) => isThreadPublicRef(thread.publicRef)), true);
    assert.deepEqual(migrated.map((thread) => thread.id), ["legacy-one", "legacy-two"]);
    assert.deepEqual(migrated.map((thread) => thread.name), ["Legacy one", "Legacy two"]);
    assert.equal(isInstancePublicRef(migratedBroker.instances[0].publicRef), true);
    assert.equal(migratedBroker.instances[0].instanceId, "00000000-0000-4000-8000-000000000001");

    const repeated = await migrateCanonicalPublicReferences({ mode: "apply", env, now: "2026-08-12T09:02:00.000Z" });
    assert.equal(repeated.summary.instancesToBackfill, 0);
    assert.equal(repeated.summary.threadsToBackfill, 0);
    assert.equal((await readInstanceIdentity(env)).publicRef, identity.publicRef);
    assert.deepEqual((await listThreads(env)).map((thread) => thread.publicRef), migrated.map((thread) => thread.publicRef));
    assert.deepEqual((await readBrokerInstanceRegistry(env)).instances.map((instance) => instance.publicRef), migratedBroker.instances.map((instance) => instance.publicRef));

    delete env.ORKESTR_CANONICAL_INSTANCE_URLS;
    assert.deepEqual((await listThreads(env)).map((thread) => thread.id), ["legacy-one", "legacy-two"]);
    assert.deepEqual((await listThreads(env)).map((thread) => thread.name), ["Legacy one", "Legacy two"]);
    assert.deepEqual((await listThreads(env)).map((thread) => thread.publicRef), migrated.map((thread) => thread.publicRef));
    assert.equal((await readInstanceIdentity(env)).publicRef, identity.publicRef);
    assert.equal((await readBrokerInstanceRegistry(env)).instances[0].publicRef, migratedBroker.instances[0].publicRef);
  });
}

test("failed apply restores thread persistence and leaves no partial identity", async (t) => {
  const { home, env } = await temporaryEnv("json");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const repository = createThreadRepository(env);
  const legacy = [{ id: "legacy", ownerUserId: "admin", name: "Legacy" }];
  await repository.save(legacy);
  const brokerRegistry = {
    broker: {},
    rateLimits: {},
    instances: [{ instanceId: "legacy-broker", channelId: "legacy-channel", encryptionPublicKey: "synthetic-key" }],
  };
  await writeBrokerInstanceRegistry(brokerRegistry, env);
  await assert.rejects(migrateCanonicalPublicReferences({
    mode: "apply",
    env,
    storage: {
      repository,
      writeIdentity: async () => { throw new Error("synthetic_identity_write_failure"); },
    },
  }), /synthetic_identity_write_failure/);
  assert.deepEqual(await repository.list(), legacy);
  assert.equal(await readInstanceIdentity(env), null);
  assert.deepEqual((await readBrokerInstanceRegistry(env)).instances.map((instance) => instance.publicRef), [undefined]);
});

test("local and broker instance references share one collision domain", () => {
  const duplicate = generateInstancePublicRef(bytes(8));
  assert.throws(() => planCanonicalPublicReferenceMigration({
    identity: { internalInstanceId: "local", publicRef: duplicate },
    brokerInstances: [{ instanceId: "broker", publicRef: duplicate }],
    threads: [],
  }), /instance_public_ref_collision/);
});

test("broker instance public references are immutable across ordinary registry updates", async (t) => {
  const { home, env } = await temporaryEnv("json");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const publicRef = generateInstancePublicRef(bytes(9));
  const base = {
    broker: {},
    rateLimits: {},
    instances: [{
      instanceId: "broker-one",
      channelId: "channel-one",
      displayName: "Original",
      encryptionPublicKey: "synthetic-key",
      publicRef,
      publicRefAssignedAt: "2026-08-12T10:00:00.000Z",
    }],
  };
  await writeBrokerInstanceRegistry(base, env, { allowPublicRefAssignment: true });
  const updated = await writeBrokerInstanceRegistry({
    ...base,
    instances: [{ ...base.instances[0], displayName: "Renamed" }],
  }, env);
  assert.equal(updated.instances[0].displayName, "Renamed");
  assert.equal(updated.instances[0].publicRef, publicRef);
  await assert.rejects(writeBrokerInstanceRegistry({
    ...base,
    instances: [{ ...base.instances[0], publicRef: generateInstancePublicRef(bytes(10)) }],
  }, env), /broker_instance_public_ref_immutable/);
  const removed = { ...base.instances[0] };
  delete removed.publicRef;
  await assert.rejects(writeBrokerInstanceRegistry({ ...base, instances: [removed] }, env), /broker_instance_public_ref_immutable/);
});

test("independent instances receive globally distinct references", async (t) => {
  const first = await temporaryEnv("json");
  const second = await temporaryEnv("json");
  t.after(async () => {
    await fs.rm(first.home, { recursive: true, force: true });
    await fs.rm(second.home, { recursive: true, force: true });
  });
  await createThread({ id: "same-internal-thread-id", name: "Synthetic" }, first.env);
  await createThread({ id: "same-internal-thread-id", name: "Synthetic" }, second.env);
  const firstMigration = await migrateCanonicalPublicReferences({ mode: "apply", env: first.env });
  const secondMigration = await migrateCanonicalPublicReferences({ mode: "apply", env: second.env });
  assert.notEqual(firstMigration.instance.publicRef, secondMigration.instance.publicRef);
  assert.notEqual((await getThread("same-internal-thread-id", first.env)).publicRef, (await getThread("same-internal-thread-id", second.env)).publicRef);
});

test("apply is blocked while canonical instance URLs are disabled", async (t) => {
  const { home, env } = await temporaryEnv("json");
  delete env.ORKESTR_CANONICAL_INSTANCE_URLS;
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await assert.rejects(migrateCanonicalPublicReferences({ mode: "apply", env }), /canonical_instance_urls_disabled/);
});
