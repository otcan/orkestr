import { connectorOrder, getConnectorStatuses } from "../../connectors/src/connectors.js";
import { dataPaths } from "../../storage/src/paths.js";
import { readOverlay } from "./overlay.js";

export { connectorOrder };

function setupState(connectors) {
  const useful = connectors.filter((connector) => ["connected", "partial"].includes(connector.state));
  if (!useful.length) return "incomplete";
  const byId = Object.fromEntries(connectors.map((connector) => [connector.id, connector]));
  const ready =
    byId.openai?.state === "connected" &&
    byId.codex?.state === "connected" &&
    ["connected", "partial"].includes(byId.whatsapp?.state) &&
    ["connected", "partial"].includes(byId.gmail?.state) &&
    ["connected", "partial"].includes(byId.linkedin?.state);
  return ready ? "ready" : "partial";
}

export async function getSetupStatus({ env = process.env, home } = {}) {
  const paths = dataPaths(env);
  const connectors = await getConnectorStatuses({ env, home });
  const overlay = await readOverlay(env);
  return {
    generatedAt: new Date().toISOString(),
    home: paths.home,
    setupState: setupState(connectors),
    overlay,
    connectors,
  };
}
