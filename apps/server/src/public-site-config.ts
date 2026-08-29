export type PublicPageId =
  | "home"
  | "security"
  | "deployment"
  | "developers"
  | "use-cases"
  | "project"
  | "websites-commerce"
  | "business-systems"
  | "opportunity-intelligence"
  | "web-data-monitoring"
  | "automation"
  | "workflow"
  | "terms"
  | "privacy"
  | "impressum"
  | "acceptable-use"
  | "data-deletion"
  | "support"
  | "beta";

export type PublicPage = {
  id: PublicPageId;
  title: string;
  summary: string;
  body: string;
  canonicalPath?: string;
};

const defaultRepoUrl = "https://github.com/otcan/orkestr";

export function clean(value = "") {
  return String(value || "").trim();
}

export function escapeHtml(value = "") {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function normalizePublicUrl(value = "") {
  const text = clean(value).replace(/\/+$/, "");
  if (!text) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return "";
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function hostFromValue(value = "") {
  const text = clean(value).replace(/^https?:\/\//i, "").replace(/\/.*/, "").replace(/:\d+$/, "").replace(/^\.+/, "").replace(/\.+$/, "");
  return /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(text) ? text.toLowerCase() : "";
}

function requestHost(value = "") {
  return hostFromValue(clean(value).split(",")[0] || "");
}

export function publicRepoUrl(env = process.env) {
  return clean(env.ORKESTR_PUBLIC_REPO_URL || env.ORKESTR_REPO_URL || defaultRepoUrl);
}

export function publicContact(env = process.env) {
  return clean(env.ORKESTR_PUBLIC_CONTACT || env.ORKESTR_SUPPORT_EMAIL || "Contact the operator of this deployment.");
}

export function publicContactEmail(env = process.env) {
  const contact = publicContact(env);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) ? contact : "";
}

export function publicSchedulingUrl(env = process.env) {
  return normalizePublicUrl(env.ORKESTR_WORKFLOW_PILOT_SCHEDULING_URL || "");
}

export function publicSiteBaseUrl(env = process.env) {
  const configured = normalizePublicUrl(env.ORKESTR_PUBLIC_SITE_URL || env.ORKESTR_PRIMARY_PUBLIC_URL || "");
  if (configured) return configured;
  const primary = hostFromValue(env.ORKESTR_PRIMARY_DOMAIN || env.ORKESTR_DOMAIN || "");
  return primary ? `https://${primary}` : "";
}

export function publicAppUrl(env = process.env) {
  const configured = normalizePublicUrl(env.ORKESTR_PUBLIC_APP_URL || env.ORKESTR_APP_URL || "");
  if (configured) return configured;
  const host = hostFromValue(env.ORKESTR_APP_HOST || "");
  if (host) return `https://${host}`;
  const site = publicSiteBaseUrl(env);
  return site ? new URL("/app", site).toString() : "/app";
}

export function publicConnectUrl(env = process.env) {
  const configured = normalizePublicUrl(env.ORKESTR_CONNECT_PUBLIC_URL || env.ORKESTR_PUBLIC_AUTH_URL || env.ORKESTR_AUTH_ENTRY_URL || "");
  if (configured) return configured;
  const host = hostFromValue(env.ORKESTR_AUTH_HOST || "");
  return host ? `https://${host}` : publicSiteBaseUrl(env);
}

export function publicSiteHost(env = process.env) {
  return requestHost(publicSiteBaseUrl(env));
}

export function publicSiteAllowedForHost(hostHeader = "", env = process.env) {
  const expected = publicSiteHost(env);
  if (!expected) return true;
  const actual = requestHost(hostHeader);
  if (!actual) return true;
  return actual === expected || actual === `www.${expected}` || (expected.startsWith("www.") && actual === expected.slice(4));
}

export function publicPairingUrl(env = process.env) {
  const configured = normalizePublicUrl(env.ORKESTR_PUBLIC_AUTH_URL || env.ORKESTR_AUTH_ENTRY_URL || env.ORKESTR_PAIRING_URL || "");
  const base = configured || publicConnectUrl(env) || publicSiteBaseUrl(env);
  if (!base) return "";
  try {
    return new URL("/setup/pairing", base).toString();
  } catch {
    return "";
  }
}

export function publicSitePath(pathname = ""): PublicPageId | "" {
  const path = clean(pathname || "/").replace(/\/+$/, "") || "/";
  const routes: Record<string, PublicPageId> = {
    "/": "home",
    "/public": "home",
    "/security": "security",
    "/deployment": "deployment",
    "/developers": "developers",
    "/use-cases": "use-cases",
    "/project": "project",
    "/websites-commerce": "websites-commerce",
    "/business-systems": "business-systems",
    "/opportunity-intelligence": "opportunity-intelligence",
    "/web-data-monitoring": "web-data-monitoring",
    "/automation": "automation",
    "/workflow": "workflow",
    "/terms": "terms",
    "/privacy": "privacy",
    "/impressum": "impressum",
    "/acceptable-use": "acceptable-use",
    "/data-deletion": "data-deletion",
    "/support": "support",
    "/beta": "beta",
  };
  return routes[path] || "";
}

export function publicCanonicalUrl(pathname: string, env = process.env) {
  const base = publicSiteBaseUrl(env);
  if (!base) return "";
  try {
    return new URL(pathname || "/", `${base}/`).toString();
  } catch {
    return "";
  }
}
