import crypto from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";

const terminalStates = new Set(["delivered", "skipped", "skipped_policy", "suppressed", "dead_letter", "cancelled"]);
const operatorActions = new Set(["retry", "suppress", "mark_delivered", "mark-delivered", "replay", "dead_letter", "dead-letter"]);

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

export function normalizeConnectorOutboxAction(action = "") {
  const normalized = clean(action).toLowerCase().replace(/-/g, "_");
  return operatorActions.has(normalized) ? normalized : "";
}

export function connectorOutboxClaimTtlMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CONNECTOR_OUTBOX_CLAIM_TTL_MS || env.ORKESTR_WHATSAPP_OUTBOUND_CLAIM_TTL_MS || 120_000);
  return Number.isFinite(parsed) ? Math.max(5_000, Math.floor(parsed)) : 120_000;
}

export function connectorOutboxRetentionLimit(env = process.env) {
  const raw = clean(env.ORKESTR_CONNECTOR_OUTBOX_RETENTION || env.ORKESTR_WHATSAPP_CONNECTOR_OUTBOX_RETENTION || "");
  const parsed = Number(raw || 10_000);
  const minimum = raw ? 1 : 1_000;
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : 10_000;
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
    clean(input.sourceMessageId),
    clean(input.sourceRevision || "1"),
    clean(input.deliveryType),
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
  return pruneConnectorOutboxJobs([...merged.values()], env);
}

export function pruneConnectorOutboxJobs(jobs = [], env = process.env) {
  const sorted = [...(jobs || [])].sort((left, right) => dateMs(left.createdAt) - dateMs(right.createdAt));
  const active = sorted.filter((job) => !connectorOutboxTerminalState(job.state));
  const terminal = sorted.filter((job) => connectorOutboxTerminalState(job.state));
  const retainedTerminal = terminal
    .sort((left, right) =>
      dateMs(left.updatedAt || left.terminalAt || left.createdAt) - dateMs(right.updatedAt || right.terminalAt || right.createdAt)
    )
    .slice(-connectorOutboxRetentionLimit(env));
  const retained = new Set([...active, ...retainedTerminal].map((job) => job.idempotencyKey));
  return sorted.filter((job) => retained.has(job.idempotencyKey));
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

function filterValueMatches(actual = "", expected = "") {
  const needle = clean(expected).toLowerCase();
  if (!needle) return true;
  return clean(actual).toLowerCase() === needle;
}

function stateFilterMatches(actual = "", expected = "") {
  const raw = clean(expected).toLowerCase();
  if (!raw) return true;
  const states = raw.split(/[\s,]+/g).map(clean).filter(Boolean);
  return !states.length || states.includes(clean(actual || "pending").toLowerCase());
}

export async function listConnectorOutboxJobs(filters = {}, env = process.env) {
  const store = await readConnectorOutbox(env);
  const limit = Math.max(0, Math.floor(Number(filters.limit || 0) || 0));
  const jobs = store.jobs
    .filter((job) => filterValueMatches(job.connector, filters.connector))
    .filter((job) => stateFilterMatches(job.state, filters.state))
    .filter((job) => filterValueMatches(job.tenantId, filters.tenantId))
    .filter((job) => filterValueMatches(job.ownerUserId, filters.ownerUserId || filters.userId))
    .filter((job) => filterValueMatches(job.accountId, filters.accountId))
    .filter((job) => filterValueMatches(job.chatId, filters.chatId))
    .filter((job) => filterValueMatches(job.threadId, filters.threadId || filters.thread))
    .filter((job) => filterValueMatches(job.deliveryType, filters.deliveryType))
    .sort((left, right) => dateMs(right.updatedAt || right.terminalAt || right.createdAt) - dateMs(left.updatedAt || left.terminalAt || left.createdAt));
  const visible = limit ? jobs.slice(0, limit) : jobs;
  return {
    schemaVersion: store.schemaVersion,
    jobs: visible,
    count: visible.length,
    total: jobs.length,
    filters: {
      connector: clean(filters.connector),
      state: clean(filters.state),
      tenantId: clean(filters.tenantId),
      ownerUserId: clean(filters.ownerUserId || filters.userId),
      accountId: clean(filters.accountId),
      chatId: clean(filters.chatId),
      threadId: clean(filters.threadId || filters.thread),
      deliveryType: clean(filters.deliveryType),
      limit,
    },
    generatedAt: nowIso(),
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

function operatorPatchForAction(job = {}, action = "", options = {}) {
  const normalized = normalizeConnectorOutboxAction(action);
  const now = nowIso();
  const reason = clean(options.reason || options.error);
  const operator = clean(options.operator || options.operatorId || "operator");
  if (normalized === "retry" || normalized === "replay") {
    return {
      state: "pending",
      claimedBy: "",
      claimedAt: "",
      claimExpiresAt: "",
      deliveredAt: "",
      failedAt: "",
      skippedAt: "",
      terminalAt: "",
      error: "",
      metadata: {
        ...(job.metadata || {}),
        ...(normalized === "replay" ? { replayCount: Number(job.metadata?.replayCount || 0) + 1 } : {}),
        [`${normalized}RequestedAt`]: now,
        [`${normalized}RequestedBy`]: operator,
        [`${normalized}FromState`]: clean(job.state || "pending"),
        ...(reason ? { [`${normalized}Reason`]: reason } : {}),
      },
    };
  }
  if (normalized === "suppress") {
    return {
      state: "suppressed",
      claimedBy: "",
      claimedAt: "",
      claimExpiresAt: "",
      skippedAt: now,
      terminalAt: now,
      error: reason || "operator_suppressed",
      metadata: {
        ...(job.metadata || {}),
        suppressedBy: operator,
        suppressedAt: now,
      },
    };
  }
  if (normalized === "dead_letter") {
    return {
      state: "dead_letter",
      claimedBy: "",
      claimedAt: "",
      claimExpiresAt: "",
      failedAt: clean(job.failedAt) || now,
      terminalAt: now,
      error: reason || clean(job.error) || "operator_dead_letter",
      metadata: {
        ...(job.metadata || {}),
        deadLetteredBy: operator,
        deadLetteredAt: now,
      },
    };
  }
  if (normalized === "mark_delivered") {
    return {
      state: "delivered",
      claimedBy: "",
      claimedAt: "",
      claimExpiresAt: "",
      deliveredAt: clean(options.deliveredAt) || now,
      terminalAt: now,
      error: "",
      brokerAck: options.brokerAck && typeof options.brokerAck === "object" && !Array.isArray(options.brokerAck)
        ? options.brokerAck
        : {
            operatorMarked: true,
            operator,
            ...(reason ? { reason } : {}),
            markedAt: now,
          },
      metadata: {
        ...(job.metadata || {}),
        markedDeliveredBy: operator,
        markedDeliveredAt: now,
      },
    };
  }
  return null;
}

export async function applyConnectorOutboxJobAction(jobIdOrKey = "", action = "", options = {}, env = process.env) {
  const normalized = normalizeConnectorOutboxAction(action);
  if (!normalized) {
    const error = new Error("connector_outbox_action_invalid");
    error.statusCode = 400;
    throw error;
  }
  const store = await readConnectorOutbox(env);
  const target = clean(jobIdOrKey);
  const current = store.jobs.find((job) => job.id === target || job.idempotencyKey === target);
  if (!current) {
    const error = new Error("connector_outbox_job_missing");
    error.statusCode = 404;
    throw error;
  }
  const patch = operatorPatchForAction(current, normalized, options);
  const job = await markConnectorOutboxJob(current.id, patch, env);
  await appendEvent({
    type: "connector_outbox_operator_action",
    outboxJobId: current.id,
    tenantId: current.tenantId,
    connector: current.connector,
    chatId: current.chatId,
    threadId: current.threadId,
    sourceMessageId: current.sourceMessageId,
    deliveryType: current.deliveryType,
    action: normalized,
    previousState: current.state,
    state: job?.state || "",
    operator: clean(options.operator || options.operatorId || "operator"),
  }, env).catch(() => {});
  return {
    ok: true,
    action: normalized,
    previousState: current.state,
    job,
  };
}
