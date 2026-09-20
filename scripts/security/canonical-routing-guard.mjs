// Static guard for adapted Caddy JSON. No requests, pairing or config reload.
const paths = ["/api/security/challenges", "/api/threads", "/api/whereiam"];
function matchPath(pattern, value) {
  if (typeof pattern !== "string") throw new Error("unsupported_route_matcher");
  if (!pattern.includes("*")) return pattern === value;
  if (pattern.endsWith("*") && pattern.indexOf("*") === pattern.length - 1) return value.startsWith(pattern.slice(0, -1));
  throw new Error("unsupported_route_matcher");
}
function routeMatches(route, host, path, method) {
  if (!route.match) return true;
  if (!Array.isArray(route.match)) throw new Error("unsupported_route_matcher");
  if (!route.match.length) return true;
  return route.match.some(match => {
    if (!match || Object.keys(match).some(key => !["host", "path", "method"].includes(key))) throw new Error("unsupported_route_matcher");
    if (match.host && (!Array.isArray(match.host) || match.host.some(value => typeof value !== "string" || value.includes("*")))) throw new Error("unsupported_route_matcher");
    return (!match.host || match.host.includes(host)) && (!match.path || match.path.some(pattern => matchPath(pattern, path))) &&
      (!match.method || match.method.includes(method));
  });
}
function resolveRoutes(routes, host, path, method, depth = 0) {
  if (!Array.isArray(routes) || depth > 20) throw new Error("unsupported_route_graph");
  for (const route of routes) {
    if (route.group) throw new Error("route_group_requires_manual_review");
    if (!routeMatches(route, host, path, method)) continue;
    if (!Array.isArray(route.handle)) throw new Error("unsupported_route_graph");
    for (const handler of route.handle) {
      if (handler.handler === "subroute") {
        const result = resolveRoutes(handler.routes, host, path, method, depth + 1);
        if (result) return result;
      } else if (handler.handler === "reverse_proxy") {
        if (!Array.isArray(handler.upstreams) || !handler.upstreams.length || handler.dynamic_upstreams ||
            handler.upstreams.some(upstream => typeof upstream.dial !== "string" || /[{}]/.test(upstream.dial))) throw new Error("dynamic_upstream_requires_review");
        return handler.upstreams.map(upstream => upstream.dial).sort();
      } else if (!["headers", "vars", "encode"].includes(handler.handler)) {
        throw new Error("non_proxy_handler_requires_review");
      }
    }
    if (route.terminal) throw new Error("terminal_route_without_proven_proxy");
  }
  return null;
}

export function inspectCanonicalRouting(config, { bindings } = {}) {
  if (!Array.isArray(bindings) || !bindings.length || bindings.length > 20) throw new Error("explicit_canonical_bindings_required");
  const servers = config?.apps?.http?.servers;
  if (!servers || typeof servers !== "object") throw new Error("adapted_caddy_config_required");
  const results = [];
  for (const binding of bindings) {
    if (!binding || typeof binding.host !== "string" || !/^[a-z0-9.-]+$/.test(binding.host) ||
        typeof binding.server !== "string" || !Array.isArray(binding.upstreams) || !binding.upstreams.length ||
        binding.upstreams.some(value => typeof value !== "string" || !value || /[{}\s]/.test(value))) throw new Error("explicit_canonical_bindings_required");
    for (const path of paths) for (const method of ["GET", "POST"]) {
      try {
        const actual = resolveRoutes(servers[binding.server]?.routes, binding.host, path, method);
        const ok = JSON.stringify(actual) === JSON.stringify([...binding.upstreams].sort());
        results.push({ host: binding.host, path, method, ok, reason: ok ? "canonical_upstream_matches" : "canonical_upstream_mismatch" });
      } catch {
        results.push({ host: binding.host, path, method, ok: false, reason: "route_graph_requires_manual_review" });
      }
    }
  }
  return { ok: results.every(row => row.ok), results, mutations: false,
    requires: ["caddy_validate", "live_runtime_identity_and_auth_boundary_readback", "preserve_unrelated_routes", "review_all_listeners_and_host_ownership"] };
}
