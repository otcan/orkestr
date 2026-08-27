import { commercialHomePage } from "./public-site-home.js";
import { deploymentPage, developersPage, securityPage, useCasesPage } from "./public-site-content.js";
import {
  publicCanonicalUrl,
  publicPairingUrl,
  publicSiteAllowedForHost,
  publicSiteBaseUrl,
  publicSiteHost,
  publicSitePath,
  type PublicPageId,
} from "./public-site-config.js";
import { legalPage } from "./public-site-legal.js";
import { renderPublicShell } from "./public-site-shell.js";
import { renderCommercialSiteCss } from "./public-site-style.js";
import { workflowBookingPage } from "./public-workflow-booking.js";

export { publicPairingUrl, publicSiteAllowedForHost, publicSiteBaseUrl, publicSiteHost, publicSitePath };

function publicPage(pageId: PublicPageId, env = process.env) {
  if (pageId === "home") return commercialHomePage(env);
  if (pageId === "security") return securityPage(env);
  if (pageId === "deployment") return deploymentPage(env);
  if (pageId === "developers") return developersPage(env);
  if (pageId === "use-cases") return useCasesPage();
  if (pageId === "workflow") return workflowBookingPage(env);
  return legalPage(pageId, env);
}

export function renderPublicSite(requestUrl = "/", env = process.env, options: { host?: string } = {}) {
  if (!publicSiteAllowedForHost(options.host || "", env)) return "";
  const url = new URL(requestUrl || "/", "http://localhost");
  const pageId = publicSitePath(url.pathname);
  if (!pageId) return "";
  return renderPublicShell(publicPage(pageId, env), env);
}

export function renderPublicSiteCss() {
  return renderCommercialSiteCss();
}

export function renderPublicSitemap(env = process.env) {
  const paths = ["/", "/use-cases", "/security", "/deployment", "/developers", "/workflow", "/beta", "/privacy", "/terms", "/acceptable-use", "/data-deletion", "/support"];
  const urls = paths.map((path) => publicCanonicalUrl(path, env)).filter(Boolean);
  if (!urls.length) return "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${url.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</loc></url>`).join("\n")}\n</urlset>\n`;
}
