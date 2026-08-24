import crypto from "node:crypto";
import fs from "node:fs/promises";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeSecretJson } from "../../storage/src/store.js";

const INTENT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function clean(value = "") {
  return String(value || "").trim();
}

export function parseBrokerRegistrationIntentId(value) {
  const intentId = clean(value);
  if (!INTENT_PATTERN.test(intentId)) throw Object.assign(new Error("broker_registration_intent_invalid"), { statusCode: 400 });
  const bytes = Buffer.from(intentId, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== intentId) {
    throw Object.assign(new Error("broker_registration_intent_invalid"), { statusCode: 400 });
  }
  return intentId;
}

export function normalizeBrokerBaseUrl(value) {
  const configured = clean(value);
  try {
    const url = new URL(configured);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || configured.includes("?") || configured.includes("#")) {
      throw new Error("invalid");
    }
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}`;
  } catch {
    throw Object.assign(new Error("broker_registration_intent_broker_invalid"), { statusCode: 400 });
  }
}

function assertBinding(record, binding) {
  if (
    clean(record.clientKeyFingerprint) !== clean(binding.clientKeyFingerprint) ||
    normalizeBrokerBaseUrl(record.brokerBaseUrl) !== normalizeBrokerBaseUrl(binding.brokerBaseUrl) ||
    clean(record.targetScopeHash) !== clean(binding.targetScopeHash) ||
    clean(record.authScopeHash) !== clean(binding.authScopeHash)
  ) {
    throw Object.assign(new Error("broker_registration_intent_binding_conflict"), { statusCode: 409 });
  }
}

export async function readBrokerRegistrationIntent(env = process.env) {
  const record = await readJson(dataPaths(env).brokerRegistrationIntent, null);
  if (!record) return null;
  parseBrokerRegistrationIntentId(record.registrationIntentId);
  if (!clean(record.clientKeyFingerprint) || !clean(record.targetScopeHash) || !clean(record.authScopeHash)) {
    throw Object.assign(new Error("broker_registration_intent_binding_invalid"), { statusCode: 500 });
  }
  return { ...record, brokerBaseUrl: normalizeBrokerBaseUrl(record.brokerBaseUrl) };
}

export async function ensureBrokerRegistrationIntent(binding, env = process.env, options = {}) {
  const prior = await readBrokerRegistrationIntent(env);
  if (prior) {
    assertBinding(prior, binding);
    return prior;
  }
  const bytes = (options.randomBytes || crypto.randomBytes)(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    throw Object.assign(new Error("broker_registration_intent_entropy_invalid"), { statusCode: 500 });
  }
  const record = {
    schemaVersion: 1,
    registrationIntentId: parseBrokerRegistrationIntentId(bytes.toString("base64url")),
    clientKeyFingerprint: clean(binding.clientKeyFingerprint),
    brokerBaseUrl: normalizeBrokerBaseUrl(binding.brokerBaseUrl),
    targetScopeHash: clean(binding.targetScopeHash),
    authScopeHash: clean(binding.authScopeHash),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  if (!record.clientKeyFingerprint || !record.targetScopeHash || !record.authScopeHash) {
    throw Object.assign(new Error("broker_registration_intent_binding_invalid"), { statusCode: 400 });
  }
  const paths = await ensureDataDirs(env);
  await (options.writeIntent || writeSecretJson)(paths.brokerRegistrationIntent, record);
  return record;
}

export async function clearBrokerRegistrationIntent(intent, env = process.env, options = {}) {
  const current = await readBrokerRegistrationIntent(env);
  if (!current) return false;
  if (current.registrationIntentId !== clean(intent?.registrationIntentId)) {
    throw Object.assign(new Error("broker_registration_intent_cleanup_conflict"), { statusCode: 409 });
  }
  const removeIntent = options.removeIntent || fs.unlink;
  await removeIntent(dataPaths(env).brokerRegistrationIntent);
  return true;
}
