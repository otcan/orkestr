import fs from "node:fs/promises";
import path from "node:path";
import { ensureDataDirs, userDataPaths } from "../../storage/src/paths.js";

function isAdminLikePrincipal(principal = {}) {
  return principal?.kind === "system" || String(principal?.role || "").trim().toLowerCase() === "admin";
}

export function scopedPrincipalUserId(options = {}) {
  const explicitUserId = String(options.userId || "").trim();
  if (explicitUserId) return explicitUserId;
  const principal = options.principal || null;
  if (!principal || isAdminLikePrincipal(principal)) return "";
  return String(principal.userId || "").trim();
}

export async function connectorScopePaths(env = process.env, options = {}) {
  const paths = await ensureDataDirs(env);
  const userId = scopedPrincipalUserId(options);
  if (!userId) {
    return {
      global: true,
      userId: "",
      root: paths.home,
      oauth: paths.oauth,
      secrets: paths.secrets,
    };
  }
  const userPaths = userDataPaths(userId, env);
  await fs.mkdir(userPaths.oauth, { recursive: true });
  await fs.mkdir(userPaths.secrets, { recursive: true, mode: 0o700 });
  return {
    global: false,
    userId,
    root: userPaths.root,
    oauth: userPaths.oauth,
    secrets: userPaths.secrets,
  };
}

export async function listConnectorScopePaths(env = process.env, options = {}) {
  const scopedUserId = scopedPrincipalUserId(options);
  if (scopedUserId) return [await connectorScopePaths(env, { userId: scopedUserId })];

  const paths = await ensureDataDirs(env);
  const scopes = [await connectorScopePaths(env)];
  const entries = (await fs.readdir(paths.userDataRoot, { withFileTypes: true }).catch(() => []))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const userPaths = userDataPaths(entry.name, env);
    scopes.push({
      global: false,
      userId: entry.name,
      root: userPaths.root,
      oauth: userPaths.oauth,
      secrets: userPaths.secrets,
    });
  }
  return scopes;
}

export function connectorFile(scope, folder, fileName) {
  return path.join(scope[folder], fileName);
}
