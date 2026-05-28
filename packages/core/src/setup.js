import { connectorOrder, getConnectorStatuses } from "../../connectors/src/connectors.js";
import { dataPaths } from "../../storage/src/paths.js";
import { publicAuthStatus } from "./auth-config.js";
import { readOverlay } from "./overlay.js";
import { readRuntimeSettings } from "./runtime-settings.js";
import { securityStatus } from "./security.js";

export { connectorOrder };

function setupState(connectors) {
  const useful = connectors.filter((connector) => ["connected", "partial"].includes(connector.state));
  if (!useful.length) return "incomplete";
  const byId = Object.fromEntries(connectors.map((connector) => [connector.id, connector]));
  const mailReady =
    ["connected", "partial"].includes(byId.gmail?.state) ||
    ["connected", "partial"].includes(byId.outlook?.state);
  const ready =
    byId.openai?.state === "connected" &&
    byId.codex?.state === "connected" &&
    ["connected", "partial"].includes(byId.whatsapp?.state) &&
    mailReady &&
    ["connected", "partial"].includes(byId.linkedin?.state);
  return ready ? "ready" : "partial";
}

export async function getSetupStatus({ env = process.env, home } = {}) {
  const paths = dataPaths(env);
  const connectors = await getConnectorStatuses({ env, home });
  const overlay = await readOverlay(env);
  const security = await securityStatus(env);
  const auth = publicAuthStatus(env);
  const settings = await readRuntimeSettings(env);
  return {
    generatedAt: new Date().toISOString(),
    home: paths.home,
    setupState: setupState(connectors),
    settings,
    overlay,
    security,
    auth,
    connectors,
  };
}
