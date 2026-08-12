import { createThreadRepository } from "../../storage/src/repositories.js";
import {
  assertUniquePublicRefs,
  canonicalInstanceUrlsEnabled,
  generateUniquePublicRef,
  parseInstancePublicRef,
  parseThreadPublicRef,
} from "./canonical-public-references.js";
import { readInstanceIdentity, writeInstanceIdentity } from "./instance-identity.js";
import { readBrokerInstanceRegistry, writeBrokerInstanceRegistry } from "./broker-instance-registry.js";

const modes = new Set(["dry-run", "apply"]);

function clean(value = "") {
  return String(value || "").trim();
}

function migrationError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function instanceInternalId(identity, env) {
  return clean(identity?.internalInstanceId || env.ORKESTR_INSTANCE_ID || env.ORKESTR_RELEASE_INSTANCE_ID || env.ORKESTR_SERVICE_NAME || "local");
}

function validateExisting(identity, brokerInstances, threads) {
  assertUniquePublicRefs([
    ...(identity?.publicRef ? [{ id: identity.internalInstanceId, publicRef: identity.publicRef }] : []),
    ...brokerInstances,
  ], "instance");
  assertUniquePublicRefs(threads, "thread");
  for (const thread of threads) {
    if (thread.publicRef) parseThreadPublicRef(thread.publicRef);
  }
}

export function planCanonicalPublicReferenceMigration({ identity = null, brokerInstances = [], threads = [], mode = "dry-run", env = process.env, randomBytes } = {}) {
  if (!modes.has(mode)) throw migrationError("canonical_public_ref_migration_mode_invalid");
  validateExisting(identity, brokerInstances, threads);
  const now = new Date().toISOString();
  const instanceReserved = new Set([
    ...(identity?.publicRef ? [identity.publicRef] : []),
    ...brokerInstances.map((instance) => clean(instance.publicRef)).filter(Boolean),
  ]);
  const threadReserved = new Set(threads.map((thread) => clean(thread.publicRef)).filter(Boolean));
  const assign = mode === "apply";
  const instancePublicRef = identity?.publicRef || (assign ? generateUniquePublicRef("instance", instanceReserved, randomBytes) : null);
  const plannedThreads = threads.map((thread) => ({
    id: clean(thread.id),
    priorPublicRef: clean(thread.publicRef) || null,
    publicRef: clean(thread.publicRef) || (assign ? generateUniquePublicRef("thread", threadReserved, randomBytes) : null),
    action: thread.publicRef ? "unchanged" : "backfill",
  }));
  const plannedBrokerInstances = brokerInstances.map((instance) => ({
    instanceId: clean(instance.instanceId),
    priorPublicRef: clean(instance.publicRef) || null,
    publicRef: clean(instance.publicRef) || (assign ? generateUniquePublicRef("instance", instanceReserved, randomBytes) : null),
    action: instance.publicRef ? "unchanged" : "backfill",
  }));
  return {
    schemaVersion: 1,
    mode,
    generatedAt: now,
    instance: {
      internalInstanceId: instanceInternalId(identity, env),
      priorPublicRef: clean(identity?.publicRef) || null,
      publicRef: instancePublicRef,
      action: identity?.publicRef ? "unchanged" : "backfill",
    },
    brokerInstances: plannedBrokerInstances,
    threads: plannedThreads,
    summary: {
      instancesScanned: 1,
      brokerInstancesScanned: brokerInstances.length,
      instancesToBackfill: (identity?.publicRef ? 0 : 1) + plannedBrokerInstances.filter((item) => item.action === "backfill").length,
      threadsScanned: threads.length,
      threadsToBackfill: plannedThreads.filter((item) => item.action === "backfill").length,
    },
  };
}

export async function migrateCanonicalPublicReferences({
  mode = "dry-run",
  env = process.env,
  now = new Date().toISOString(),
  randomBytes,
  storage = {},
} = {}) {
  if (!modes.has(mode)) throw migrationError("canonical_public_ref_migration_mode_invalid");
  if (mode === "apply" && !canonicalInstanceUrlsEnabled(env)) {
    throw migrationError("canonical_instance_urls_disabled", 409);
  }
  const repository = storage.repository || createThreadRepository(env);
  const readIdentity = storage.readIdentity || readInstanceIdentity;
  const writeIdentity = storage.writeIdentity || writeInstanceIdentity;
  const readBrokerRegistry = storage.readBrokerRegistry || readBrokerInstanceRegistry;
  const writeBrokerRegistry = storage.writeBrokerRegistry || writeBrokerInstanceRegistry;
  const identity = await readIdentity(env);
  const brokerRegistry = await readBrokerRegistry(env);
  const threads = await repository.list();
  const plan = planCanonicalPublicReferenceMigration({ identity, brokerInstances: brokerRegistry.instances, threads, mode, env, randomBytes });
  plan.generatedAt = now;
  if (mode === "dry-run") return { ok: true, applied: false, ...plan };

  const assignments = new Map(plan.threads.map((item) => [item.id, item.publicRef]));
  const nextThreads = threads.map((thread) => thread.publicRef ? thread : {
    ...thread,
    publicRef: assignments.get(clean(thread.id)),
    publicRefAssignedAt: now,
  });
  const brokerAssignments = new Map(plan.brokerInstances.map((item) => [item.instanceId, item.publicRef]));
  const nextBrokerRegistry = {
    ...brokerRegistry,
    instances: brokerRegistry.instances.map((instance) => instance.publicRef ? instance : {
      ...instance,
      publicRef: brokerAssignments.get(clean(instance.instanceId)),
      publicRefAssignedAt: now,
    }),
  };
  assertUniquePublicRefs(nextThreads, "thread");
  await repository.save(nextThreads);
  try {
    await writeBrokerRegistry(nextBrokerRegistry, env, { allowPublicRefAssignment: true });
  } catch (error) {
    try {
      await repository.save(threads);
    } catch (restoreError) {
      throw Object.assign(migrationError("canonical_public_ref_migration_recovery_failed", 500), {
        cause: error,
        restoreError,
      });
    }
    throw error;
  }
  try {
    await writeIdentity({
      internalInstanceId: plan.instance.internalInstanceId,
      publicRef: plan.instance.publicRef,
      createdAt: identity?.createdAt,
      publicRefAssignedAt: identity?.publicRefAssignedAt || now,
    }, env);
  } catch (error) {
    try {
      await writeBrokerRegistry(brokerRegistry, env, { restorePublicRefs: true });
      await repository.save(threads);
    } catch (restoreError) {
      throw Object.assign(migrationError("canonical_public_ref_migration_recovery_failed", 500), {
        cause: error,
        restoreError,
      });
    }
    throw error;
  }
  return { ok: true, applied: true, ...plan };
}
