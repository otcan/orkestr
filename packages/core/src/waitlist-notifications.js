import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { sendWaitlistNotification } from "./email-notifications.js";

function nowIso() {
  return new Date().toISOString();
}

function clean(value = "") {
  return String(value || "").trim();
}

export function waitlistNotificationRecord(notification = null) {
  if (!notification || typeof notification !== "object") return null;
  const state = clean(notification.state);
  const sentAt = clean(notification.sentAt);
  const updatedAt = clean(notification.updatedAt);
  const error = clean(notification.error).slice(0, 240);
  const skippedReason = clean(notification.skippedReason).slice(0, 120);
  const recipients = Array.isArray(notification.recipients)
    ? notification.recipients.map((recipient) => clean(recipient).slice(0, 160)).filter(Boolean).slice(0, 10)
    : [];
  if (!state && !sentAt && !updatedAt && !error && !skippedReason && !recipients.length) return null;
  return {
    state: state || "unknown",
    recipients,
    sentAt,
    updatedAt,
    error,
    skippedReason,
  };
}

export async function notifyWaitlistEntrySubmitted(entry = {}, { isNewEntry = false, env = process.env, dependencies = {} } = {}) {
  if (!isNewEntry) return null;
  const now = nowIso();
  try {
    const sender = typeof dependencies.sendWaitlistNotification === "function"
      ? dependencies.sendWaitlistNotification
      : sendWaitlistNotification;
    const result = await sender(entry, env);
    const notification = waitlistNotificationRecord({
      state: result?.ok ? "sent" : "skipped",
      recipients: result?.recipients || [],
      sentAt: result?.ok ? now : "",
      updatedAt: now,
      skippedReason: result?.ok ? "" : clean(result?.skippedReason || "waitlist_notification_skipped"),
      error: "",
    });
    await appendEvent({
      type: result?.ok ? "waitlist_notification_sent" : "waitlist_notification_skipped",
      waitlistEntryId: entry.id,
      configured: result?.configured !== false,
      skippedReason: notification?.skippedReason || "",
      recipientCount: notification?.recipients?.length || 0,
    }, env).catch(() => {});
    return notification;
  } catch (error) {
    const notification = waitlistNotificationRecord({
      state: "failed",
      updatedAt: now,
      error: error?.message || String(error),
    });
    await appendEvent({
      type: "waitlist_notification_failed",
      waitlistEntryId: entry.id,
      error: notification?.error || "",
    }, env).catch(() => {});
    return notification;
  }
}

export async function setWaitlistNotification(entryId, notification = {}, env = process.env) {
  const id = clean(entryId);
  if (!id) return null;
  const path = dataPaths(env).waitlist;
  const store = await readJson(path, { schemaVersion: 1, entries: [], updatedAt: nowIso() });
  const entries = Array.isArray(store.entries) ? store.entries : [];
  const index = entries.findIndex((entry) => String(entry.id || "") === id);
  if (index < 0) return null;
  entries[index] = {
    ...entries[index],
    notification: waitlistNotificationRecord(notification),
  };
  await writeJson(path, {
    ...store,
    schemaVersion: 1,
    entries,
    updatedAt: nowIso(),
  });
  return entries[index];
}
