import { redactDesktopSession } from "../../../../../packages/browsers/src/browsers.js";
import { activateOidcDesktopSession } from "../../../../../packages/core/src/oidc-desktop-session.js";

export async function oidcDesktopOpenResponse({
  request,
  response,
  share,
  principal,
  attemptId,
  warnings,
  browser,
  startRequested,
  startError,
}: Record<string, any>) {
  const activated = await activateOidcDesktopSession({
    shareResult: share,
    principal,
    securitySession: request?.orkestrSecuritySession,
    request,
    env: process.env,
  });
  response.setHeader("set-cookie", activated.cookie.header);
  return {
    ok: true,
    share: activated.share,
    url: activated.desktopUrl,
    authenticatedOpen: true,
    challengeRequired: false,
    attemptId,
    warnings,
    browser: redactDesktopSession(browser),
    desktopStart: {
      requested: startRequested,
      ok: Boolean(browser),
      error: startError,
    },
  };
}
