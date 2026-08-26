import { renderOAuthHomepage } from "./oauth-homepage.js";
import {
  publicSiteAllowedForHost,
  renderPublicSite,
  renderPublicSiteCss,
  renderPublicSitemap,
} from "./public-site.js";

function requestHostHeader(request: any) {
  return String(request?.headers?.["x-forwarded-host"] || request?.headers?.host || "").trim();
}

export function maybeServePublicSite(request: any, response: any, url: string, env = process.env) {
  const host = requestHostHeader(request);
  const allowed = publicSiteAllowedForHost(host, env);
  const publicPath = new URL(url || "/", "http://localhost").pathname;

  if (publicPath === "/waitlist" && allowed) {
    response.status(302).header("cache-control", "public, max-age=300").header("location", "/beta#waitlist").send("Personal beta moved to /beta.");
    return true;
  }
  if (publicPath === "/about" && allowed) {
    response.status(200).header("cache-control", "no-store").type("text/html; charset=utf-8").send(renderOAuthHomepage(env));
    return true;
  }
  if (publicPath === "/public-site.css" && allowed) {
    response.status(200).header("cache-control", "public, max-age=300").type("text/css; charset=utf-8").send(renderPublicSiteCss());
    return true;
  }
  if (publicPath === "/robots.txt" && allowed) {
    const sitemap = renderPublicSitemap(env)
      ? `\nSitemap: ${new URL("/sitemap.xml", env.ORKESTR_PUBLIC_SITE_URL || env.ORKESTR_PRIMARY_PUBLIC_URL || "http://localhost")}\n`
      : "";
    response.status(200).header("cache-control", "public, max-age=300").type("text/plain; charset=utf-8").send(`User-agent: *\nAllow: /\n${sitemap}`);
    return true;
  }
  if (publicPath === "/sitemap.xml" && allowed) {
    const sitemap = renderPublicSitemap(env);
    if (!sitemap) return false;
    response.status(200).header("cache-control", "public, max-age=300").type("application/xml; charset=utf-8").send(sitemap);
    return true;
  }

  const page = renderPublicSite(url, env, { host });
  if (!page) return false;
  response.status(200).header("cache-control", "no-store").type("text/html; charset=utf-8").send(page);
  return true;
}
