import { activeDesktopLeaseStatus } from "../../../../../packages/browsers/src/desktop-leases.js";
import { desktopAccessWarnings, desktopWarningAttemptId } from "../../../../../packages/browsers/src/desktop-access-warnings.js";
import { authorizeDesktopAccess } from "../../../../../packages/core/src/desktop-access.js";
import { emitDesktopAccessChatWarning } from "../../../../../packages/core/src/desktop-access-chat-warning.js";

export { emitDesktopAccessChatWarning };

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
