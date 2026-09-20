import http from "node:http";
import https from "node:https";

export function validateTransportTarget({ hostname, path = "/", hstsMaxAge } = {}) {
  if (typeof hostname !== "string" || hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname) ||
      typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.length > 1024 || /[\x00-\x20\x7f?#\\]/.test(path) ||
      !Number.isInteger(hstsMaxAge) || hstsMaxAge < 1 || hstsMaxAge > 63072000) throw new Error("explicit_transport_policy_required");
  return { hostname, path, hstsMaxAge };
}

export function assessTransportResponse(target, protocol, response) {
  const policy = validateTransportTarget(target);
  if (!response || response.error) return { ok: false, reason: "probe_failed" };
  if (protocol === "http") {
    let location;
    try { location = new URL(response.location); } catch { return { ok: false, reason: "same_host_https_redirect_missing" }; }
    const expected = new URL(`https://${policy.hostname}${policy.path}`);
    return { ok: [301, 308].includes(response.status) && location.href === expected.href,
      reason: [301, 308].includes(response.status) && location.href === expected.href ? "same_host_https_redirect" : "same_host_https_redirect_missing" };
  }
  if (protocol !== "https") throw new Error("invalid_transport_protocol");
  const directives = String(response.hsts || "").split(";").map(value => value.trim().toLowerCase());
  const maxAge = directives.filter(value => value.startsWith("max-age="));
  const valid = maxAge.length === 1 && maxAge[0] === `max-age=${policy.hstsMaxAge}` &&
    directives.every(value => value === `max-age=${policy.hstsMaxAge}` || value === "") && response.tlsAuthorized === true;
  const ok = valid && response.status >= 200 && response.status < 400;
  return { ok, reason: ok ? "https_policy_present" : "https_policy_missing_or_unapproved_or_unavailable" };
}

function head(target, protocol, tlsVersion, request) {
  return new Promise(resolve => {
    let settled = false, timer;
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    let req;
    try {
      req = request({ protocol: `${protocol}:`, hostname: target.hostname, path: target.path, method: "HEAD",
        port: protocol === "https" ? 443 : 80, agent: false, maxHeaderSize: 16384,
        ...(tlsVersion ? { minVersion: tlsVersion, maxVersion: tlsVersion, rejectUnauthorized: true } : {}),
        headers: { "user-agent": "orkestr-transport-policy/1" } }, res => {
        const result = { status: res.statusCode, location: res.headers.location, hsts: res.headers["strict-transport-security"],
          tlsAuthorized: protocol === "https" && res.socket?.authorized === true };
        res.resume(); finish(result); req.destroy();
      });
      req.on("error", () => finish({ error: true }));
      timer = setTimeout(() => { finish({ error: true }); req.destroy(); }, 8000);
      req.end();
    } catch { finish({ error: true }); req?.destroy(); }
  });
}

// DNS and request share an absolute deadline; never follows redirects or falls
// back to GET. Call only for an explicitly approved host/path list.
export async function probeTransportPolicy(target, requests = { http: http.request, https: https.request }) {
  const policy = validateTransportTarget(target);
  const checks = await Promise.all([["http", null], ["https", "TLSv1.2"], ["https", "TLSv1.3"]].map(async ([protocol, tlsVersion]) => ({
    protocol, tlsVersion, ...assessTransportResponse(policy, protocol, await head(policy, protocol, tlsVersion, requests[protocol])),
  })));
  return { hostname: policy.hostname, path: policy.path, ok: checks.every(check => check.ok), checks, mutations: false };
}

export function traefikTransportMiddlewares({ namespace, name, hstsMaxAge, compatibilityReviewed } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,50}$/.test(namespace || "") || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name || "") ||
      !Number.isInteger(hstsMaxAge) || hstsMaxAge < 1 || hstsMaxAge > 63072000 || compatibilityReviewed !== true) throw new Error("reviewed_transport_policy_required");
  return { applyEnabled: false, middlewareOnly: true, requires: ["exact_router_attachment_review", "acme_and_callback_qualification", "version_fenced_rollback"], objects: [
    { apiVersion: "traefik.io/v1alpha1", kind: "Middleware", metadata: { namespace, name: `${name}-redirect` }, spec: { redirectScheme: { scheme: "https", permanent: true } } },
    { apiVersion: "traefik.io/v1alpha1", kind: "Middleware", metadata: { namespace, name: `${name}-hsts` }, spec: { headers: { stsSeconds: hstsMaxAge, stsIncludeSubdomains: false, stsPreload: false, forceSTSHeader: false } } },
  ] };
}
