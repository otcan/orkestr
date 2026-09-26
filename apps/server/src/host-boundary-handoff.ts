// Host-boundary handoff paths: public browser handoffs that may be served on
// the connect/auth origin. OAuth handoffs are enumerated by exact path and
// method; there is no blanket /oauth/ or /google-marketing/oauth/ allowance
// (ORK-512).
export const oauthHandoffRoutes: Record<string, string[]> = {
  "/oauth/gmail/callback": ["GET"],
  "/oauth/gmail/start": ["GET", "POST"],
  "/google-marketing/oauth/callback": ["GET"],
  "/google-marketing/oauth/start": ["GET", "POST"],
};

export function handoffPath(rawUrl = "", method = "GET"): boolean {
  const pathname = new URL(rawUrl || "/", "http://orkestr.local").pathname;
  if (pathname.startsWith("/oauth/") || pathname.startsWith("/google-marketing/oauth/")) {
    return (oauthHandoffRoutes[pathname] || []).includes(String(method || "GET").trim().toUpperCase());
  }
  return pathname === "/setup" || pathname.startsWith("/setup/") ||
    pathname.startsWith("/connect/") ||
    pathname === "/review/google" || pathname.startsWith("/review/google/");
}
