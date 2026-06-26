import fs from "node:fs/promises";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { readJson } from "../../storage/src/store.js";

const dbCache = new Map();
let sqliteModulePromise = null;

function clean(value) {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

export function brokerStoreMode(env = process.env) {
  return clean(env.ORKESTR_BROKER_INSTANCE_STORE || env.ORKESTR_BROKER_STORE || env.ORKESTR_STORAGE || "auto").toLowerCase();
}

export async function openBrokerDatabase(env = process.env) {
  const mode = brokerStoreMode(env);
  if (mode === "json") return null;
  if (mode === "postgres" || mode === "postgresql") {
    const error = new Error("broker_instance_postgres_backend_not_implemented");
    error.statusCode = 501;
    throw error;
  }
  const sqlite = await loadSqlite(mode);
  if (!sqlite) return null;
  const paths = await ensureDataDirs(env);
  if (dbCache.has(paths.brokerInstancesDb)) return dbCache.get(paths.brokerInstancesDb);
  const existed = await fs.stat(paths.brokerInstancesDb).then((stat) => stat.size > 0, () => false);
  const db = new sqlite.DatabaseSync(paths.brokerInstancesDb);
  db.exec("pragma journal_mode = WAL");
  db.exec("pragma synchronous = NORMAL");
  db.exec("pragma busy_timeout = 5000");
  ensureBrokerSchema(db);
  dbCache.set(paths.brokerInstancesDb, db);
  await migrateJsonBrokerRegistryIfNeeded(db, paths, existed);
  return db;
}

export async function readSqliteBrokerRegistry(env = process.env) {
  const db = await openBrokerDatabase(env);
  if (!db) return null;
  const rows = db.prepare("select * from orkestr_broker_instances order by created_at asc, instance_id asc").all();
  return {
    schemaVersion: 2,
    backend: "sqlite",
    broker: getBrokerMeta(db, "broker", {}),
    instances: rows.map(rowToInstance).filter(Boolean),
    rateLimits: {},
    updatedAt: getBrokerMeta(db, "updated_at", null),
  };
}

export async function writeSqliteBrokerRegistry(registry, env = process.env) {
  const db = await openBrokerDatabase(env);
  if (!db) return false;
  db.exec("begin immediate");
  try {
    db.exec("delete from orkestr_broker_instances");
    for (const instance of Array.isArray(registry.instances) ? registry.instances : []) {
      insertBrokerInstanceRow(db, instance);
    }
    setBrokerMeta(db, "broker", registry.broker || {});
    setBrokerMeta(db, "updated_at", nowIso());
    db.exec("commit");
    return true;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export async function getSqliteBrokerInstance(instanceId, env = process.env) {
  const db = await openBrokerDatabase(env);
  if (!db) return { available: false, instance: null };
  const row = db.prepare("select * from orkestr_broker_instances where instance_id = ?").get(clean(instanceId));
  return { available: true, instance: rowToInstance(row) };
}

async function loadSqlite(mode) {
  try {
    sqliteModulePromise ||= import("node:sqlite");
    return await sqliteModulePromise;
  } catch (error) {
    if (mode === "sqlite") throw error;
    return null;
  }
}

function ensureBrokerSchema(db) {
  db.exec(`
    create table if not exists orkestr_broker_meta (
      key text primary key,
      value text not null
    );
    create table if not exists orkestr_broker_instances (
      instance_id text primary key,
      channel_id text not null,
      status text,
      display_name text,
      version text,
      capabilities_json text not null default '[]',
      encryption_public_key text not null,
      encryption_public_key_fingerprint text,
      signing_public_key text,
      channel_key_hash text,
      registration_token_hash text,
      request_ip text,
      user_agent text,
      endpoint_base_url text,
      connect_base_url text,
      setup_url text,
      relay_account_id text,
      whatsapp_chat_hash text,
      last_heartbeat_ip text,
      last_heartbeat_at text,
      last_seen_at text,
      expires_at text,
      disabled_at text,
      audit_status text,
      audit_updated_at text,
      limits_json text not null default '{}',
      created_at text not null,
      updated_at text not null,
      data text not null
    );
    create index if not exists idx_broker_instances_status_seen on orkestr_broker_instances(status, last_seen_at);
    create index if not exists idx_broker_instances_token on orkestr_broker_instances(registration_token_hash);
    create index if not exists idx_broker_instances_request_ip_created on orkestr_broker_instances(request_ip, created_at);
    create index if not exists idx_broker_instances_relay on orkestr_broker_instances(relay_account_id);
  `);
}

function getBrokerMeta(db, key, fallback = null) {
  const row = db.prepare("select value from orkestr_broker_meta where key = ?").get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function setBrokerMeta(db, key, value) {
  db.prepare(`
    insert into orkestr_broker_meta(key, value) values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(key, JSON.stringify(value ?? null));
}

function parseJsonField(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function rowToInstance(row) {
  if (!row) return null;
  const data = parseJsonField(row.data, {});
  return {
    ...data,
    instanceId: row.instance_id,
    channelId: row.channel_id,
    status: row.status || data.status || "registered",
    displayName: row.display_name || data.displayName || "",
    version: row.version || data.version || "",
    capabilities: parseJsonField(row.capabilities_json, data.capabilities || []),
    encryptionPublicKey: row.encryption_public_key || data.encryptionPublicKey || "",
    encryptionPublicKeyFingerprint: row.encryption_public_key_fingerprint || data.encryptionPublicKeyFingerprint || "",
    signingPublicKey: row.signing_public_key || data.signingPublicKey || "",
    channelKeyHash: row.channel_key_hash || data.channelKeyHash || "",
    registrationTokenHash: row.registration_token_hash || data.registrationTokenHash || "",
    requestIp: row.request_ip || data.requestIp || "",
    userAgent: row.user_agent || data.userAgent || "",
    endpointBaseUrl: row.endpoint_base_url || data.endpointBaseUrl || "",
    connectBaseUrl: row.connect_base_url || data.connectBaseUrl || "",
    setupUrl: row.setup_url || data.setupUrl || "",
    relayAccountId: row.relay_account_id || data.relayAccountId || "",
    whatsappChatHash: row.whatsapp_chat_hash || data.whatsappChatHash || "",
    lastHeartbeatIp: row.last_heartbeat_ip || data.lastHeartbeatIp || "",
    lastHeartbeatAt: row.last_heartbeat_at || data.lastHeartbeatAt || null,
    lastSeenAt: row.last_seen_at || data.lastSeenAt || null,
    expiresAt: row.expires_at || data.expiresAt || null,
    disabledAt: row.disabled_at || data.disabledAt || null,
    auditStatus: row.audit_status || data.auditStatus || "",
    auditUpdatedAt: row.audit_updated_at || data.auditUpdatedAt || null,
    limits: parseJsonField(row.limits_json, data.limits || {}),
    createdAt: row.created_at || data.createdAt || "",
    updatedAt: row.updated_at || data.updatedAt || "",
  };
}

function normalizeInstanceRecord(instance = {}) {
  const now = nowIso();
  return {
    ...instance,
    instanceId: clean(instance.instanceId),
    channelId: clean(instance.channelId),
    status: clean(instance.status) || "registered",
    displayName: clean(instance.displayName).slice(0, 120),
    version: clean(instance.version).slice(0, 80),
    capabilities: Array.isArray(instance.capabilities) ? instance.capabilities.map((value) => clean(value)).filter(Boolean).slice(0, 30) : [],
    encryptionPublicKey: clean(instance.encryptionPublicKey),
    encryptionPublicKeyFingerprint: clean(instance.encryptionPublicKeyFingerprint),
    signingPublicKey: clean(instance.signingPublicKey).slice(0, 4096),
    channelKeyHash: clean(instance.channelKeyHash),
    registrationTokenHash: clean(instance.registrationTokenHash),
    requestIp: clean(instance.requestIp),
    userAgent: clean(instance.userAgent).slice(0, 300),
    endpointBaseUrl: clean(instance.endpointBaseUrl).slice(0, 500),
    connectBaseUrl: clean(instance.connectBaseUrl).slice(0, 500),
    setupUrl: clean(instance.setupUrl).slice(0, 800),
    relayAccountId: clean(instance.relayAccountId).slice(0, 120),
    whatsappChatHash: clean(instance.whatsappChatHash).slice(0, 128),
    lastHeartbeatIp: clean(instance.lastHeartbeatIp),
    lastHeartbeatAt: instance.lastHeartbeatAt || null,
    lastSeenAt: instance.lastSeenAt || instance.createdAt || now,
    expiresAt: instance.expiresAt || null,
    disabledAt: instance.disabledAt || null,
    auditStatus: clean(instance.auditStatus).slice(0, 80),
    auditUpdatedAt: instance.auditUpdatedAt || null,
    limits: instance.limits && typeof instance.limits === "object" ? instance.limits : {},
    createdAt: instance.createdAt || now,
    updatedAt: instance.updatedAt || now,
  };
}

function insertBrokerInstanceRow(db, instance) {
  const record = normalizeInstanceRecord(instance);
  db.prepare(`
    insert into orkestr_broker_instances(
      instance_id, channel_id, status, display_name, version, capabilities_json,
      encryption_public_key, encryption_public_key_fingerprint, signing_public_key,
      channel_key_hash, registration_token_hash, request_ip, user_agent,
      endpoint_base_url, connect_base_url, setup_url, relay_account_id, whatsapp_chat_hash,
      last_heartbeat_ip, last_heartbeat_at, last_seen_at, expires_at, disabled_at,
      audit_status, audit_updated_at, limits_json, created_at, updated_at, data
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(instance_id) do update set
      channel_id = excluded.channel_id,
      status = excluded.status,
      display_name = excluded.display_name,
      version = excluded.version,
      capabilities_json = excluded.capabilities_json,
      encryption_public_key = excluded.encryption_public_key,
      encryption_public_key_fingerprint = excluded.encryption_public_key_fingerprint,
      signing_public_key = excluded.signing_public_key,
      channel_key_hash = excluded.channel_key_hash,
      registration_token_hash = excluded.registration_token_hash,
      request_ip = excluded.request_ip,
      user_agent = excluded.user_agent,
      endpoint_base_url = excluded.endpoint_base_url,
      connect_base_url = excluded.connect_base_url,
      setup_url = excluded.setup_url,
      relay_account_id = excluded.relay_account_id,
      whatsapp_chat_hash = excluded.whatsapp_chat_hash,
      last_heartbeat_ip = excluded.last_heartbeat_ip,
      last_heartbeat_at = excluded.last_heartbeat_at,
      last_seen_at = excluded.last_seen_at,
      expires_at = excluded.expires_at,
      disabled_at = excluded.disabled_at,
      audit_status = excluded.audit_status,
      audit_updated_at = excluded.audit_updated_at,
      limits_json = excluded.limits_json,
      updated_at = excluded.updated_at,
      data = excluded.data
  `).run(
    record.instanceId,
    record.channelId,
    record.status,
    record.displayName,
    record.version,
    JSON.stringify(record.capabilities),
    record.encryptionPublicKey,
    record.encryptionPublicKeyFingerprint,
    record.signingPublicKey,
    record.channelKeyHash,
    record.registrationTokenHash,
    record.requestIp,
    record.userAgent,
    record.endpointBaseUrl,
    record.connectBaseUrl,
    record.setupUrl,
    record.relayAccountId,
    record.whatsappChatHash,
    record.lastHeartbeatIp,
    record.lastHeartbeatAt,
    record.lastSeenAt,
    record.expiresAt,
    record.disabledAt,
    record.auditStatus,
    record.auditUpdatedAt,
    JSON.stringify(record.limits),
    record.createdAt,
    record.updatedAt,
    JSON.stringify(record),
  );
}

async function migrateJsonBrokerRegistryIfNeeded(db, paths, existed) {
  const migrated = getBrokerMeta(db, "json_migrated_at", null);
  const count = Number(db.prepare("select count(*) as count from orkestr_broker_instances").get().count || 0);
  if (migrated || (existed && count > 0)) return;
  const registry = await readJson(paths.brokerInstances, {});
  if (registry?.broker && typeof registry.broker === "object") setBrokerMeta(db, "broker", registry.broker);
  if (Array.isArray(registry?.instances) && registry.instances.length) {
    db.exec("begin immediate");
    try {
      for (const instance of registry.instances) insertBrokerInstanceRow(db, instance);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }
  setBrokerMeta(db, "json_migrated_at", nowIso());
}
