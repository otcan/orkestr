import { configuredWhatsAppBridgeUrl } from "./whatsapp.js";

const SAFE_CONNECTOR_STATES = new Set(["connected", "partial", "not_connected", "broken"]);

function clean(value) {
  return String(value || "").trim().toLowerCase();
}

function configuredMode(settings = {}) {
  const value = clean(settings?.connectors?.whatsapp?.accessMode);
  return ["relay", "managed", "hosted"].includes(value) ? "managed" : "self_hosted";
}

function externalModeRequired(env = process.env) {
  return ["external", "relay", "parent-forward", "control-plane-forward", "control-plane", "controlplane", "broker"]
    .includes(clean(env.WHATSAPP_BRIDGE_MODE));
}

function safeHealth(connector = {}) {
  const state = clean(connector.state);
  return SAFE_CONNECTOR_STATES.has(state) ? state : "not_connected";
}

function safePairingState(connector = {}) {
  const details = connector.details && typeof connector.details === "object" ? connector.details : {};
  const state = clean(details.state || connector.state);
  if (["paired", "ready", "connected", "send_ready_scoped"].includes(state)) return "paired";
  if (["qr_needed", "pairing_code", "authenticating", "starting"].includes(state)) return state;
  if (["failed", "unreachable", "broken"].includes(state)) return "needs_attention";
  return "not_started";
}

// The projection is enums and booleans only: never return bridge endpoints,
// account IDs, QR data, pairing codes, phone numbers, or provider errors.
export async function whatsappOnboardingStatus({ env = process.env, settings = {}, connectors = [] } = {}) {
  const managedAvailable = Boolean(await configuredWhatsAppBridgeUrl(env).catch(() => ""));
  const localAvailable = !externalModeRequired(env);
  const availableModes = [...(localAvailable ? ["self_hosted"] : []), ...(managedAvailable ? ["managed"] : [])];
  const selected = configuredMode(settings);
  const selectedMode = availableModes.includes(selected) ? selected : availableModes[0] || null;
  const whatsapp = Array.isArray(connectors) ? connectors.find((item) => clean(item?.id) === "whatsapp") : null;
  return {
    availableModes,
    selectedMode,
    health: safeHealth(whatsapp || {}),
    pairingState: safePairingState(whatsapp || {}),
  };
}

export async function assertWhatsAppOnboardingModeAvailable(mode, env = process.env) {
  const requested = clean(mode);
  if (["own", "local", "self", "self-managed", "self_hosted"].includes(requested)) {
    if (!externalModeRequired(env)) return "own";
    throw Object.assign(new Error("whatsapp_self_hosted_mode_unavailable"), { statusCode: 409, code: "whatsapp_self_hosted_mode_unavailable" });
  }
  if (["relay", "managed", "hosted"].includes(requested)) {
    if (await configuredWhatsAppBridgeUrl(env).catch(() => "")) return "relay";
    throw Object.assign(new Error("whatsapp_managed_mode_unavailable"), { statusCode: 409, code: "whatsapp_managed_mode_unavailable" });
  }
  throw Object.assign(new Error("whatsapp_access_mode_invalid"), { statusCode: 400, code: "whatsapp_access_mode_invalid" });
}
