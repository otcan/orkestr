import crypto from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";

const terminalStates = new Set(["delivered", "skipped", "skipped_policy", "suppressed", "dead_letter", "cancelled"]);

function clean(value) {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function dateMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function outboxPath(env = process.env) {
  return dataPaths(env).connectorOutbox;
}

function statusRank(value) {
  const status = clean(value || "pending").toLowerCase();
  if (status === "delivered") return 6;
  if (status === "dead_letter" || status === "suppressed" || status === "skipped" || status === "skipped_policy" || status === "cancelled") return 5;
  if (status === "claimed" || status === "sent_to_broker") return 4;
  if (status === "failed_retryable") return 3;
  if (status === "pending") return 2;
  return 1;
}

export function connectorOutboxTerminalState(value = "") {
  return terminalStates.has(clean(value || "pending").toLowerCase());
}

export function connectorOutboxClaimTtlMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CONNECTOR_OUTBOX_CLAIM_TTL_MS || env.ORKESTR_WHATSAPP_OUTBOUND_CLAIM_TTL_MS || 120_000);
  return Number.isFinite(parsed) ? Math.max(5_000, Math.floor(parsed)) : 120_000;
}

export function connectorOutboxPayloadHash(payload = {}) {
  return hash(stableStringify(payload));
}

export function connectorOutboxIdempotencyKey(input = {}) {
  return [
    clean(input.tenantId || input.ownerUserId || "admin"),
    clean(input.connector),
    clean(input.accountId),
    clean(input.chatId),
    clean(input.threadId),
    clean(input.sourceEventId || input.sourceMessageId),
    clean(input.sourceMessageId),
    clean(input.sourceRevision || "1"),
    clean(input.deliveryType),
    clean(input.payloadHash || connectorOutboxPayloadHash(input.payload || {})),
  ].join("|");
}

export function connectorOutboxJobId(input = {}) {
  return `co_${hash(clean(input.idempotencyKey) || connectorOutboxIdempotencyKey(input)).slice(0, 32)}`;
}

export function normalizeConnectorOutboxJob(input = {}, env = process.env) {
  const now = nowIso();
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  const payloadHash = clean(input.payloadHash) || connectorOutboxPayloadHash(payload);
  const idempotencyKey = clean(input.idempotencyKey) || connectorOutboxIdempotencyKey({ ...input, payloadHash, payload });
  const state = clean(input.state || "pending").toLowerCase() || "pending";
  return {
    id: clean(input.id) || connectorOutboxJobId({ ...input, idempotencyKey }),
    tenantId: clean(input.tenantId || input.ownerUserId || env.ORKESTR_ADMIN_USER_ID || "admin"),
    ownerUserId: clean(input.ownerUserId || input.tenantId || env.ORKESTR_ADMIN_USER_ID || "admin"),
    connector: clean(input.connector).toLowerCase(),
    accountId: clean(input.accountId),
    chatId: clean(input.chatId),
    threadId: clean(input.threadId),
    agentId: clean(input.agentId),
    sourceEventId: clean(input.sourceEventId || input.sourceMessageId),
    sourceMessageId: clean(input.sourceMessageId),
    sourceRevision: clean(input.sourceRevision || "1"),
    deliveryType: clean(input.deliveryType),
    payload,
    payloadHash,
    idempotencyKey,
    state,
    attemptCount: Math.max(0, Math.floor(Number(input.attemptCount || 0) || 0)),
    claimedBy: clean(input.claimedBy),
    claimedAt: clean(input.claimedAt),
    claimExpiresAt: clean(input.claimExpiresAt),
    createdAt: clean(input.createdAt) || now,
    updatedAt: clean(input.updatedAt) || now,
    terminalAt: connectorOutboxTerminalState(state) ? clean(input.terminalAt) || now : clean(input.terminalAt),
    deliveredAt: clean(input.deliveredAt),
    failedAt: clean(input.failedAt),
    skippedAt: clean(input.skippedAt),
    error: clean(input.error).slice(0, 1000),
    brokerAck: input.brokerAck && typeof input.brokerAck === "object" && !Array.isArray(input.brokerAck) ? input.brokerAck : null,
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {},
  };
}

function mergeJob(existing = {}, next = {}) {
  const existingRank = statusRank(existing.state);
  const nextRank = statusRank(next.state);
  if (existingRank > nextRank && connectorOutboxTerminalState(existing.state)) return existing;
  if (nextRank > existingRank) return { ...existing, ...next };
  if (existingRank > nextRank) return { ...next, ...existing };
  const existingUpdated = dateMs(existing.updatedAt || existing.terminalAt || existing.createdAt);
  const nextUpdated = dateMs(next.updatedAt || next.terminalAt || next.createdAt);
  return nextUpdated >= existingUpdated ? { ...existing, ...next } : { ...next, ...existing };
}

export function mergeConnectorOutboxJobs(existing = [], next = [], env = process.env) {
  const merged = new Map();
  for (const item of [...(existing || []), ...(next || [])]) {
    const normalized = normalizeConnectorOutboxJob(item, env);
    if (!normalized.idempotencyKey) continue;
    const key = normalized.idempotencyKey;
    merged.set(key, merged.has(key) ? mergeJob(merged.get(key), normalized) : normalized);
  }
  return [...merged.values()].sort((left, right) => dateMs(left.createdAt) - dateMs(right.createdAt));
}

export async function readConnectorOutbox(env = process.env) {
  await ensureDataDirs(env);
  const payload = await readJson(outboxPath(env), { schemaVersion: 1, jobs: [] });
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : Array.isArray(payload) ? payload : [];
  return {
    schemaVersion: 1,
    jobs: mergeConnectorOutboxJobs(jobs, [], env),
  };
}

export async function writeConnectorOutbox(store = {}, env = process.env) {
  await ensureDataDirs(env);
  return writeJson(outboxPath(env), {
    schemaVersion: 1,
    jobs: mergeConnectorOutboxJobs(store.jobs || [], [], env),
    updatedAt: nowIso(),
  });
}

export async function ensureConnectorOutboxJob(input = {}, env = process.env) {
  const store = await readConnectorOutbox(env);
  const job = normalizeConnectorOutboxJob(input, env);
  const existing = store.jobs.find((item) => item.idempotencyKey === job.idempotencyKey) || null;
  const nextJob = existing ? mergeJob(existing, job) : job;
  store.jobs = mergeConnectorOutboxJobs(store.jobs, [nextJob], env);
  await writeConnectorOutbox(store, env);
  if (!existing) {
    await appendEvent({
      type: "connector_outbox_job_created",
      outboxJobId: job.id,
      tenantId: job.tenantId,
      connector: job.connector,
      accountId: job.accountId,
      chatId: job.chatId,
      threadId: job.threadId,
      sourceMessageId: job.sourceMessageId,
      deliveryType: job.deliveryType,
    }, env).catch(() => {});
  }
  return { job: nextJob, created: !existing };
}

function claimExpired(job = {}, nowMs = Date.now()) {
  if (clean(job.state).toLowerCase() !== "claimed" && clean(job.state).toLowerCase() !== "sent_to_broker") return true;
  const expiresAtMs = dateMs(job.claimExpiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

export async function claimConnectorOutboxJob(jobIdOrKey = "", { claimant = "" } = {}, env = process.env) {
  const store = await readConnectorOutbox(env);
  const target = clean(jobIdOrKey);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const ttlMs = connectorOutboxClaimTtlMs(env);
  const index = store.jobs.findIndex((job) => job.id === target || job.idempotencyKey === target);
  if (index < 0) return { acquired: false, reason: "connector_outbox_job_missing" };
  const job = store.jobs[index];
  if (connectorOutboxTerminalState(job.state)) {
    return { acquired: false, reason: `connector_outbox_${job.state}`, terminal: true, job };
  }
  if (!claimExpired(job, nowMs)) {
    return { acquired: false, reason: "connector_outbox_claim_active", job };
  }
  const claimed = normalizeConnectorOutboxJob({
    ...job,
    state: "claimed",
    claimedBy: clean(claimant) || `pid:${process.pid}`,
    claimedAt: now,
    claimExpiresAt: new Date(nowMs + ttlMs).toISOString(),
    attemptCount: Number(job.attemptCount || 0) + 1,
    updatedAt: now,
  }, env);
  store.jobs.splice(index, 1, claimed);
  await writeConnectorOutbox(store, env);
  await appendEvent({
    type: "connector_outbox_job_claimed",
    outboxJobId: claimed.id,
    tenantId: claimed.tenantId,
    connector: claimed.connector,
    chatId: claimed.chatId,
    threadId: claimed.threadId,
    sourceMessageId: claimed.sourceMessageId,
    deliveryType: claimed.deliveryType,
    claimedBy: claimed.claimedBy,
  }, env).catch(() => {});
  return { acquired: true, job: claimed };
}

export async function releaseConnectorOutboxClaim(jobIdOrKey = "", { reason = "" } = {}, env = process.env) {
  const store = await readConnectorOutbox(env);
  const target = clean(jobIdOrKey);
  const index = store.jobs.findIndex((job) => job.id === target || job.idempotencyKey === target);
  if (index < 0) return null;
  const job = store.jobs[index];
  if (connectorOutboxTerminalState(job.state)) return job;
  const released = normalizeConnectorOutboxJob({
    ...job,
    state: "pending",
    claimedBy: "",
    claimedAt: "",
    claimExpiresAt: "",
    error: clean(reason || job.error),
    updatedAt: nowIso(),
  }, env);
  store.jobs.splice(index, 1, released);
  await writeConnectorOutbox(store, env);
  return released;
}

export async function markConnectorOutboxJob(jobIdOrKey = "", patch = {}, env = process.env) {
  const store = await readConnectorOutbox(env);
  const target = clean(jobIdOrKey);
  const index = store.jobs.findIndex((job) => job.id === target || job.idempotencyKey === target);
  if (index < 0) return null;
  const state = clean(patch.state || store.jobs[index].state || "pending").toLowerCase();
  const updated = normalizeConnectorOutboxJob({
    ...store.jobs[index],
    ...patch,
    state,
    claimedBy: connectorOutboxTerminalState(state) ? "" : patch.claimedBy ?? store.jobs[index].claimedBy,
    claimedAt: connectorOutboxTerminalState(state) ? "" : patch.claimedAt ?? store.jobs[index].claimedAt,
    claimExpiresAt: connectorOutboxTerminalState(state) ? "" : patch.claimExpiresAt ?? store.jobs[index].claimExpiresAt,
    terminalAt: connectorOutboxTerminalState(state) ? clean(patch.terminalAt) || nowIso() : clean(patch.terminalAt),
    updatedAt: nowIso(),
  }, env);
  store.jobs.splice(index, 1, updated);
  await writeConnectorOutbox(store, env);
  await appendEvent({
    type: "connector_outbox_job_updated",
    outboxJobId: updated.id,
    tenantId: updated.tenantId,
    connector: updated.connector,
    chatId: updated.chatId,
    threadId: updated.threadId,
    sourceMessageId: updated.sourceMessageId,
    deliveryType: updated.deliveryType,
    state: updated.state,
  }, env).catch(() => {});
  return updated;
}
