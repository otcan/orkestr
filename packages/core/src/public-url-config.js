function clean(value = "") {
  return String(value || "").trim();
}

function trimTrailingSlash(value = "") {
  return clean(value).replace(/\/+$/, "");
}

function hostFromValue(value = "") {
  const text = clean(value).replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/^\.+/, "").replace(/\.+$/, "");
  return /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(text) ? text.toLowerCase() : "";
}

function httpsUrlFromHost(host = "") {
  const normalized = hostFromValue(host);
  return normalized ? `https://${normalized}` : "";
}

function normalizeUrl(value = "") {
  const text = trimTrailingSlash(value);
  if (!text) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    if (!parsed.hostname) return "";
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function hostnameFromUrl(value = "") {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function cookieDomain(value = "") {
  const domain = hostFromValue(value).replace(/^\.+/, "");
  if (!domain || domain === "localhost" || !domain.includes(".")) return "";
  return domain;
}

export function publicUrlConfig(env = process.env) {
  const primaryDomain = hostFromValue(env.ORKESTR_PRIMARY_DOMAIN || env.ORKESTR_DOMAIN || "");
  const explicitAppUrl = normalizeUrl(env.ORKESTR_PUBLIC_URL || env.ORKESTR_APP_URL || "");
  const legacyHttpsUrl = normalizeUrl(env.ORKESTR_PUBLIC_HTTPS_URL || env.ORKESTR_HTTPS_URL || env.ORKESTR_TAILSCALE_HTTPS_NAME || "");
  const appHost = hostFromValue(env.ORKESTR_APP_HOST || hostnameFromUrl(explicitAppUrl) || "");
  const inferredAppUrl = explicitAppUrl || (appHost ? httpsUrlFromHost(appHost) : "");
  const appUrl = inferredAppUrl || legacyHttpsUrl || (primaryDomain ? httpsUrlFromHost(primaryDomain) : "");
  const authHost = hostFromValue(env.ORKESTR_AUTH_HOST || hostnameFromUrl(env.ORKESTR_AUTH_URL || "") || "");
  const authUrl = normalizeUrl(env.ORKESTR_AUTH_URL || "") ||
    (authHost ? httpsUrlFromHost(authHost) : "") ||
    appUrl;
  const connectUrl = normalizeUrl(env.ORKESTR_CONNECT_PUBLIC_URL || "");
  const appUrlHost = hostnameFromUrl(appUrl);
  const authUrlHost = hostnameFromUrl(authUrl);
  const configuredCookieDomain =
    cookieDomain(env.ORKESTR_COOKIE_DOMAIN || "") ||
    (primaryDomain && appUrlHost && authUrlHost && appUrlHost !== authUrlHost ? primaryDomain : "");

  return {
    primaryDomain,
    appHost: appUrlHost || appHost,
    authHost: authUrlHost || authHost,
    appUrl,
    authUrl,
    connectUrl,
    cookieDomain: configuredCookieDomain,
    sameOriginAuth: Boolean(appUrl && authUrl && appUrl === authUrl),
  };
}
