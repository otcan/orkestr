import { studioPage } from "./public-site-home.js";
import { buildsIndexPage, freeIndexPage, umbrellaHomePage } from "./public-site-hub.js";
import { openSourcePage } from "./public-site-oss-placeholder.js";
import { publicCatalog, publicCatalogEntryForPath, publicCatalogEntryIsLive, publicCatalogPath } from "./public-site-catalog.js";
import { deploymentPage, developersPage, securityPage } from "./public-site-content.js";
import { projectIntakePage } from "./public-project-intake.js";
import { solutionPage, whatWeBuildPage } from "./public-site-solutions.js";
import {
  publicCanonicalUrl,
  publicPairingUrl,
  publicSiteAllowedForHost,
  publicSiteBaseUrl,
  publicSiteHost,
  publicSitePath,
  publicLocales,
  publicLocaleTags,
  publicPagePath,
  publicSiteRedirects,
  publicSiteRoute,
  type PublicLocale,
  type PublicPageId,
} from "./public-site-config.js";
import { legalPage } from "./public-site-legal.js";
import { renderPublicShell } from "./public-site-shell.js";
import { renderCommercialSiteCss } from "./public-site-style.js";
import { workflowIntakePage } from "./public-workflow-intake.js";
import { localizedStudioPage } from "./public-site-localized-home.js";
import { localizedSolutionPage, localizedWhatWeBuildPage } from "./public-site-localized-solutions.js";
import { localizedTrustPage, teamPage } from "./public-site-localized-trust.js";
import { localizedProjectIntakePage } from "./public-project-intake-localized.js";

export { publicPairingUrl, publicSiteAllowedForHost, publicSiteBaseUrl, publicSiteHost, publicSitePath, publicSiteRedirects, publicSiteRoute };

function publicPage(pageId: PublicPageId, env = process.env, locale: PublicLocale = "en") {
  if (locale !== "en") {
    if (pageId === "studio") return localizedStudioPage(locale);
    if (pageId === "use-cases") return localizedWhatWeBuildPage(locale);
    if (["websites-commerce", "business-systems", "opportunity-intelligence", "web-data-monitoring", "automation"].includes(pageId)) return localizedSolutionPage(pageId, locale);
    if (pageId === "project") return localizedProjectIntakePage(locale, env);
    if (pageId === "security" || pageId === "deployment") return localizedTrustPage(pageId, locale, env);
    if (pageId === "team") return teamPage(locale);
  }
  if (pageId === "home") return umbrellaHomePage();
  if (pageId === "builds") return buildsIndexPage();
  if (pageId === "free") return freeIndexPage();
  if (pageId === "open-source") return openSourcePage(env);
  if (pageId === "studio") return studioPage();
  if (pageId === "team") return teamPage();
  if (pageId === "security") return securityPage(env);
  if (pageId === "deployment") return deploymentPage(env);
  if (pageId === "developers") return developersPage(env);
  if (pageId === "use-cases") return whatWeBuildPage();
  if (pageId === "project") return projectIntakePage(env);
  if (["websites-commerce", "business-systems", "opportunity-intelligence", "web-data-monitoring", "automation"].includes(pageId)) return solutionPage(pageId);
  if (pageId === "workflow") return workflowIntakePage();
  return legalPage(pageId, env);
}

export function renderPublicSite(requestUrl = "/", env = process.env, options: { host?: string } = {}) {
  if (!publicSiteAllowedForHost(options.host || "", env)) return "";
  const url = new URL(requestUrl || "/", "http://localhost");
  const catalogEntry = publicCatalogEntryForPath(url.pathname);
  if (catalogEntry?.render) return renderPublicShell(catalogEntry.render(env), env);
  const route = publicSiteRoute(url.pathname);
  if (!route) return "";
  return renderPublicShell(publicPage(route.pageId, env, route.locale), env);
}

export function publicSiteKnownPath(pathname = "") {
  return Boolean(publicSitePath(pathname) || publicCatalogEntryForPath(pathname));
}

export function renderPublicSiteCss() {
  return renderCommercialSiteCss();
}

export function renderPublicSitemap(env = process.env) {
  const localizedIds: PublicPageId[] = ["studio", "use-cases", "websites-commerce", "business-systems", "automation", "web-data-monitoring", "opportunity-intelligence", "security", "deployment", "team"];
  const englishOnlyIds: PublicPageId[] = ["home", "builds", "free", "open-source", "developers", "workflow"];
  const lastmod = /^\d{4}-\d{2}-\d{2}$/.test(String(env.ORKESTR_PUBLIC_SITE_LASTMOD || "")) ? String(env.ORKESTR_PUBLIC_SITE_LASTMOD) : "2026-08-31";
  const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const entries: string[] = [];
  for (const pageId of localizedIds) {
    const alternates = publicLocales.map((locale) => {
      const path = publicPagePath(pageId, locale);
      const url = path ? publicCanonicalUrl(path, env) : "";
      return url ? { locale, url } : null;
    }).filter(Boolean) as Array<{ locale: PublicLocale; url: string }>;
    for (const current of alternates) {
      const links = alternates.map((item) => `<xhtml:link rel="alternate" hreflang="${publicLocaleTags[item.locale]}" href="${xml(item.url)}"/>`).join("");
      const fallback = alternates.find((item) => item.locale === "en");
      entries.push(`  <url><loc>${xml(current.url)}</loc><lastmod>${lastmod}</lastmod>${links}${fallback ? `<xhtml:link rel="alternate" hreflang="x-default" href="${xml(fallback.url)}"/>` : ""}</url>`);
    }
  }
  for (const pageId of englishOnlyIds) {
    const url = publicCanonicalUrl(publicPagePath(pageId, "en"), env);
    if (url) entries.push(`  <url><loc>${xml(url)}</loc><lastmod>${lastmod}</lastmod></url>`);
  }
  for (const entry of publicCatalog.filter(publicCatalogEntryIsLive)) {
    const url = publicCanonicalUrl(publicCatalogPath(entry), env);
    if (url) entries.push(`  <url><loc>${xml(url)}</loc><lastmod>${lastmod}</lastmod></url>`);
  }
  if (!entries.length) return "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join("\n")}\n</urlset>\n`;
}
