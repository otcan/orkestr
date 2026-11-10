import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataPaths } from "../../storage/src/paths.js";
import { isAdminPrincipal } from "./policy.js";
import { personalAgentFeature } from "./personal-agent-feature.js";

const requiredTables = Object.freeze(["personal_agent_projects", "personal_agent_tasks"]);

export function requirePersonalAgentOwner(request) {
  const principal = request?.orkestrPrincipal;
  if (
    !principal?.userId ||
    principal?.kind !== "user" ||
    request?.orkestrAnonymous ||
    request?.orkestrMachineAuth ||
    !isAdminPrincipal(principal)
  ) {
    throw Object.assign(new Error("personal_agent_owner_required"), { statusCode: 403 });
  }
}

function agentJobDatabasePath(env) {
  return path.resolve(String(env.ORKESTR_AGENT_JOBS_DB || "").trim() || path.join(dataPaths(env).home, "agent-jobs.sqlite"));
}

function personalAgentStorageReady(env) {
  let db;
  try {
    const dbPath = agentJobDatabasePath(env);
    if (!fs.statSync(dbPath).isFile()) return false;
    db = new DatabaseSync(dbPath, { readOnly: true });
    const present = new Set(db.prepare(
      "select name from sqlite_master where type = 'table' and name in (?, ?)",
    ).all(...requiredTables).map((row) => row.name));
    return requiredTables.every((name) => present.has(name));
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function personalAgentCapability(request, env = process.env) {
  requirePersonalAgentOwner(request);
  const enabled = personalAgentFeature(env);
  const assistant = { available: false, reason: "not_configured" };
  if (!enabled) return { enabled: false, capability: false, reason: "disabled", assistant };
  if (!personalAgentStorageReady(env)) {
    return { enabled: true, capability: false, reason: "storage_unavailable", assistant };
  }
  return { enabled: true, capability: true, assistant };
}
