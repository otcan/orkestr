import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import fs from "node:fs/promises";
import http2 from "node:http2";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { snapshotEnvironment } from "../../storage/src/test-storage-isolation.js";
import { mobileDeviceContextIsActive } from "./mobile-devices.js";

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function hash(value = "") {
  return createHash("sha256").update(String(value)).digest("hex");
}

function boundedInt(env, key, fallback, minimum, maximum) {
  const parsed = Number(env[key]);
  const value = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function pushEnabled(env) {
  return clean(env.ORKESTR_MOBILE_PUSH_ENABLED) === "1";
}

export function mobilePushCapability(env = process.env) {
  if (!pushEnabled(env)) return { enabled: false, reason: "disabled" };
  if (!clean(env.ORKESTR_APNS_TEAM_ID) || !clean(env.ORKESTR_APNS_KEY_ID) ||
      (!clean(env.ORKESTR_APNS_PRIVATE_KEY) && !clean(env.ORKESTR_APNS_PRIVATE_KEY_FILE))) {
    return { enabled: false, reason: "configuration_incomplete" };
  }
  return { enabled: true, reason: null };
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

let cachedJwt = null;

async function privateKey(env) {
  const inline = clean(env.ORKESTR_APNS_PRIVATE_KEY);
  if (inline) return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
  return fs.readFile(clean(env.ORKESTR_APNS_PRIVATE_KEY_FILE), "utf8");
}

async function providerToken(env) {
  const teamId = clean(env.ORKESTR_APNS_TEAM_ID);
  const keyId = clean(env.ORKESTR_APNS_KEY_ID);
  const cacheKey = `${teamId}:${keyId}`;
  const issuedAt = Math.floor(Date.now() / 1000);
  if (cachedJwt?.cacheKey === cacheKey && issuedAt - cachedJwt.issuedAt < 45 * 60) return cachedJwt.value;
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: issuedAt }));
  const signingInput = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(await privateKey(env)),
    dsaEncoding: "ieee-p1363",
  });
  const value = `${signingInput}.${signature.toString("base64url")}`;
  cachedJwt = { cacheKey, issuedAt, value };
  return value;
}

function apnsHost(environment) {
  return environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
}

export async function sendMobileApns(target, payload, options = {}) {
  const env = options.env || process.env;
  if (!mobilePushCapability(env).enabled) return { ok: false, retryable: true, statusCode: 0 };
  const connect = options.connect || http2.connect;
  let jwt;
  try {
    jwt = await providerToken(env);
  } catch {
    return { ok: false, retryable: true, statusCode: 0 };
  }
  return new Promise((resolve) => {
    const client = connect(apnsHost(target.environment));
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      client.close();
      resolve(result);
    };
    timer = setTimeout(() => finish({ ok: false, retryable: true, statusCode: 0 }),
      boundedInt(env, "ORKESTR_APNS_TIMEOUT_MS", 5000, 1000, 15_000));
    timer.unref?.();
    client.once("error", () => finish({ ok: false, retryable: true, statusCode: 0 }));
    let request;
    try {
      request = client.request({
        ":method": "POST",
        ":path": `/3/device/${encodeURIComponent(target.token)}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": target.topic,
        "apns-push-type": target.pushType,
        "apns-priority": target.pushType === "liveactivity" ? "5" : "10",
        "apns-expiration": "0",
        "apns-collapse-id": target.collapseId,
        "content-type": "application/json",
      });
    } catch {
      finish({ ok: false, retryable: true, statusCode: 0 });
      return;
    }
    let statusCode = 0;
    request.on("response", (headers) => { statusCode = Number(headers[":status"] || 0); });
    request.on("data", () => {});
    request.on("end", () => finish({
      ok: statusCode === 200,
      invalidToken: statusCode === 410,
      retryable: statusCode === 0 || statusCode === 429 || statusCode >= 500,
      statusCode,
    }));
    request.on("error", () => finish({ ok: false, retryable: true, statusCode: 0 }));
    request.end(JSON.stringify(payload));
  });
}

async function tokenState(env) {
  const paths = await ensureDataDirs(env);
  const state = await readJson(paths.mobilePushTokens, { pushTokens: [], liveActivities: [] });
  return {
    pushTokens: Array.isArray(state.pushTokens) ? state.pushTokens : [],
    liveActivities: Array.isArray(state.liveActivities) ? state.liveActivities : [],
  };
}

function tokenError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function assertPrincipal(device, principal) {
  if (!clean(device.ownerUserId) || clean(device.ownerUserId) !== clean(principal?.userId) || !clean(device.sessionId)) {
    throw tokenError("mobile_device_profile_forbidden", 403);
  }
}

export async function upsertMobilePushToken(input = {}, options = {}) {
  const env = snapshotEnvironment(options.env || process.env);
  const device = input.device || {};
  assertPrincipal(device, input.principal || {});
  const deviceActive = options.dependencies?.deviceActive || mobileDeviceContextIsActive;
  if (!(await deviceActive(device, env))) throw tokenError("mobile_device_revoked", 401);
  const paths = await ensureDataDirs(env);
  return withStorageFileLock(paths.mobilePushTokens, async () => {
    const state = await readJson(paths.mobilePushTokens, { schemaVersion: 1, pushTokens: [], liveActivities: [] });
    state.pushTokens = Array.isArray(state.pushTokens) ? state.pushTokens : [];
    const tokenHash = hash(input.token);
    state.pushTokens = state.pushTokens.filter((item) => input.operation === "upsert"
      ? !(item.deviceId === device.deviceId && item.environment === input.environment)
      : !(item.deviceId === device.deviceId && item.tokenHash === tokenHash));
    const updatedAt = nowIso();
    if (input.operation === "upsert") state.pushTokens.push({
      deviceId: device.deviceId,
      ownerUserId: device.ownerUserId,
      environment: input.environment,
      token: input.token,
      tokenHash,
      topic: "com.orkestr.hush",
      createdAt: updatedAt,
      updatedAt,
      lastSuccessAt: null,
    });
    state.updatedAt = updatedAt;
    await writeSecretJson(paths.mobilePushTokens, state);
    return { ok: true, updatedAt };
  });
}

export async function upsertMobileLiveActivityToken(input = {}, options = {}) {
  const env = snapshotEnvironment(options.env || process.env);
  const device = input.device || {};
  assertPrincipal(device, input.principal || {});
  const deviceActive = options.dependencies?.deviceActive || mobileDeviceContextIsActive;
  if (!(await deviceActive(device, env))) throw tokenError("mobile_device_revoked", 401);
  const paths = await ensureDataDirs(env);
  return withStorageFileLock(paths.mobilePushTokens, async () => {
    const state = await readJson(paths.mobilePushTokens, { schemaVersion: 1, pushTokens: [], liveActivities: [] });
    state.liveActivities = Array.isArray(state.liveActivities) ? state.liveActivities : [];
    state.liveActivities = state.liveActivities.filter((item) =>
      !(item.deviceId === device.deviceId && item.activityId === input.activityId)
    );
    const updatedAt = nowIso();
    if (input.operation === "upsert") state.liveActivities.push({
      deviceId: device.deviceId,
      ownerUserId: device.ownerUserId,
      activityId: input.activityId,
      environment: input.environment,
      token: input.token,
      tokenHash: hash(input.token),
      topic: "com.orkestr.hush.push-type.liveactivity",
      createdAt: updatedAt,
      updatedAt,
      lastSuccessAt: null,
    });
    state.updatedAt = updatedAt;
    await writeSecretJson(paths.mobilePushTokens, state);
    return { ok: true, updatedAt };
  });
}

export async function removeMobilePushTokensForDevice(deviceId, env = process.env) {
  const paths = await ensureDataDirs(env);
  return withStorageFileLock(paths.mobilePushTokens, async () => {
    const state = await readJson(paths.mobilePushTokens, { schemaVersion: 1, pushTokens: [], liveActivities: [] });
    state.pushTokens = (state.pushTokens || []).filter((item) => item.deviceId !== deviceId);
    state.liveActivities = (state.liveActivities || []).filter((item) => item.deviceId !== deviceId);
    state.updatedAt = nowIso();
    await writeSecretJson(paths.mobilePushTokens, state);
    return true;
  });
}

function safeDetail(stage, detail) {
  const explicit = clean(detail).replace(/\s+/g, " ").slice(0, 160);
  if (["completed", "failed", "waiting_for_approval"].includes(stage) && explicit) return explicit;
  return {
    completed: "Orkestr finished your Hush request.",
    failed: "Orkestr could not finish your Hush request.",
    waiting_for_approval: "Orkestr needs your attention.",
  }[stage] || "Orkestr has an update for your Hush request.";
}

function payloadFor(job) {
  if (job.pushType === "liveactivity") {
    return {
      aps: {
        timestamp: Math.floor(Date.now() / 1000),
        event: job.stage === "completed" || job.stage === "failed" ? "end" : "update",
        "content-state": {
          stage: job.stage,
          detail: job.detail,
          callId: job.callId,
          taskId: job.taskId || null,
        },
      },
    };
  }
  return {
    aps: {
      alert: { title: "Hush", body: job.detail },
      sound: "default",
      "thread-id": `hush-${job.callId}`,
    },
    callId: job.callId,
    taskId: job.taskId || null,
    stage: job.stage,
  };
}

function trimOutbox(state, env) {
  const limit = boundedInt(env, "ORKESTR_MOBILE_PUSH_OUTBOX_RETENTION", 2000, 100, 20_000);
  const ordered = [...state.jobs].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const terminal = ordered.filter((job) => ["delivered", "failed", "dropped"].includes(job.status));
  const removable = new Set(terminal.slice(0, Math.max(0, ordered.length - limit)).map((job) => job.id));
  state.jobs = ordered.filter((job) => !removable.has(job.id));
}

export async function enqueueMobileRealtimePush(call, event, options = {}) {
  const env = snapshotEnvironment(options.env || process.env);
  const stage = clean(event?.stage);
  if (!pushEnabled(env) || !["waiting_for_approval", "completed", "failed"].includes(stage)) return 0;
  const tokens = await tokenState(env);
  const targets = [
    ...tokens.pushTokens.filter((item) => item.deviceId === call.deviceId).map((item) => ({ ...item, pushType: "alert" })),
    ...tokens.liveActivities.filter((item) => item.deviceId === call.deviceId).map((item) => ({ ...item, pushType: "liveactivity" })),
  ];
  if (!targets.length) return 0;
  const paths = await ensureDataDirs(env);
  return withStorageFileLock(paths.mobilePushOutbox, async () => {
    const state = await readJson(paths.mobilePushOutbox, { schemaVersion: 1, jobs: [] });
    state.jobs = Array.isArray(state.jobs) ? state.jobs : [];
    let added = 0;
    for (const target of targets) {
      const deliveryKey = hash(`${target.pushType}\n${target.tokenHash}\n${call.id}\n${event.taskId || ""}\n${stage}`);
      if (state.jobs.some((job) => job.deliveryKey === deliveryKey)) continue;
      state.jobs.push({
        id: `mpo_${randomUUID()}`,
        deliveryKey,
        tokenHash: target.tokenHash,
        deviceId: call.deviceId,
        environment: target.environment,
        topic: target.topic,
        pushType: target.pushType,
        callId: call.id,
        taskId: clean(event.taskId),
        stage,
        detail: safeDetail(stage, event.detail),
        collapseId: `hush-${hash(`${call.id}:${event.taskId || "call"}`).slice(0, 32)}`,
        status: "pending",
        attempts: 0,
        nextAttemptAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      added += 1;
    }
    trimOutbox(state, env);
    state.updatedAt = nowIso();
    await writeJson(paths.mobilePushOutbox, state);
    return added;
  });
}

async function claimJobs(env, owner) {
  const paths = await ensureDataDirs(env);
  return withStorageFileLock(paths.mobilePushOutbox, async () => {
    const state = await readJson(paths.mobilePushOutbox, { schemaVersion: 1, jobs: [] });
    state.jobs = Array.isArray(state.jobs) ? state.jobs : [];
    const due = state.jobs.filter((job) =>
      (job.status === "pending" || (job.status === "delivering" && Date.parse(job.leaseExpiresAt || "") <= Date.now())) &&
      Date.parse(job.nextAttemptAt || "") <= Date.now()
    ).slice(0, boundedInt(env, "ORKESTR_MOBILE_PUSH_BATCH_SIZE", 20, 1, 100));
    for (const job of due) {
      job.status = "delivering";
      job.leaseOwner = owner;
      job.leaseExpiresAt = new Date(Date.now() + 30_000).toISOString();
      job.updatedAt = nowIso();
    }
    if (due.length) await writeJson(paths.mobilePushOutbox, state);
    return due.map((job) => structuredClone(job));
  });
}

async function finishJob(job, result, env, owner) {
  const paths = await ensureDataDirs(env);
  await withStorageFileLock(paths.mobilePushOutbox, async () => {
    const state = await readJson(paths.mobilePushOutbox, { schemaVersion: 1, jobs: [] });
    const stored = (state.jobs || []).find((item) => item.id === job.id && item.leaseOwner === owner);
    if (!stored) return;
    stored.attempts = Number(stored.attempts || 0) + 1;
    stored.lastStatusCode = Number(result.statusCode || 0);
    stored.updatedAt = nowIso();
    stored.leaseOwner = "";
    stored.leaseExpiresAt = "";
    const exhausted = stored.attempts >= boundedInt(env, "ORKESTR_MOBILE_PUSH_MAX_ATTEMPTS", 8, 1, 20);
    if (result.ok) stored.status = "delivered";
    else if (result.invalidToken) stored.status = "dropped";
    else if (!result.retryable || exhausted) stored.status = "failed";
    else {
      stored.status = "pending";
      const backoff = Math.min(3600, 2 ** Math.min(10, stored.attempts) * 5);
      stored.nextAttemptAt = new Date(Date.now() + backoff * 1000).toISOString();
    }
    trimOutbox(state, env);
    state.updatedAt = nowIso();
    await writeJson(paths.mobilePushOutbox, state);
  });
}

async function resolveTarget(job, env) {
  const state = await tokenState(env);
  const source = job.pushType === "liveactivity" ? state.liveActivities : state.pushTokens;
  return source.find((item) => item.deviceId === job.deviceId && item.tokenHash === job.tokenHash) || null;
}

async function updateTokenResult(job, result, env) {
  const paths = await ensureDataDirs(env);
  await withStorageFileLock(paths.mobilePushTokens, async () => {
    const state = await readJson(paths.mobilePushTokens, { schemaVersion: 1, pushTokens: [], liveActivities: [] });
    const key = job.pushType === "liveactivity" ? "liveActivities" : "pushTokens";
    state[key] = Array.isArray(state[key]) ? state[key] : [];
    if (result.invalidToken) {
      state[key] = state[key].filter((item) => !(item.deviceId === job.deviceId && item.tokenHash === job.tokenHash));
    } else if (result.ok) {
      const token = state[key].find((item) => item.deviceId === job.deviceId && item.tokenHash === job.tokenHash);
      if (token) token.lastSuccessAt = nowIso();
    }
    state.updatedAt = nowIso();
    await writeSecretJson(paths.mobilePushTokens, state);
  });
}

export async function processMobilePushOutbox(options = {}) {
  const env = snapshotEnvironment(options.env || process.env);
  if (!mobilePushCapability(env).enabled) return { processed: 0, configured: false };
  const owner = `push:${process.pid}:${randomUUID()}`;
  const jobs = await claimJobs(env, owner);
  for (const job of jobs) {
    const target = await resolveTarget(job, env);
    const result = target
      ? await (options.send || sendMobileApns)({ ...target, pushType: job.pushType, collapseId: job.collapseId }, payloadFor(job), { env })
      : { ok: false, invalidToken: true, retryable: false, statusCode: 410 };
    await updateTokenResult(job, result, env);
    await finishJob(job, result, env, owner);
  }
  return { processed: jobs.length, configured: true };
}

export async function notifyMobileDeviceRevoked(deviceId, options = {}) {
  const env = snapshotEnvironment(options.env || process.env);
  if (!mobilePushCapability(env).enabled) return 0;
  const state = await tokenState(env);
  const targets = [
    ...state.pushTokens.filter((item) => item.deviceId === clean(deviceId)).map((item) => ({ ...item, pushType: "alert" })),
    ...state.liveActivities.filter((item) => item.deviceId === clean(deviceId)).map((item) => ({ ...item, pushType: "liveactivity" })),
  ];
  await Promise.allSettled(targets.map((target) => {
    const payload = target.pushType === "liveactivity"
      ? { aps: { timestamp: Math.floor(Date.now() / 1000), event: "end", "content-state": { stage: "revoked", detail: "Device revoked." } } }
      : { aps: { alert: { title: "Hush", body: "This Hush device was revoked." } }, event: "device_revoked" };
    return (options.send || sendMobileApns)({
      ...target,
      collapseId: `hush-revoked-${hash(deviceId).slice(0, 24)}`,
    }, payload, { env });
  }));
  return targets.length;
}
