import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { adminUserId, listUsers, normalizeUserId, readUserPrivateIdentities } from "../../core/src/users.js";

const falseValues = new Set(["0", "false", "no", "off", "disabled"]);
const defaultPendingTtlMs = 10 * 60 * 1000;

function clean(value = "") {
  return String(value || "").trim();
}

function splitList(value = "") {
  return String(value || "")
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function lowerSet(values = []) {
  return new Set(values.map((value) => clean(value).toLowerCase()).filter(Boolean));
}

function envDisabled(env = process.env) {
  const explicit = clean(env.ORKESTR_RELEASE_WA_NOTIFICATIONS || env.ORKESTR_RELEASE_WA_NOTIFY_ENABLED);
  return explicit ? falseValues.has(explicit.toLowerCase()) : false;
}

function excludedChatIds(env = process.env) {
  return lowerSet([
    ...splitList(env.ORKESTR_RELEASE_WA_NOTIFY_EXCLUDE_CHAT_IDS),
    ...splitList(env.ORKESTR_RELEASE_WA_EXCLUDE_CHAT_IDS),
    ...splitList(env.ORKESTR_RELEASE_WA_ADMIN_CHAT_IDS),
    ...splitList(env.ORKESTR_WHATSAPP_ADMIN_CHAT_IDS),
  ]);
}

export function releaseWhatsAppNotificationLedgerPath(env = process.env) {
  return dataPaths(env).releaseWhatsAppNotifications;
}

export function releaseWhatsAppNotificationText({ releaseId = "", channel = "", commit = "", deployedAt = "" } = {}) {
  const shortCommit = clean(commit).slice(0, 12);
  return [
    "Orkestr was updated successfully.",
    clean(releaseId) ? `Release: ${clean(releaseId)}` : "",
    clean(channel) ? `Channel: ${clean(channel)}` : "",
    shortCommit ? `Commit: ${shortCommit}` : "",
    clean(deployedAt) ? `Time: ${clean(deployedAt)}` : "",
  ].filter(Boolean).join("\n");
}

export async function listReleaseWhatsAppNotificationTargets(env = process.env) {
  if (envDisabled(env)) return [];
  const adminId = normalizeUserId(env.ORKESTR_ADMIN_USER_ID || adminUserId);
  const excluded = excludedChatIds(env);
  const targets = [];
  const seen = new Set();
  for (const user of await listUsers(env)) {
    const userId = normalizeUserId(user.id || user.userId || "");
    if (!userId || userId === adminId) continue;
    if (clean(user.role).toLowerCase() === "admin") continue;
    if (clean(user.status || "active").toLowerCase() === "disabled") continue;
    const identities = await readUserPrivateIdentities(userId, env);
    for (const identity of identities) {
      if (clean(identity.provider).toLowerCase() !== "whatsapp") continue;
      const chatId = clean(identity.chatId || identity.waChatId || identity.whatsappChatId);
      if (!chatId || excluded.has(chatId.toLowerCase())) continue;
      const accountId = clean(identity.accountId);
      const key = `${accountId}\0${chatId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        ownerUserId: userId,
        displayName: clean(user.displayName || identity.displayName || userId),
        accountId,
        chatId,
        externalId: clean(identity.externalId),
        source: clean(identity.source),
      });
    }
  }
  return targets;
}

function notificationKey(releaseId = "", target = {}) {
  return [clean(releaseId), clean(target.accountId), clean(target.chatId)].join(":");
}

async function readLedger(env = process.env) {
  const ledger = await readJson(releaseWhatsAppNotificationLedgerPath(env), { schemaVersion: 1, notifications: {} });
  return {
    schemaVersion: 1,
    notifications: ledger && typeof ledger.notifications === "object" && !Array.isArray(ledger.notifications)
      ? ledger.notifications
      : {},
  };
}

async function writeLedger(ledger, env = process.env) {
  await writeJson(releaseWhatsAppNotificationLedgerPath(env), {
    schemaVersion: 1,
    notifications: ledger.notifications || {},
  });
}

function delivered(record = {}) {
  return clean(record.status).toLowerCase() === "delivered";
}

function pendingIsFresh(record = {}, now = Date.now(), env = process.env) {
  if (clean(record.status).toLowerCase() !== "pending") return false;
  const ttlMs = Math.max(1, Number(env.ORKESTR_RELEASE_WA_NOTIFY_PENDING_TTL_MS || defaultPendingTtlMs) || defaultPendingTtlMs);
  const lastAttemptAt = Date.parse(clean(record.lastAttemptAt || record.claimedAt));
  return Number.isFinite(lastAttemptAt) && now - lastAttemptAt < ttlMs;
}

async function postNotification({ apiBase = "", token = "", target = {}, text = "", env = process.env } = {}, fetchImpl = fetch) {
  const endpoint = new URL("/api/connectors/whatsapp/bridge/send-text", `${clean(apiBase).replace(/\/+$/g, "") || "http://127.0.0.1:19812"}/`);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(clean(token) ? { authorization: `Bearer ${clean(token)}` } : {}),
    },
    body: JSON.stringify({
      chatId: target.chatId,
      text,
      ...(target.accountId ? { accountId: target.accountId } : {}),
    }),
    signal: AbortSignal.timeout(Number(env.ORKESTR_RELEASE_WA_NOTIFY_TIMEOUT_MS || 10_000)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || `release_whatsapp_notification_failed_${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

export async function sendReleaseWhatsAppNotifications(options = {}, env = process.env, fetchImpl = fetch) {
  const releaseId = clean(options.releaseId);
  const result = {
    enabled: !envDisabled(env),
    releaseId,
    channel: clean(options.channel),
    commit: clean(options.commit),
    targetCount: 0,
    sent: 0,
    failed: 0,
    skippedDelivered: 0,
    skippedPending: 0,
    errors: [],
  };
  if (!result.enabled) return result;
  if (!releaseId) throw new Error("release_id_required");

  const now = Date.now();
  const targets = await listReleaseWhatsAppNotificationTargets(env);
  result.targetCount = targets.length;
  const ledger = await readLedger(env);
  const text = clean(options.text) || releaseWhatsAppNotificationText(options);

  for (const target of targets) {
    const key = notificationKey(releaseId, target);
    const previous = ledger.notifications[key] || {};
    if (delivered(previous)) {
      result.skippedDelivered += 1;
      continue;
    }
    if (pendingIsFresh(previous, now, env)) {
      result.skippedPending += 1;
      continue;
    }

    const attempt = Number(previous.attempts || 0) + 1;
    const claimedAt = new Date().toISOString();
    ledger.notifications[key] = {
      ...previous,
      releaseId,
      channel: result.channel,
      commit: result.commit,
      ownerUserId: target.ownerUserId,
      accountId: target.accountId,
      chatId: target.chatId,
      status: "pending",
      attempts: attempt,
      claimedAt,
      lastAttemptAt: claimedAt,
    };
    await writeLedger(ledger, env);

    try {
      const payload = await postNotification({
        apiBase: options.apiBase,
        token: options.token,
        target,
        text,
        env,
      }, fetchImpl);
      ledger.notifications[key] = {
        ...ledger.notifications[key],
        status: "delivered",
        deliveredAt: new Date().toISOString(),
        lastError: "",
        messageIds: Array.isArray(payload?.sent)
          ? payload.sent.map((item) => clean(item?.id)).filter(Boolean)
          : [],
      };
      await writeLedger(ledger, env);
      result.sent += 1;
      await appendEvent({
        type: "release_whatsapp_notification_delivered",
        releaseId,
        channel: result.channel,
        commit: result.commit,
        ownerUserId: target.ownerUserId,
        accountId: target.accountId,
        chatId: target.chatId,
      }, env).catch(() => {});
    } catch (error) {
      const message = error?.message || String(error);
      ledger.notifications[key] = {
        ...ledger.notifications[key],
        status: "failed",
        failedAt: new Date().toISOString(),
        lastError: message,
      };
      await writeLedger(ledger, env);
      result.failed += 1;
      result.errors.push({ ownerUserId: target.ownerUserId, chatId: target.chatId, error: message });
      await appendEvent({
        type: "release_whatsapp_notification_failed",
        releaseId,
        channel: result.channel,
        commit: result.commit,
        ownerUserId: target.ownerUserId,
        accountId: target.accountId,
        chatId: target.chatId,
        error: message,
      }, env).catch(() => {});
    }
  }

  await appendEvent({
    type: "release_whatsapp_notifications_completed",
    releaseId,
    channel: result.channel,
    commit: result.commit,
    targetCount: result.targetCount,
    sent: result.sent,
    failed: result.failed,
    skippedDelivered: result.skippedDelivered,
    skippedPending: result.skippedPending,
  }, env).catch(() => {});
  return result;
}
