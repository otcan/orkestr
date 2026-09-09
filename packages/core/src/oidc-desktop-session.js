import { isAdminPrincipal } from "./policy.js";
import {
  approveDesktopShareChallenge,
  desktopShareCookieHeader,
  openDesktopShare,
} from "./desktop-shares.js";
import { normalizeUserId } from "./users.js";

function desktopSessionError(message, statusCode = 403) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/** @param {any} principal @param {any} securitySession */
export function assertOidcDesktopSession(principal = null, securitySession = null) {
  const principalUserId = String(principal?.userId || "").trim();
  const sessionUserId = String(securitySession?.userId || "").trim();
  if (
    securitySession?.authProvider !== "oidc" ||
    !String(securitySession?.id || "").trim() ||
    principal?.source !== "oidc-session" ||
    String(principal?.sessionId || "").trim() !== String(securitySession.id).trim() ||
    !principalUserId ||
    !sessionUserId ||
    normalizeUserId(principalUserId) !== normalizeUserId(sessionUserId)
  ) throw desktopSessionError("oidc_desktop_session_required", 401);
  return principal;
}

/**
 * @param {{
 *   shareResult?: any,
 *   principal?: any,
 *   securitySession?: any,
 *   request?: any,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 * }} [input]
 */
export async function activateOidcDesktopSession({
  shareResult = null,
  principal = null,
  securitySession = null,
  request = null,
  env = process.env,
} = {}) {
  const oidcPrincipal = assertOidcDesktopSession(principal, securitySession);
  const shareId = String(shareResult?.share?.id || "").trim();
  const desktopSlug = String(shareResult?.share?.desktopSlug || "").trim();
  const ownerUserId = String(shareResult?.share?.ownerUserId || "").trim();
  const key = String(shareResult?.key || "").trim();
  if (!shareId || !desktopSlug || !ownerUserId || !key) {
    throw desktopSessionError("desktop_session_share_invalid", 500);
  }
  if (!isAdminPrincipal(oidcPrincipal) && normalizeUserId(ownerUserId) !== normalizeUserId(oidcPrincipal.userId)) {
    throw desktopSessionError("desktop_session_owner_mismatch", 403);
  }

  const opened = await openDesktopShare({
    shareId,
    key,
    subdomain: shareResult.subdomain,
    request,
    env,
  });
  const challenge = String(opened?.attempt?.challenge || "").trim();
  if (!challenge || !String(opened?.cookie?.value || "").trim()) {
    throw desktopSessionError("desktop_session_activation_failed", 500);
  }
  const approved = await approveDesktopShareChallenge(challenge, {
    approvedBy: `oidc-session:${String(securitySession.id).trim()}`,
    env,
  });
  if (String(approved?.share?.id || "") !== shareId || String(approved?.attempt?.id || "") !== String(opened.attempt.id || "")) {
    throw desktopSessionError("desktop_session_activation_mismatch", 409);
  }
  return {
    ok: true,
    share: approved.share,
    attempt: approved.attempt,
    desktopUrl: approved.desktopUrl,
    cookie: {
      value: opened.cookie.value,
      header: desktopShareCookieHeader(opened.cookie.value, env, null, {
        path: `/desktop/${encodeURIComponent(desktopSlug)}/`,
      }),
    },
  };
}
