const setupSections = new Set(["system", "security", "secrets", "maintenance", "codex", "gmail", "outlook", "whatsapp", "browsers"]);
const appRouteRoots = new Set(["connectors", "desk", "files", "ops", "skills", "thread", "timers"]);
const connectorAuthIntentSections = new Set(["gmail"]);

export function normalizeInstanceId(value = ""): string {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeSetupSection(value = ""): string {
  const section = String(value || "").trim().toLowerCase();
  if (section === "mail") return "gmail";
  if (section === "wa") return "whatsapp";
  if (section === "browser" || section === "desktop" || section === "desks" || section === "linkedin") return "browsers";
  return setupSections.has(section) ? section : "";
}

function tenantAppPath(instanceId: string, suffix = ""): string {
  const prefix = `/i/${encodeURIComponent(instanceId)}/app`;
  const route = String(suffix || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return route ? `${prefix}/${route}` : `${prefix}/`;
}

function connectorIntentSearch(instanceId: string, connector: string, search = ""): string {
  const params = new URLSearchParams(search || "");
  params.delete("compact");
  params.set("mcp", "tools/call");
  params.set("tool", "orkestr_auth");
  params.set("service", connector);
  if (connector === "gmail") {
    params.set("provider", "google_workspace");
    params.set("action", "connect");
  }
  params.set("instance_id", instanceId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function connectorAppPath(instanceId: string, connector: string, search = ""): string {
  const normalizedConnector = normalizeSetupSection(connector);
  const path = tenantAppPath(instanceId, `connectors/${normalizedConnector}`);
  return connectorAuthIntentSections.has(normalizedConnector)
    ? `${path}${connectorIntentSearch(instanceId, normalizedConnector, search)}`
    : `${path}${searchWithoutCompact(search)}`;
}

function setupSectionAppPath(instanceId: string, section = "", search = ""): string {
  const normalizedSection = normalizeSetupSection(section);
  if (["gmail", "outlook", "whatsapp"].includes(normalizedSection)) return connectorAppPath(instanceId, normalizedSection, search);
  if (normalizedSection === "browsers") return `${tenantAppPath(instanceId, "desk")}${searchWithoutCompact(search)}`;
  if (["security", "secrets", "maintenance"].includes(normalizedSection)) return `${tenantAppPath(instanceId, "ops/settings")}${searchWithoutCompact(search)}`;
  if (normalizedSection === "system") return `${tenantAppPath(instanceId, "ops")}${searchWithoutCompact(search)}`;
  return `${tenantAppPath(instanceId)}${searchWithoutCompact(search)}`;
}

function searchWithoutCompact(search = ""): string {
  if (!search) return "";
  const params = new URLSearchParams(search);
  params.delete("compact");
  const query = params.toString();
  return query ? `?${query}` : "";
}

function normalizeScopedAppReturn(instanceId: string, path: string, search = ""): string {
  const scopedPrefix = `/i/${encodeURIComponent(instanceId)}/app`;
  if (path === scopedPrefix) return `${scopedPrefix}/${search}`;
  if (!path.startsWith(`${scopedPrefix}/`)) return "";
  const parts = path.split("/").filter(Boolean);
  const routeRoot = String(parts[3] || "");
  if (routeRoot === "setup") {
    return setupSectionAppPath(instanceId, parts[4] || "", search);
  }
  if (routeRoot === "connectors" && connectorAuthIntentSections.has(normalizeSetupSection(parts[4] || ""))) {
    return connectorAppPath(instanceId, parts[4] || "", search);
  }
  return `${path}${search}`;
}

function normalizeUnscopedAppReturn(instanceId: string, path: string, search = ""): string {
  const parts = path.split("/").filter(Boolean);
  const root = String(parts[0] || "");
  if (root === "setup") return setupSectionAppPath(instanceId, parts[1] || "", search);
  if (root === "onboarding" || (root === "ng" && parts[1] === "onboarding")) return tenantAppPath(instanceId);
  if (root === "connectors" && connectorAuthIntentSections.has(normalizeSetupSection(parts[1] || ""))) return connectorAppPath(instanceId, parts[1] || "", search);
  if (appRouteRoots.has(root)) return `${tenantAppPath(instanceId, parts.join("/"))}${search}`;
  if (root === "ng" && parts[1] === "connectors" && connectorAuthIntentSections.has(normalizeSetupSection(parts[2] || ""))) return connectorAppPath(instanceId, parts[2] || "", search);
  if (root === "ng" && appRouteRoots.has(String(parts[1] || ""))) return `${tenantAppPath(instanceId, parts.slice(1).join("/"))}${search}`;
  return "";
}

export function instanceSetupReturnPath(instanceId: string, rawReturnTo = "", rawConnector = ""): string {
  const defaultReturn = rawConnector ? setupSectionAppPath(instanceId, rawConnector) : tenantAppPath(instanceId);
  const returnTo = String(rawReturnTo || "").trim();
  if (!returnTo) return defaultReturn;
  if (returnTo.startsWith("//")) return defaultReturn;
  let parsed: URL;
  try {
    parsed = new URL(returnTo, "http://localhost");
  } catch {
    return defaultReturn;
  }
  if (parsed.origin !== "http://localhost") return defaultReturn;
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const search = parsed.search || "";
  const scoped = normalizeScopedAppReturn(instanceId, path, search);
  if (scoped) return scoped;
  const unscoped = normalizeUnscopedAppReturn(instanceId, path, search);
  if (unscoped) return unscoped;
  return defaultReturn;
}

export function instanceSetupPairingRedirectPath(instanceId: string, rawReturnTo = "", rawConnector = ""): string {
  const target = new URL("/setup/pairing", "http://localhost");
  target.searchParams.set("instanceId", instanceId);
  target.searchParams.set("return", instanceSetupReturnPath(instanceId, rawReturnTo, rawConnector));
  return `${target.pathname}${target.search}`;
}
