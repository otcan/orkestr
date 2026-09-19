import { resourceOwnerUserId } from "../../core/src/policy.js";

async function readOwnerProfile(owner, env) {
  const { readUserOnboardingState } = await import("../../core/src/user-onboarding.js");
  return readUserOnboardingState(owner, env);
}

export function capacityResetDate(value) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) return null;
  const date = new Date(epoch < 1e12 ? epoch * 1000 : epoch);
  const year = date.getUTCFullYear();
  return Number.isFinite(date.getTime()) && year >= 2000 && year <= 9999 ? date : null;
}

export function capacityResetLabel(value, timezone = "UTC") {
  const date = capacityResetDate(value);
  if (!date) return "";
  let zone = "UTC";
  try {
    if (typeof timezone === "string" && timezone.trim()) {
      zone = new Intl.DateTimeFormat("en-GB", { timeZone: timezone.trim() }).resolvedOptions().timeZone;
    }
  } catch { /* Invalid or absent owner timezone explicitly falls back to UTC. */ }
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
  return `${formatted.replace(",", "")} ${zone}`;
}

// Only enrich transient delivery context; never persist profile fields into a thread.
// A slow profile store must not hold up a WhatsApp reply.
export async function withWhatsAppOwnerTimezone(thread, env = process.env, readProfile = readOwnerProfile) {
  if (!thread) return thread;
  let timer;
  try {
    const profile = await Promise.race([
      Promise.resolve().then(() => readProfile(resourceOwnerUserId(thread, env), env)),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); }),
    ]);
    return { ...thread, whatsAppDebugOwnerTimezone: profile?.profile?.timezone || "UTC" };
  } catch {
    return { ...thread, whatsAppDebugOwnerTimezone: "UTC" };
  } finally {
    clearTimeout(timer);
  }
}
