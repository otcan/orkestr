const DEFAULT_RETENTION_DAYS = 90;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3_650;

export function mailboxMessageRetentionDays(env = process.env) {
  const parsed = Number(env.ORKESTR_MAILBOX_MESSAGE_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS;
  return Math.max(MIN_RETENTION_DAYS, Math.min(MAX_RETENTION_DAYS, Math.floor(parsed)));
}

export function mailboxSourceIsRetained(source = {}, env = process.env, nowMs = Date.now()) {
  const createdAt = Date.parse(source.createdAt || "");
  if (!Number.isFinite(createdAt)) return true;
  return createdAt >= nowMs - mailboxMessageRetentionDays(env) * 24 * 60 * 60 * 1_000;
}
