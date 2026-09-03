export const hushMobileRouteKind = "hush_mobile";

const hushVoiceRoutes = [
  { method: "POST", path: "/api/mobile/hush/voice/input", scopes: ["thread:input"] },
  { method: "GET", path: "/api/mobile/hush/voice/messages", scopes: ["thread:read"] },
  { method: "GET", path: "/api/mobile/hush/voice/status", scopes: ["thread:read"] },
];

function decodeRoutePart(value = "") {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function mobileRequestPathname(request = {}) {
  const raw = String(request?.originalUrl || request?.url || "/");
  let pathname = raw.split("?")[0] || "/";
  try {
    pathname = new URL(raw, "http://orkestr.local").pathname || "/";
  } catch {
    pathname = pathname.split("#")[0] || "/";
  }
  const parts = pathname.split("/").filter(Boolean).map(decodeRoutePart);
  if (parts[0] === "instance" && parts[1]) return `/${parts.slice(2).join("/")}`;
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

export function mobileRequestMethod(request = {}) {
  return String(request?.method || "GET").toUpperCase();
}

export function isMobileSessionRefreshRoute(request = {}) {
  return mobileRequestMethod(request) === "POST" && mobileRequestPathname(request) === "/api/mobile/session/refresh";
}

export function hushMobileVoiceRoute(request = {}) {
  const method = mobileRequestMethod(request);
  const path = mobileRequestPathname(request);
  return hushVoiceRoutes.find((route) => route.method === method && route.path === path) || null;
}

export function mobileDeviceMachineAuthContext({ session = {}, device = {}, claims = {}, route = null } = {}) {
  return {
    tokenId: session.accessTokenId || "",
    routeKind: hushMobileRouteKind,
    route: route?.path || "",
    scopes: Array.isArray(route?.scopes) ? route.scopes : [],
    principalKind: "mobile_device",
    principalId: device.id || "",
    ownerUserId: session.ownerUserId || "",
    userId: session.userId || "",
    threadId: session.threadId || "",
    deviceId: device.id || "",
    sessionId: session.id || "",
    profileId: session.profileId || "",
    proofJti: String(claims.jti || ""),
    proofIat: Number(claims.iat || 0),
  };
}
