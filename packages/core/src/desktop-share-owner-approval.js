// One-click approval of a desktop share link by its signed-in owner. A share
// link normally waits until someone in the chat approves the browser's
// one-time challenge (`orkestr desktop approve <challenge>`). When the browser
// that opened the link carries the owner's own OIDC session, that session is
// the same proof the WebUI "Open" button relies on, so the attempt is approved
// directly instead of asking the owner to copy a challenge into chat.
import { isAdminPrincipal } from "./policy.js";
import { normalizeUserId } from "./users.js";
import { assertOidcDesktopSession } from "./oidc-desktop-session.js";
import { approveDesktopShareChallenge, desktopShareStatus } from "./desktop-shares.js";
import { desktopShareSha256 as sha256, readDesktopShareState } from "./desktop-share-store.js";

function approvalError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

// The checks owner approval rests on, approving nothing: a sign-in session
// (401 without one), a live link (key, subdomain, expiry, revocation and
// current desktop grant, as desktopShareStatus checks them) and that session
// belonging to the link's owner or an admin (403 otherwise).
export async function verifyDesktopShareOwnerSession({
  shareId = "", key = "", browserToken = "", subdomain = "",
  principal = null, securitySession = null, env = process.env,
} = {}) {
  const owner = assertOidcDesktopSession(principal, securitySession);
  const status = await desktopShareStatus({ shareId, key, browserToken, subdomain, env });
  if (!isAdminPrincipal(owner) && normalizeUserId(status.share?.ownerUserId) !== normalizeUserId(owner.userId)) {
    throw approvalError("desktop_share_owner_mismatch", 403);
  }
  return status;
}

export async function approveDesktopShareAsOwner({
  shareId = "", key = "", browserToken = "", subdomain = "",
  principal = null, securitySession = null, env = process.env,
} = {}) {
  // Also finds the attempt this browser opened.
  const status = await verifyDesktopShareOwnerSession({ shareId, key, browserToken, subdomain, principal, securitySession, env });
  if (!status.attempt) throw approvalError("desktop_share_attempt_required", 409);
  if (status.approved) return { ok: true, approved: true, desktopUrl: status.desktopUrl };
  const state = await readDesktopShareState(env);
  const share = state.desktopShares.find((item) => item.id === status.share.id);
  const attempt = share?.attempts.find((item) => item.id === status.attempt.id && item.tokenHash === sha256(String(browserToken || "").trim()));
  if (!attempt?.challenge) throw approvalError("desktop_share_attempt_required", 409);
  const approved = await approveDesktopShareChallenge(attempt.challenge, {
    approvedBy: `oidc-session:${String(securitySession.id).trim()}`,
    env,
  });
  return { ok: true, approved: true, desktopUrl: approved.desktopUrl };
}
