import { readConnectorConfig, writeConnectorConfig } from "../../storage/src/config.js";
import { readRuntimeSettings, writeRuntimeSettings } from "./runtime-settings.js";

// Keep the UI preference and the connector's actual transport in sync. The
// connector reads bridgeMode from connector config/env, not runtime settings.
export async function saveWhatsAppOnboardingMode(transport, env = process.env, resolveBridgeMode) {
  if (!new Set(["own", "relay"]).has(transport)) {
    throw Object.assign(new Error("whatsapp_access_mode_invalid"), { statusCode: 400, code: "whatsapp_access_mode_invalid" });
  }
  if (typeof resolveBridgeMode !== "function") throw new TypeError("whatsapp_bridge_mode_resolver_required");
  const previousConfig = await readConnectorConfig("whatsapp", env);
  const previousSettings = await readRuntimeSettings(env);
  const previousMode = resolveBridgeMode(previousConfig, env);
  const previousConfiguredMode = String(previousConfig.bridgeMode || "").trim().toLowerCase();
  let bridgeMode;
  let connectorPatch;
  if (transport === "own") {
    bridgeMode = "local";
    const rememberedMode = previousMode === "external"
      ? (previousConfiguredMode || "external")
      : previousConfig.managedBridgeMode;
    connectorPatch = { bridgeMode, ...(rememberedMode ? { managedBridgeMode: rememberedMode } : {}) };
  } else {
    const rememberedMode = String(previousConfig.managedBridgeMode || "").trim().toLowerCase();
    bridgeMode = rememberedMode && resolveBridgeMode({ ...previousConfig, bridgeMode: rememberedMode }, env) === "external"
      ? rememberedMode
      : previousMode === "external" && previousConfiguredMode
        ? previousConfiguredMode
        : "external";
    if (resolveBridgeMode({ ...previousConfig, bridgeMode }, env) !== "external") {
      throw Object.assign(new Error("whatsapp_managed_mode_unavailable"), { statusCode: 409, code: "whatsapp_managed_mode_unavailable" });
    }
    connectorPatch = { bridgeMode, ...(rememberedMode ? { managedBridgeMode: rememberedMode } : {}) };
  }

  await writeConnectorConfig("whatsapp", connectorPatch, env);
  try {
    const settings = await writeRuntimeSettings({
      connectors: {
        whatsapp: {
          accessMode: transport,
          bridgeMode,
        },
      },
    }, env);
    return { transport, settings };
  } catch (error) {
    // Best-effort rollback prevents a failed preference write from silently
    // leaving the active connector on a transport the UI did not save.
    await writeConnectorConfig("whatsapp", { bridgeMode: previousConfig.bridgeMode || "local" }, env).catch(() => {});
    await writeRuntimeSettings({ connectors: { whatsapp: previousSettings.connectors?.whatsapp || {} } }, env).catch(() => {});
    throw error;
  }
}
