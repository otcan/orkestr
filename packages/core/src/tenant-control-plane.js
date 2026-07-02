function clean(value = "") {
  return String(value || "").trim();
}

function cleanObject(value = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

export function normalizeTenantControlPlane(input = {}, env = process.env, options = {}) {
  const source = cleanObject(input);
  const defaultEnabled = options.defaultEnabled === true;
  const authUrl = clean(source.authUrl || source.authorizationUrl || env.ORKESTR_AUTH_URL);
  const publicAuthUrl = clean(source.publicAuthUrl || source.publicAuthorizationUrl || env.ORKESTR_PUBLIC_AUTH_URL || env.ORKESTR_AUTH_ENTRY_URL);
  const pairingUrl = clean(source.pairingUrl || source.challengeUrl || source.challengesUrl || env.ORKESTR_PAIRING_URL);
  const connectPublicUrl = clean(source.connectPublicUrl || source.publicConnectUrl || env.ORKESTR_CONNECT_PUBLIC_URL);
  const connectPublicBaseUrl = clean(source.connectPublicBaseUrl || source.publicConnectBaseUrl || env.ORKESTR_CONNECT_PUBLIC_BASE_URL);
  const connectPublicSetupUrl = clean(source.connectPublicSetupUrl || source.publicSetupUrl || env.ORKESTR_CONNECT_PUBLIC_SETUP_URL);
  const brokerBaseUrl = clean(source.brokerBaseUrl || source.controlPlaneBaseUrl || source.baseUrl || env.ORKESTR_DEMO_BROKER_BASE_URL || env.ORKESTR_BROKER_BASE_URL);
  const hasPublicCoordinate = Boolean(
    authUrl ||
    publicAuthUrl ||
    pairingUrl ||
    connectPublicUrl ||
    connectPublicBaseUrl ||
    connectPublicSetupUrl ||
    brokerBaseUrl
  );
  const enabled = source.enabled === false
    ? false
    : boolValue(source.enabled, defaultEnabled || hasPublicCoordinate);
  return {
    enabled,
    mode: enabled ? "shared" : "disabled",
    sharedAuthorization: enabled && boolValue(source.sharedAuthorization ?? source.sharedAuth ?? source.authorizationShared, true),
    sharedChallenges: enabled && boolValue(source.sharedChallenges ?? source.challengeShared ?? source.challengesShared, true),
    authUrl,
    publicAuthUrl,
    pairingUrl,
    connectPublicUrl,
    connectPublicBaseUrl,
    connectPublicSetupUrl,
    brokerBaseUrl,
  };
}

export function publicTenantControlPlane(input = {}) {
  const normalized = normalizeTenantControlPlane(input, {}, { defaultEnabled: input.enabled === true });
  const output = {
    enabled: normalized.enabled,
    mode: normalized.mode,
    sharedAuthorization: normalized.sharedAuthorization,
    sharedChallenges: normalized.sharedChallenges,
  };
  for (const key of ["authUrl", "publicAuthUrl", "pairingUrl", "connectPublicUrl", "connectPublicBaseUrl", "connectPublicSetupUrl", "brokerBaseUrl"]) {
    if (normalized[key]) output[key] = normalized[key];
  }
  return output;
}

export function tenantControlPlaneRuntimeEnv(input = {}) {
  const controlPlane = normalizeTenantControlPlane(input, {}, { defaultEnabled: input.enabled === true });
  if (!controlPlane.enabled) return {};
  return Object.fromEntries(Object.entries({
    ORKESTR_SHARED_CONTROL_PLANE: "1",
    ORKESTR_SHARED_AUTHORIZATION: controlPlane.sharedAuthorization ? "1" : "0",
    ORKESTR_SHARED_CHALLENGES: controlPlane.sharedChallenges ? "1" : "0",
    ORKESTR_AUTH_REQUIRED: controlPlane.sharedAuthorization ? "1" : "",
    ORKESTR_AUTH_URL: controlPlane.authUrl,
    ORKESTR_PUBLIC_AUTH_URL: controlPlane.publicAuthUrl,
    ORKESTR_PAIRING_URL: controlPlane.pairingUrl,
    ORKESTR_CONNECT_PUBLIC_URL: controlPlane.connectPublicUrl,
    ORKESTR_CONNECT_PUBLIC_BASE_URL: controlPlane.connectPublicBaseUrl,
    ORKESTR_CONNECT_PUBLIC_SETUP_URL: controlPlane.connectPublicSetupUrl,
    ORKESTR_BROKER_BASE_URL: controlPlane.brokerBaseUrl,
    ORKESTR_DEMO_BROKER_BASE_URL: controlPlane.brokerBaseUrl,
  }).filter(([, value]) => clean(value)));
}
