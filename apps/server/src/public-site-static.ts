import { publicSiteAllowedForHost, publicSiteKnownPath, renderPublicSite, renderPublicSiteCss } from "./public-site.js";

function requestHostHeader(request: any) {
  return String(request?.headers?.["x-forwarded-host"] || request?.headers?.host || "").trim();
}

export function maybeServePublicSite(request: any, response: any, url: string, env = process.env) {
  const host = requestHostHeader(request);
  if (!publicSiteAllowedForHost(host, env)) return false;
  const publicPath = new URL(url || "/", "http://localhost").pathname;

  if (publicPath.length > 1 && publicPath.endsWith("/") && publicSiteKnownPath(publicPath)) {
    const parsed = new URL(url || "/", "http://localhost");
    const canonicalPath = publicPath.replace(/\/+$/, "") || "/";
    response.status(301).header("cache-control", "public, max-age=3600").header("location", `${canonicalPath}${parsed.search}`).send("Redirecting to the canonical URL.");
    return true;
  }
  if (publicPath === "/waitlist") {
    response.status(302).header("cache-control", "public, max-age=300").header("location", "/beta#waitlist").send("Personal beta moved to /beta.");
    return true;
  }
  if (publicPath === "/public-site.css") {
    response.status(200).header("cache-control", "public, max-age=300").type("text/css; charset=utf-8").send(renderPublicSiteCss());
    return true;
  }
  if (publicPath === "/robots.txt") {
    response.status(200).header("cache-control", "public, max-age=300").type("text/plain; charset=utf-8").send("User-agent: *\nAllow: /\n");
    return true;
  }

  const page = renderPublicSite(url, env, { host });
  if (!page) return false;
  response.status(200).header("cache-control", "no-store").type("text/html; charset=utf-8").send(page);
  return true;
}
