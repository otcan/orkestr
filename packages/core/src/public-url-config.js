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

function identityHostFromValue(value = "", kind = "url") {
  const text = clean(value);
  if (!text) return "";
  if (kind === "host") return hostFromValue(text);
  if (kind === "cookie") return cookieDomain(text);
  return hostnameFromUrl(normalizeUrl(text));
}

function fallbackIdentityRoot(host = "") {
  const normalized = hostFromValue(host);
  if (!normalized || normalized === "localhost" || /^[0-9.:]+$/.test(normalized)) return "";
  const parts = normalized.split(".").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return parts.slice(-2).join(".");
}

function identityRootForHost(host = "", primaryDomain = "") {
  const normalized = hostFromValue(host);
  if (!normalized) return "";
  const primary = hostFromValue(primaryDomain);
  if (primary && (normalized === primary || normalized.endsWith(`.${primary}`))) return primary;
  return fallbackIdentityRoot(normalized);
}

function cookieDomain(value = "") {
  const domain = hostFromValue(value).replace(/^\.+/, "");
  if (!domain || domain === "localhost" || !domain.includes(".")) return "";
  return domain;
}

export function publicUrlConfig(env = process.env) {
  const primaryDomain = hostFromValue(env.ORKESTR_PRIMARY_DOMAIN || env.ORKESTR_DOMAIN || "");
  const explicitAppUrl = normalizeUrl(env.ORKESTR_PUBLIC_APP_URL || env.ORKESTR_PUBLIC_URL || env.ORKESTR_APP_URL || "");
  const legacyHttpsUrl = normalizeUrl(env.ORKESTR_PUBLIC_HTTPS_URL || env.ORKESTR_HTTPS_URL || env.ORKESTR_TAILSCALE_HTTPS_NAME || "");
  const appHost = hostFromValue(env.ORKESTR_APP_HOST || hostnameFromUrl(explicitAppUrl) || "");
  const inferredAppUrl = explicitAppUrl || (appHost ? httpsUrlFromHost(appHost) : "");
  const appUrl = inferredAppUrl || legacyHttpsUrl || (primaryDomain ? httpsUrlFromHost(primaryDomain) : "");
  const explicitAuthUrl = normalizeUrl(env.ORKESTR_PUBLIC_AUTH_URL || env.ORKESTR_AUTH_URL || "");
  const authHost = hostFromValue(env.ORKESTR_AUTH_HOST || hostnameFromUrl(explicitAuthUrl) || "");
  const authUrl = explicitAuthUrl ||
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

const identityConfigInputs = [
  ["ORKESTR_PRIMARY_DOMAIN", "host"],
  ["ORKESTR_DOMAIN", "host"],
  ["ORKESTR_APP_HOST", "host"],
  ["ORKESTR_AUTH_HOST", "host"],
  ["ORKESTR_PUBLIC_URL", "url"],
  ["ORKESTR_PUBLIC_APP_URL", "url"],
  ["ORKESTR_PUBLIC_AUTH_URL", "url"],
  ["ORKESTR_AUTH_URL", "url"],
  ["ORKESTR_APP_URL", "url"],
  ["ORKESTR_PUBLIC_HTTPS_URL", "url"],
  ["ORKESTR_HTTPS_URL", "url"],
  ["ORKESTR_TAILSCALE_HTTPS_NAME", "url"],
  ["ORKESTR_CONNECT_PUBLIC_URL", "url"],
  ["ORKESTR_PAIRING_URL", "url"],
  ["ORKESTR_COOKIE_DOMAIN", "cookie"],
];

export const publicUrlIdentityConfigInputs = identityConfigInputs.map(([name, kind]) => ({ name, kind }));
export const publicUrlIdentityConfigNames = identityConfigInputs.map(([name]) => name);

export function publicUrlIdentityRecords(env = process.env, { source = "" } = {}) {
  const urls = publicUrlConfig(env);
  const primaryDomain = urls.primaryDomain || hostFromValue(env.ORKESTR_PRIMARY_DOMAIN || env.ORKESTR_DOMAIN || "");
  const records = [];
  for (const [name, kind] of identityConfigInputs) {
    const value = clean(env[name] || "");
    if (!value) continue;
    const host = identityHostFromValue(value, kind);
    if (!host) continue;
    const root = identityRootForHost(host, primaryDomain);
    if (!root) continue;
    records.push({ name, value, host, root, ...(source ? { source } : {}) });
  }
  return records;
}

export function publicUrlIdentityDiagnostics(env = process.env) {
  const urls = publicUrlConfig(env);
  const primaryDomain = urls.primaryDomain || hostFromValue(env.ORKESTR_PRIMARY_DOMAIN || env.ORKESTR_DOMAIN || "");
  const records = publicUrlIdentityRecords(env);
  const roots = [...new Set(records.map((record) => record.root).filter(Boolean))].sort();
  const grouped = roots.map((root) => ({
    root,
    variables: records
      .filter((record) => record.root === root)
      .map((record) => record.name)
      .sort(),
  }));
  const ok = roots.length <= 1;
  return {
    ok,
    status: ok ? "ok" : "warning",
    primaryDomain,
    active: {
      appUrl: urls.appUrl,
      authUrl: urls.authUrl,
      connectUrl: urls.connectUrl,
      cookieDomain: urls.cookieDomain,
    },
    roots: grouped,
    records,
    summary: ok
      ? "Public URL configuration uses one URL identity."
      : `Public URL configuration mixes ${roots.join(", ")} in one service environment.`,
  };
}
