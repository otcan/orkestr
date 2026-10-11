import { assertWhatsAppOnboardingModeAvailable } from "../../connectors/src/whatsapp-onboarding.js";
import { readConnectorConfig, writeConnectorConfig } from "../../storage/src/config.js";
import { readRuntimeSettings, writeRuntimeSettings } from "./runtime-settings.js";

function requestedModeValue(mode) {
  return mode === "own" ? "self_hosted" : mode === "relay" ? "managed" : mode;
}

// Keep the UI preference and the connector's actual transport in sync. The
// connector reads bridgeMode from connector config/env, not runtime settings.
export async function saveWhatsAppOnboardingMode(mode, env = process.env) {
  const transport = await assertWhatsAppOnboardingModeAvailable(requestedModeValue(mode), env);
  const bridgeMode = transport === "own" ? "local" : "relay";
  const previousConfig = await readConnectorConfig("whatsapp", env);
  const previousSettings = await readRuntimeSettings(env);

  await writeConnectorConfig("whatsapp", { bridgeMode }, env);
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
