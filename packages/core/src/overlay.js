import path from "node:path";
import { readJson } from "../../storage/src/store.js";

export async function readOverlay(env = process.env) {
  const overlayDir = String(env.ORKESTR_OVERLAY_DIR || "").trim();
  if (!overlayDir) {
    return {
      configured: false,
      path: "",
      valid: true,
      agents: [],
      timers: [],
      connectors: {},
      errors: [],
    };
  }

  const overlayPath = path.resolve(overlayDir, "overlay.json");
  const overlay = await readJson(overlayPath, null);
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) {
    return {
      configured: true,
      path: overlayPath,
      valid: false,
      agents: [],
      timers: [],
      connectors: {},
      errors: [`Missing or invalid overlay file: ${overlayPath}`],
    };
  }

  return {
    configured: true,
    path: overlayPath,
    valid: true,
    name: String(overlay.name || ""),
    agents: Array.isArray(overlay.agents) ? overlay.agents : [],
    timers: Array.isArray(overlay.timers) ? overlay.timers : [],
    connectors: overlay.connectors && typeof overlay.connectors === "object" ? overlay.connectors : {},
    errors: [],
  };
}

