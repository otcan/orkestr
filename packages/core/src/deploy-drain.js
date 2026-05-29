import fs from "node:fs";
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";

export function deployDrainPath(env = process.env) {
  return env.ORKESTR_DEPLOY_DRAIN_FILE || path.join(dataPaths(env).home, "deploy-drain.json");
}

export function readDeployDrainSync(env = process.env) {
  const filePath = deployDrainPath(env);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function deployDrainActiveSync(env = process.env) {
  const marker = readDeployDrainSync(env);
  if (!marker || String(marker.state || "") !== "draining") return false;
  const expiresAt = Date.parse(String(marker.expiresAt || ""));
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) return false;
  return true;
}
