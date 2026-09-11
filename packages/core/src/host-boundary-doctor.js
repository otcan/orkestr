import { listEvents } from "../../storage/src/store.js";
import { canonicalAppGatewayEnabled, canonicalInstanceUrlsEnabled } from "./canonical-public-references.js";
import { canonicalAppLinksEnabled, explicitCanonicalAppBase } from "./canonical-app-links.js";
import { readInstanceIdentity } from "./instance-identity.js";
import { publicUrlConfig } from "./public-url-config.js";
import { listThreads } from "./threads.js";

function clean(value = "") {
  return String(value || "").trim();
}

function enabled(value = "") {
  return ["1", "true", "yes", "on", "enabled"].includes(clean(value).toLowerCase());
}

function base(value = "") {
  try {
    const parsed = new URL(clean(value));
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname ? parsed.origin : "";
  } catch {
    return "";
  }
}

function check(id, label, status, summary, repair = "", detail = {}) {
  return { id, label, status, summary, repair, ...detail };
}

function ambiguousLegacySelectorCount(threads = []) {
  const selectors = new Map();
  for (const thread of threads) {
    for (const value of [thread.id, thread.name, thread.bindingName]) {
      const selector = clean(value);
      if (!selector) continue;
      const ids = selectors.get(selector) || new Set();
      ids.add(clean(thread.id));
      selectors.set(selector, ids);
    }
  }
  return [...selectors.values()].filter((ids) => ids.size > 1).length;
}

export async function hostBoundaryDoctorChecks(env = process.env) {
  const featureEnabled = enabled(env.ORKESTR_HOST_BOUNDARIES);
  if (!featureEnabled) {
    return [check(
      "host_boundaries",
      "Application/connect host boundaries",
      "ok",
      "Host boundaries are disabled; legacy routing remains unchanged.",
    )];
  }

  const appOrigin = explicitCanonicalAppBase(env) ? new URL(explicitCanonicalAppBase(env)).origin : "";
  const connectOrigin = base(env.ORKESTR_CONNECT_PUBLIC_URL || env.ORKESTR_CONNECT_PUBLIC_BASE_URL);
  const authOrigin = base(env.ORKESTR_PUBLIC_AUTH_URL || env.ORKESTR_AUTH_URL);
  const launcherOrigin = base(env.ORKESTR_PUBLIC_LAUNCHER_URL || env.ORKESTR_LAUNCHER_URL);
  const handoffOrigins = [...new Set([connectOrigin, authOrigin].filter(Boolean))];
  const checks = [];
  if (!appOrigin || !handoffOrigins.length) {
    checks.push(check(
      "host_boundary_config",
      "Application/connect host configuration",
      "error",
      "Host boundaries are enabled without both an explicit application origin and a connect/auth origin.",
      "Set ORKESTR_PUBLIC_APP_URL (or ORKESTR_APP_URL/ORKESTR_APP_HOST) and ORKESTR_CONNECT_PUBLIC_URL or ORKESTR_PUBLIC_AUTH_URL, then restart Orkestr.",
    ));
  } else if (handoffOrigins.includes(appOrigin)) {
    checks.push(check(
      "host_boundary_config",
      "Application/connect host configuration",
      "error",
      "Application and connect/auth responsibilities resolve to the same origin.",
      "Configure a dedicated application origin and a separate connect/auth origin.",
    ));
  } else {
    checks.push(check("host_boundary_config", "Application/connect host configuration", "ok", "Application and connect/auth origins are explicitly separated."));
  }

  const identity = await readInstanceIdentity(env).catch(() => null);
  const threads = await listThreads(env).catch(() => []);
  const missingThreadRefs = threads.filter((thread) => !thread.publicRef).length;
  const ready = canonicalInstanceUrlsEnabled(env) && canonicalAppGatewayEnabled(env) && canonicalAppLinksEnabled(env) &&
    Boolean(identity?.publicRef) && missingThreadRefs === 0;
  checks.push(ready
    ? check("canonical_route_readiness", "Canonical route readiness", "ok", "Canonical flags and persisted public references are ready for legacy redirects.")
    : check(
      "canonical_route_readiness",
      "Canonical route readiness",
      "error",
      "Canonical redirects are not ready because a required flag or public-reference migration is incomplete.",
      "Enable the canonical reference, gateway, and link flags only after running the canonical public-reference migration and verifying every thread has a public reference.",
      { missingThreadRefs, instancePublicRefPresent: Boolean(identity?.publicRef) },
    ));

  const trustProxy = enabled(env.ORKESTR_TRUST_PROXY_HEADERS || env.ORKESTR_TRUST_PROXY);
  const trustedIps = clean(env.ORKESTR_TRUSTED_PROXY_IPS);
  checks.push(trustProxy && !trustedIps
    ? check(
      "forwarded_host_trust",
      "Forwarded host trust",
      "warning",
      "Forwarded host/proto headers are enabled without an explicit trusted proxy IP list.",
      "Set ORKESTR_TRUSTED_PROXY_IPS to the exact reverse-proxy addresses, or disable forwarded-header trust.",
    )
    : check("forwarded_host_trust", "Forwarded host trust", "ok", trustProxy ? "Forwarded headers are restricted to configured proxy addresses." : "Forwarded headers are ignored."));

  const cookieDomain = clean(publicUrlConfig(env).cookieDomain).replace(/^\./, "").toLowerCase();
  const configuredHosts = [appOrigin, ...handoffOrigins, launcherOrigin]
    .filter(Boolean)
    .map((origin) => new URL(origin).hostname.toLowerCase());
  const cookieUnsafe = cookieDomain && configuredHosts.some((host) => host !== cookieDomain && !host.endsWith(`.${cookieDomain}`));
  const separatedHosts = new Set(configuredHosts).size > 1;
  checks.push(separatedHosts && !cookieDomain
    ? check(
      "host_boundary_cookie_scope",
      "Host-boundary cookie scope",
      "error",
      "Separated application/connect hosts do not have a shared cookie domain.",
      "Set ORKESTR_COOKIE_DOMAIN to a parent domain shared by every configured host, or configure ORKESTR_PRIMARY_DOMAIN so public URL configuration can infer it.",
    )
    : cookieUnsafe
    ? check(
      "host_boundary_cookie_scope",
      "Host-boundary cookie scope",
      "error",
      "The configured cookie domain does not contain every application/connect host.",
      "Use a cookie domain shared by the configured hosts or keep authentication flows same-origin.",
    )
    : check("host_boundary_cookie_scope", "Host-boundary cookie scope", "ok", "Cookie scope is compatible with the configured host boundary."));

  const ambiguousSelectors = ambiguousLegacySelectorCount(threads);
  checks.push(ambiguousSelectors
    ? check(
      "legacy_thread_route_ambiguity",
      "Legacy thread route ambiguity",
      "warning",
      `${ambiguousSelectors} ambiguous legacy thread selector(s) cannot be redirected safely.`,
      "Rename colliding legacy thread aliases or use canonical public-reference links. Do not weaken authorization or first-match routing.",
      { ambiguousSelectors },
    )
    : check("legacy_thread_route_ambiguity", "Legacy thread route ambiguity", "ok", "No ambiguous legacy thread selectors were found."));

  const recent = await listEvents(env, 500).catch(() => []);
  const wrongHostDenials = recent.filter((event) => event?.type === "host_boundary_denied" && event?.reason === "wrong_host").length;
  checks.push(wrongHostDenials
    ? check(
      "wrong_host_thread_traffic",
      "Wrong-host thread traffic",
      "warning",
      `${wrongHostDenials} recent request(s) reached a disallowed host boundary.`,
      "Check reverse-proxy host routing and update old bookmarks to canonical application links.",
      { recentCount: wrongHostDenials },
    )
    : check("wrong_host_thread_traffic", "Wrong-host thread traffic", "ok", "No recent wrong-host thread traffic was recorded."));

  return checks;
}

export async function hostBoundaryRouterIssues(env = process.env) {
  if (!enabled(env.ORKESTR_HOST_BOUNDARIES)) return [];
  return (await hostBoundaryDoctorChecks(env))
    .filter((item) => item.status !== "ok")
    .map((item) => ({
      code: item.id,
      severity: item.status === "error" ? "error" : "warn",
      summary: item.summary,
      repair: item.repair,
      ...(item.recentCount !== undefined ? { recentCount: item.recentCount } : {}),
      ...(item.ambiguousSelectors !== undefined ? { ambiguousSelectors: item.ambiguousSelectors } : {}),
    }));
}
