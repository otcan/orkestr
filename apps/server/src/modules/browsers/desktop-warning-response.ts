import { activeDesktopLeaseStatus } from "../../../../../packages/browsers/src/desktop-leases.js";
import { listBrowserSessions } from "../../../../../packages/browsers/src/browsers.js";
import { desktopAccessWarnings, desktopWarningAttemptId, stoppedDesktopLeaseRecoveryState } from "../../../../../packages/browsers/src/desktop-access-warnings.js";
import { authorizeDesktopAccess } from "../../../../../packages/core/src/desktop-access.js";

export function desktopShareReady(browser: any): boolean {
  if (!browser) return false;
  const status = String(browser.status || browser.state || "").trim().toLowerCase();
  if (!["running", "active", "open"].includes(status)) return false;
  if (browser.readiness && typeof browser.readiness === "object" && browser.readiness.ok === false) return false;
  if (browser.visual_ok === false || browser.bridge_ok === false || browser.web_ok === false) return false;
  return true;
}

export function desktopShareNotReadyReason(browser: any, fallback = "desktop_share_not_ready"): string {
  if (!browser) return fallback;
  const readiness = browser.readiness && typeof browser.readiness === "object" ? browser.readiness : null;
  return String(readiness?.status || browser.launchError || browser.status || browser.state || fallback).trim() || fallback;
}

export function desktopAttemptId(request: any, input: Record<string, unknown> = {}) {
  return desktopWarningAttemptId({ attemptId: input.attemptId || request?.orkestrRequestId || request?.headers?.["x-request-id"] });
}

export async function desktopStoppedLeaseRecoveryOptions({ slug, threadId, principal, env = process.env }: any) {
  const payload = await listBrowserSessions(env, { principal, threadId, publicProjection: true }).catch(() => null);
  const desktop = (payload?.sessions || []).find((session: any) => String(session?.slug || session?.id || "").trim().toLowerCase() === String(slug || "").trim().toLowerCase());
  const desktopState = stoppedDesktopLeaseRecoveryState(desktop?.status || desktop?.state);
  return {
    allowStoppedLeaseRecovery: Boolean(desktopState),
    desktopState,
  };
}

export async function desktopOperationWarnings({ slug, threadId, ownerUserId, operation, attemptId, principal, breakGlassOptions = {}, decision = null, errorCode = "", env = process.env }: any) {
  const [lease, accessDecision] = await Promise.all([
    activeDesktopLeaseStatus(slug, env, { principal, ownerUserId }).catch(() => null),
    decision ? Promise.resolve(decision) : authorizeDesktopAccess({
      principal,
      threadId,
      desktopSlug: slug,
      ownerUserId,
      permission: operation === "share" ? "share" : operation === "acquire" ? "acquire" : "operate",
      ...breakGlassOptions,
    }, env).catch(() => null),
  ]);
  return desktopAccessWarnings({ desktopSlug: slug, threadId, operation, attemptId, lease, decision: accessDecision, errorCode });
}
