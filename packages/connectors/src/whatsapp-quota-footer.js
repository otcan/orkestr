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
