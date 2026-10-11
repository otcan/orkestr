import { renderOAuthHomepage } from "./oauth-homepage.js";
import { projectIntakePage } from "./public-project-intake.js";
import {
  publicPairingUrl,
  publicSiteAllowedForHost,
  publicSiteBaseUrl,
  publicSiteHost,
  publicSitePath,
  publicSiteRoute,
  type PublicLocale,
  type PublicPageId,
} from "./public-site-config.js";
import { legalPage } from "./public-site-legal.js";
import { renderPublicShell } from "./public-site-shell.js";
import { renderCommercialSiteCss } from "./public-site-style.js";
import { workflowIntakePage } from "./public-workflow-intake.js";
import { localizedProjectIntakePage } from "./public-project-intake-localized.js";

export { publicPairingUrl, publicSiteAllowedForHost, publicSiteBaseUrl, publicSiteHost, publicSitePath, publicSiteRoute };

// The marketing pages live in a separate static site. On the configured public
// host the app only serves what must stay with the running service: legal and
// support pages, the OAuth homepage, and the lead-form pages that post to
// /api/public/*.
const appServedPages = new Set<PublicPageId>(["project", "workflow", "beta", "terms", "privacy", "impressum", "acceptable-use", "data-deletion", "support"]);

function appServedRoute(pathname = "") {
  const route = publicSiteRoute(pathname);
  return route && appServedPages.has(route.pageId) ? route : null;
}

function publicPage(pageId: PublicPageId, env = process.env, locale: PublicLocale = "en") {
  if (pageId === "project") return locale === "en" ? projectIntakePage(env) : localizedProjectIntakePage(locale, env);
  if (pageId === "workflow") return workflowIntakePage();
  return legalPage(pageId, env);
}

export function renderPublicSite(requestUrl = "/", env = process.env, options: { host?: string } = {}) {
  if (!publicSiteAllowedForHost(options.host || "", env)) return "";
  const url = new URL(requestUrl || "/", "http://localhost");
  // Without the static site in front, the public host's root is the OAuth
  // homepage: it names the app and links to privacy, terms and support.
  if (url.pathname === "/" || url.pathname === "/about") return renderOAuthHomepage(env);
  const route = appServedRoute(url.pathname);
  if (!route) return "";
  return renderPublicShell(publicPage(route.pageId, env, route.locale), env);
}

export function publicSiteKnownPath(pathname = "") {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/about" || Boolean(appServedRoute(path));
}

export function renderPublicSiteCss() {
  return renderCommercialSiteCss();
}
