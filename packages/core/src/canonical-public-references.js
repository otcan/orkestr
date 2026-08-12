export * from "../../storage/src/public-references.js";

export function canonicalInstanceUrlsEnabled(env = process.env) {
  return ["1", "true", "yes", "on", "enabled"]
    .includes(String(env.ORKESTR_CANONICAL_INSTANCE_URLS || "").trim().toLowerCase());
}

export function canonicalAppGatewayEnabled(env = process.env) {
  return canonicalInstanceUrlsEnabled(env) && ["1", "true", "yes", "on", "enabled"]
    .includes(String(env.ORKESTR_CANONICAL_APP_GATEWAY || "").trim().toLowerCase());
}
