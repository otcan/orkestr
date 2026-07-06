const defaultSetupSection = "codex";
const setupSections = new Set(["system", "security", "secrets", "maintenance", "codex", "gmail", "whatsapp", "browsers"]);

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
  return setupSections.has(section) ? section : "";
}

function tenantSetupPath(instanceId: string, section = defaultSetupSection): string {
  const normalizedSection = normalizeSetupSection(section) || defaultSetupSection;
  return `/i/${encodeURIComponent(instanceId)}/app/setup/${encodeURIComponent(normalizedSection)}`;
}

export function instanceSetupReturnPath(instanceId: string, rawReturnTo = "", rawConnector = ""): string {
  const defaultReturn = `${tenantSetupPath(instanceId, rawConnector)}${rawConnector ? "" : "?compact=1"}`;
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
  const scopedPrefix = `/i/${encodeURIComponent(instanceId)}/app`;
  if (path === scopedPrefix || path.startsWith(`${scopedPrefix}/`)) return `${path}${search}`;
  if (path === "/setup") return `${scopedPrefix}/setup${search}`;
  if (path.startsWith("/setup/")) return `${scopedPrefix}${path}${search}`;
  if (path === "/onboarding" || path === "/ng/onboarding") return `${scopedPrefix}/setup${search}`;
  return defaultReturn;
}

export function instanceSetupPairingRedirectPath(instanceId: string, rawReturnTo = "", rawConnector = ""): string {
  const target = new URL("/setup/pairing", "http://localhost");
  target.searchParams.set("instanceId", instanceId);
  target.searchParams.set("return", instanceSetupReturnPath(instanceId, rawReturnTo, rawConnector));
  return `${target.pathname}${target.search}`;
}
