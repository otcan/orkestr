// Dual-provider quota segment for the WhatsApp debug footer. Both Codex and
// Claude remaining quota are always shown so the owner can decide when to move
// a thread to the other executor (`/claude`, `/codex`).
import {
  mergeThreadIntoProviderQuota,
  providerQuotaSnapshot,
  providerQuotaStaleMs,
  threadQuotaProvider,
} from "../../core/src/provider-quota-snapshot.js";
import { capacityResetLabel } from "./whatsapp-capacity-reset.js";

function windowValue(pct, status) {
  if (Number.isFinite(pct)) return `${pct}%`;
  if (status === "allowed") return "ok";
  return "?";
}

export function providerQuotaSegment(quota = null, provider = "codex", { timezone = "UTC" } = {}) {
  const entry = quota || {};
  const parts = [
    provider,
    `5h:${windowValue(entry.fiveHourRemainingPct, entry.fiveHourStatus)}`,
    `wk:${windowValue(entry.weeklyRemainingPct, entry.weeklyStatus)}`,
  ];
  // Reset times are shown for both providers so the owner can see when the
  // inactive provider's quota comes back before switching to it.
  const fiveHourReset = entry.fiveHourResetsAt ? capacityResetLabel(Date.parse(entry.fiveHourResetsAt), timezone) : "";
  const weeklyReset = entry.weeklyResetsAt ? capacityResetLabel(Date.parse(entry.weeklyResetsAt), timezone) : "";
  if (fiveHourReset) parts.push(`5h-reset:${fiveHourReset}`);
  if (weeklyReset) parts.push(`wk-reset:${weeklyReset}`);
  if (entry.limited) parts.push("(limited)");
  if (entry.stale) parts.push("(stale)");
  return parts.join(" ");
}

// Time left until a quota window resets: "2d23h", "1h30", "45m".
export function quotaResetCountdown(resetsAt = "", now = Date.now()) {
  const at = Date.parse(resetsAt || "");
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${String(mins).padStart(2, "0")}`;
  return `${mins}m`;
}

function quotaWindowText(label, pct, status, resetsAt, now) {
  const hasValue = Number.isFinite(pct) || status === "allowed";
  if (!hasValue && !resetsAt) return "";
  const countdown = quotaResetCountdown(resetsAt, now);
  return `${label}: ${windowValue(pct, status)}${countdown ? ` (${countdown})` : ""}`;
}

// One footer line per provider, e.g. "claude 5h: 90% (1h30) wk: 99% (1d23h)".
// A window the provider does not report (such as Codex without a 5h limit)
// is left out instead of shown as "?".
export function providerQuotaLine(quota = null, provider = "codex", now = Date.now()) {
  const entry = quota || {};
  const windows = [
    quotaWindowText("5h", entry.fiveHourRemainingPct, entry.fiveHourStatus, entry.fiveHourResetsAt, now),
    quotaWindowText("wk", entry.weeklyRemainingPct, entry.weeklyStatus, entry.weeklyResetsAt, now),
  ].filter(Boolean);
  const flags = [entry.limited ? "(limited)" : "", entry.stale ? "(stale)" : ""].filter(Boolean);
  return [windows.length ? `${provider} ${windows.join(" ")}` : `${provider}: no data`, ...flags].join(" ");
}

export function dualProviderQuotaLines(thread = {}, env = process.env, now = Date.now()) {
  const snapshot = mergeThreadIntoProviderQuota(thread?.whatsAppDebugProviderQuota || null, thread, {
    now,
    staleMs: providerQuotaStaleMs(env),
  });
  return ["codex", "claude"].map((provider) => providerQuotaLine(snapshot[provider], provider, now));
}

export function dualProviderQuotaSegments(thread = {}, env = process.env, now = Date.now()) {
  const snapshot = mergeThreadIntoProviderQuota(thread?.whatsAppDebugProviderQuota || null, thread, {
    now,
    staleMs: providerQuotaStaleMs(env),
  });
  const timezone = thread?.whatsAppDebugOwnerTimezone || "UTC";
  return ["codex", "claude"].map((provider) =>
    providerQuotaSegment(snapshot[provider], provider, { timezone }));
}

export function executorSwitchHint(thread = {}) {
  const active = threadQuotaProvider(thread);
  if (active === "claude") return "switch:/codex";
  if (active === "codex") return "switch:/claude";
  return "";
}

// Only enrich transient delivery context; the snapshot is never persisted into
// the thread. A slow thread store must not hold up a WhatsApp reply.
export async function withWhatsAppProviderQuota(thread, env = process.env, loadSnapshot = providerQuotaSnapshot) {
  if (!thread) return thread;
  let timer;
  try {
    const snapshot = await Promise.race([
      Promise.resolve().then(() => loadSnapshot({ ownerUserId: thread.ownerUserId || thread.userId || "" }, env)),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 250); }),
    ]);
    return snapshot ? { ...thread, whatsAppDebugProviderQuota: snapshot } : thread;
  } catch {
    return thread;
  } finally {
    clearTimeout(timer);
  }
}
