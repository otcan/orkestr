const shareCookieName = "orkestr_desktop_share";

function publicHttpsBase(env = process.env) {
  return String(env.ORKESTR_PUBLIC_HTTPS_URL || env.ORKESTR_HTTPS_URL || env.ORKESTR_TAILSCALE_HTTPS_NAME || "").trim().replace(/\/+$/, "");
}

export function desktopShareBaseDomain(env = process.env) {
  return String(env.ORKESTR_DESKTOP_SHARE_BASE_DOMAIN || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "");
}

export function desktopShareSubdomainFromHost(host = "", env = process.env) {
  const domain = desktopShareBaseDomain(env);
  if (!domain) return "";
  const normalizedHost = String(host || "").trim().toLowerCase().split(":")[0];
  if (!normalizedHost.endsWith(`.${domain}`)) return "";
  return normalizedHost.slice(0, -domain.length - 1);
}

export function desktopShareUrl(share, key, env = process.env) {
  const template = String(env.ORKESTR_DESKTOP_SHARE_URL_TEMPLATE || "").trim();
  if (template) {
    return template
      .replaceAll("{subdomain}", encodeURIComponent(share.subdomain))
      .replaceAll("{shareId}", encodeURIComponent(share.id))
      .replaceAll("{id}", encodeURIComponent(share.id))
      .replaceAll("{key}", encodeURIComponent(key));
  }
  const domain = desktopShareBaseDomain(env);
  if (domain) return `https://${share.subdomain}.${domain}/desktop-share/${encodeURIComponent(share.id)}?key=${encodeURIComponent(key)}`;
  const base = publicHttpsBase(env) || `http://127.0.0.1:${String(env.ORKESTR_PORT || "19812").trim() || "19812"}`;
  return `${base}/desktop-share/${encodeURIComponent(share.subdomain)}/${encodeURIComponent(share.id)}?key=${encodeURIComponent(key)}`;
}

export function desktopShareCookieName() {
  return shareCookieName;
}

export function desktopShareCookieHeader(value, env = process.env, maxAgeMs = null) {
  const configuredTtlMs = Number(env.ORKESTR_DESKTOP_SHARE_ACCESS_TTL_MS || 30 * 60 * 1000);
  const effectiveTtlMs = maxAgeMs == null
    ? (Number.isFinite(configuredTtlMs) ? Math.max(60_000, configuredTtlMs) : 30 * 60 * 1000)
    : maxAgeMs;
  const secure = String(env.ORKESTR_COOKIE_SECURE || "").trim() === "1" || publicHttpsBase(env).startsWith("https://") || Boolean(desktopShareBaseDomain(env));
  return [
    `${shareCookieName}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(effectiveTtlMs / 1000)}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function cookieValue(header, name = shareCookieName) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("=") || "");
  }
  return "";
}

export function parseDesktopShareCookie(header) {
  const [shareId, token] = cookieValue(header).split(":");
  return { shareId: String(shareId || "").trim(), token: String(token || "").trim() };
}
