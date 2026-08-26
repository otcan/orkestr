import { publicAppsEnabled, resolvePublicAppForSession } from "../../../packages/core/src/public-apps.js";
import { keycloakOidcEnabled } from "../../../packages/core/src/keycloak-oidc.js";

function routeFromRequest(request: any): { slug: string; suffix: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(String(request?.originalUrl || request?.url || "/"), "http://orkestr.local");
  } catch {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] !== "apps") return null;
  if (!parts[1]) return { slug: "", suffix: "/" };
  try {
    return {
      slug: decodeURIComponent(parts[1]),
      suffix: `/${parts.slice(2).map((part) => encodeURIComponent(decodeURIComponent(part))).join("/")}`,
    };
  } catch {
    return null;
  }
}

export async function preflightPublicAppRequest(request: any): Promise<{ matched: boolean; ok: boolean; loginPath?: string }> {
  const route = routeFromRequest(request);
  if (!route) return { matched: false, ok: true };
  if (!publicAppsEnabled(process.env) || !keycloakOidcEnabled(process.env)) return { matched: true, ok: false };
  const session = request?.orkestrSecuritySession || null;
  if (!session?.id) {
    const rawUrl = String(request?.originalUrl || request?.url || "/");
    return { matched: true, ok: true, loginPath: `/auth/login?${new URLSearchParams({ return: rawUrl }).toString()}` };
  }
  if (session.authProvider !== "oidc") return { matched: true, ok: false };
  if (!route.slug) {
    request.orkestrPublicApp = { launcher: true };
    return { matched: true, ok: true };
  }
  try {
    const resolved = await resolvePublicAppForSession(route.slug, {
      principal: request?.orkestrPrincipal || null,
      session,
    });
    request.orkestrPublicApp = {
      appId: resolved.app.id,
      slug: resolved.app.slug,
      role: resolved.role,
      suffix: route.suffix,
    };
    return { matched: true, ok: true };
  } catch {
    return { matched: true, ok: false };
  }
}
