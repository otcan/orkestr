import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeJson } from "../../storage/src/store.js";
import {
  assertPublicRefInvariant,
  canonicalInstanceUrlsEnabled,
  generateInstancePublicRef,
  parseInstancePublicRef,
} from "./canonical-public-references.js";
import { withCanonicalPublicReferenceLock } from "./canonical-public-reference-lock.js";

function clean(value = "") {
  return String(value || "").trim();
}

function configuredInstanceId(env = process.env) {
  return clean(env.ORKESTR_INSTANCE_ID || env.ORKESTR_RELEASE_INSTANCE_ID || env.ORKESTR_SERVICE_NAME || "local");
}

export async function readInstanceIdentity(env = process.env) {
  const record = await readJson(dataPaths(env).instanceIdentity, null);
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const identity = {
    schemaVersion: 1,
    internalInstanceId: clean(record.internalInstanceId || record.instanceId),
    publicRef: clean(record.publicRef),
    createdAt: clean(record.createdAt),
    publicRefAssignedAt: clean(record.publicRefAssignedAt),
  };
  if (!identity.internalInstanceId) throw Object.assign(new Error("instance_identity_internal_id_required"), { statusCode: 500 });
  if (identity.publicRef) parseInstancePublicRef(identity.publicRef);
  return identity;
}

export async function writeInstanceIdentity(identity, env = process.env) {
  return withCanonicalPublicReferenceLock(() => writeInstanceIdentityLocked(identity, env), env);
}

async function writeInstanceIdentityLocked(identity, env = process.env) {
  const current = await readInstanceIdentity(env);
  const internalInstanceId = clean(identity?.internalInstanceId || identity?.instanceId);
  if (!internalInstanceId) throw Object.assign(new Error("instance_identity_internal_id_required"), { statusCode: 400 });
  if (current?.internalInstanceId && current.internalInstanceId !== internalInstanceId) {
    throw Object.assign(new Error("instance_identity_internal_id_immutable"), { statusCode: 409 });
  }
  const publicRef = assertPublicRefInvariant(current?.publicRef, identity?.publicRef, "instance", { allowAssignment: true });
  const next = {
    schemaVersion: 1,
    internalInstanceId,
    ...(publicRef ? { publicRef } : {}),
    createdAt: current?.createdAt || clean(identity?.createdAt) || new Date().toISOString(),
    ...(publicRef ? { publicRefAssignedAt: current?.publicRefAssignedAt || clean(identity?.publicRefAssignedAt) || new Date().toISOString() } : {}),
  };
  await ensureDataDirs(env);
  await writeJson(dataPaths(env).instanceIdentity, next);
  return next;
}

export async function ensureInstanceIdentity(env = process.env, options = {}) {
  return withCanonicalPublicReferenceLock(() => ensureInstanceIdentityLocked(env, options), env);
}

async function ensureInstanceIdentityLocked(env = process.env, options = {}) {
  const current = await readInstanceIdentity(env);
  if (current?.publicRef || !canonicalInstanceUrlsEnabled(env)) return current;
  if (!options.publicRef && clean(env.ORKESTR_BROKER_BASE_URL || env.ORKESTR_DEMO_BROKER_BASE_URL)) return current;
  return writeInstanceIdentity({
    internalInstanceId: current?.internalInstanceId || configuredInstanceId(env),
    createdAt: current?.createdAt,
    publicRef: options.publicRef || generateInstancePublicRef(options.randomBytes),
    publicRefAssignedAt: options.now || new Date().toISOString(),
  }, env);
}

export async function syncBrokerAuthoritativeInstanceIdentity({ instanceId, publicRef, now = new Date().toISOString() } = {}, env = process.env) {
  return withCanonicalPublicReferenceLock(
    () => syncBrokerAuthoritativeInstanceIdentityLocked({ instanceId, publicRef, now }, env),
    env,
  );
}

async function syncBrokerAuthoritativeInstanceIdentityLocked({ instanceId, publicRef, now } = {}, env = process.env) {
  const internalInstanceId = clean(instanceId);
  const authoritativeRef = parseInstancePublicRef(publicRef);
  if (!internalInstanceId) throw Object.assign(new Error("broker_instance_identity_id_required"), { statusCode: 400 });
  const current = await readInstanceIdentity(env);
  if (current?.publicRef && current.publicRef !== authoritativeRef) {
    throw Object.assign(new Error("broker_instance_public_ref_conflict"), { statusCode: 409 });
  }
  if (current?.internalInstanceId && current.internalInstanceId !== internalInstanceId) {
    throw Object.assign(new Error("broker_instance_identity_id_conflict"), { statusCode: 409 });
  }
  if (current?.publicRef === authoritativeRef) return current;
  return writeInstanceIdentity({
    internalInstanceId,
    publicRef: authoritativeRef,
    createdAt: current?.createdAt,
    publicRefAssignedAt: current?.publicRefAssignedAt || now,
  }, env);
}
