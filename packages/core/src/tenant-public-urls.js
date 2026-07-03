function clean(value = "") {
  return String(value || "").trim();
}

function normalizeHttpUrl(value = "") {
  const text = clean(value).replace(/\/+$/, "");
  if (!text) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    if (!parsed.hostname || parsed.username || parsed.password) return "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function privateHost(hostname = "") {
  const host = clean(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (["localhost", "0.0.0.0", "127.0.0.1", "::1", "::", "*"].includes(host)) return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const private172 = host.match(/^172\.(\d+)\./);
  return private172 ? Number(private172[1]) >= 16 && Number(private172[1]) <= 31 : false;
}

export function publicHttpUrl(value = "") {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return "";
  try {
    return privateHost(new URL(normalized).hostname) ? "" : normalized;
  } catch {
    return "";
  }
}

function runtimeEnv(input = {}) {
  return input.runtimeEnv && typeof input.runtimeEnv === "object" && !Array.isArray(input.runtimeEnv)
    ? input.runtimeEnv
    : {};
}

function objectValue(value = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function appendInstanceSetup(baseUrl = "", instanceId = "") {
  const base = publicHttpUrl(baseUrl);
  const id = clean(instanceId);
  if (!base || !id) return "";
  try {
    const parsed = new URL(base);
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/i/${encodeURIComponent(id)}/setup`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function tenantPublicSetupUrl(input = {}, env = process.env) {
  const source = runtimeEnv(input);
  const explicit = publicHttpUrl(
    input.connectPublicSetupUrl ||
      input.publicSetupUrl ||
      input.setupUrl ||
      source.ORKESTR_CONNECT_PUBLIC_SETUP_URL ||
      env.ORKESTR_CONNECT_PUBLIC_SETUP_URL ||
      env.ORKESTR_DEMO_PUBLIC_SETUP_URL,
  );
  if (explicit) return explicit;
  const labels = objectValue(input.labels);
  const tenantVmId = clean(input.tenantVmId || input.vmId || source.ORKESTR_TENANT_VM_ID || env.ORKESTR_TENANT_VM_ID);
  const brokerInstanceId = clean(
    input.brokerInstanceId ||
      input.instanceId ||
      labels.brokerInstanceId ||
      labels.instanceId ||
      source.ORKESTR_BROKER_INSTANCE_ID ||
      source.ORKESTR_INSTANCE_ID ||
      (!tenantVmId ? env.ORKESTR_BROKER_INSTANCE_ID || env.ORKESTR_INSTANCE_ID : ""),
  );
  const base = publicHttpUrl(
    input.connectPublicBaseUrl ||
      input.publicConnectBaseUrl ||
      input.connectBaseUrl ||
      source.ORKESTR_CONNECT_PUBLIC_BASE_URL ||
      source.ORKESTR_CONNECT_PUBLIC_URL ||
      env.ORKESTR_CONNECT_PUBLIC_BASE_URL ||
      env.ORKESTR_CONNECT_PUBLIC_URL,
  );
  return appendInstanceSetup(base, brokerInstanceId);
}

export function tenantPublicUrls(input = {}, env = process.env) {
  const source = runtimeEnv(input);
  const tenantVmId = clean(input.tenantVmId || input.vmId || source.ORKESTR_TENANT_VM_ID || env.ORKESTR_TENANT_VM_ID);
  const connectBaseUrl = publicHttpUrl(
    input.connectPublicBaseUrl ||
      input.publicConnectBaseUrl ||
      input.connectBaseUrl ||
      source.ORKESTR_CONNECT_PUBLIC_BASE_URL ||
      source.ORKESTR_CONNECT_PUBLIC_URL ||
      env.ORKESTR_CONNECT_PUBLIC_BASE_URL ||
      env.ORKESTR_CONNECT_PUBLIC_URL,
  );
  const setupUrl = tenantPublicSetupUrl({ ...input, runtimeEnv: source, tenantVmId }, env);
  const pairingUrl = publicHttpUrl(
    input.pairingUrl ||
      input.challengeUrl ||
      source.ORKESTR_PAIRING_URL ||
      env.ORKESTR_PAIRING_URL ||
      setupUrl,
  );
  const appUrl = publicHttpUrl(
    input.publicAppBaseUrl ||
      input.publicAppUrl ||
      input.publicUrl ||
      source.ORKESTR_PUBLIC_APP_URL ||
      source.ORKESTR_PUBLIC_URL ||
      source.ORKESTR_PUBLIC_HTTPS_URL ||
      source.ORKESTR_APP_URL ||
      env.ORKESTR_PUBLIC_APP_URL ||
      env.ORKESTR_PUBLIC_URL ||
      env.ORKESTR_PUBLIC_HTTPS_URL ||
      env.ORKESTR_APP_URL ||
      connectBaseUrl,
  );
  return {
    connectBaseUrl,
    setupUrl,
    pairingUrl,
    appUrl,
  };
}
