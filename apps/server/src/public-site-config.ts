export type PublicPageId =
  | "home"
  | "team"
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

export type PublicLocale = "en" | "de" | "tr";

export type PublicSiteRoute = {
  pageId: PublicPageId;
  locale: PublicLocale;
};

export type PublicPage = {
  id: PublicPageId;
  title: string;
  summary: string;
  body: string;
  canonicalPath?: string;
  locale?: PublicLocale;
  indexable?: boolean;
};

export const publicLocales: PublicLocale[] = ["en", "de", "tr"];

export const publicLocaleTags: Record<PublicLocale, string> = {
  en: "en",
  de: "de-DE",
  tr: "tr-TR",
};

export const publicLocaleOpenGraphTags: Record<PublicLocale, string> = {
  en: "en_US",
  de: "de_DE",
  tr: "tr_TR",
};

const localizedPagePaths: Record<PublicLocale, Partial<Record<PublicPageId, string>>> = {
  en: {
    home: "/",
    team: "/team",
    security: "/security",
    deployment: "/deployment",
    developers: "/developers",
    "use-cases": "/use-cases",
    project: "/project",
    "websites-commerce": "/websites-commerce",
    "business-systems": "/business-systems",
    "opportunity-intelligence": "/opportunity-intelligence",
    "web-data-monitoring": "/web-data-monitoring",
    automation: "/automation",
    workflow: "/workflow",
    terms: "/terms",
    privacy: "/privacy",
    impressum: "/impressum",
    "acceptable-use": "/acceptable-use",
    "data-deletion": "/data-deletion",
    support: "/support",
    beta: "/beta",
  },
  de: {
    home: "/de",
    team: "/de/team",
    "use-cases": "/de/leistungen",
    "websites-commerce": "/de/websites-onlineshops",
    "business-systems": "/de/altsystem-modernisieren",
    "opportunity-intelligence": "/de/ausschreibungsmonitoring",
    "web-data-monitoring": "/de/web-monitoring",
    automation: "/de/ki-prozessautomatisierung",
    project: "/de/projekt",
    security: "/de/sicherheit",
    deployment: "/de/betrieb",
  },
  tr: {
    home: "/tr",
    team: "/tr/ekip",
    "use-cases": "/tr/hizmetler",
    "websites-commerce": "/tr/web-sitesi-e-ticaret",
    "business-systems": "/tr/eski-sistem-modernizasyonu",
    "opportunity-intelligence": "/tr/ihale-firsat-takibi",
    "web-data-monitoring": "/tr/web-veri-izleme",
    automation: "/tr/yapay-zeka-is-akisi-otomasyonu",
    project: "/tr/proje",
    security: "/tr/guvenlik",
    deployment: "/tr/devreye-alma",
  },
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

export function publicProjectSchedulingUrl(env = process.env) {
  return normalizePublicUrl(env.ORKESTR_PROJECT_DISCOVERY_SCHEDULING_URL || "");
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

export function publicPagePath(pageId: PublicPageId, locale: PublicLocale = "en") {
  return localizedPagePaths[locale]?.[pageId] || "";
}

export function publicSiteRoute(pathname = ""): PublicSiteRoute | null {
  const path = clean(pathname || "/").replace(/\/+$/, "") || "/";
  if (path === "/public") return { pageId: "home", locale: "en" };
  for (const locale of publicLocales) {
    for (const [pageId, routePath] of Object.entries(localizedPagePaths[locale])) {
      if (path === routePath) return { pageId: pageId as PublicPageId, locale };
    }
  }
  return null;
}

export function publicSitePath(pathname = ""): PublicPageId | "" {
  return publicSiteRoute(pathname)?.pageId || "";
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
