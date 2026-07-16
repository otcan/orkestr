#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMainModule } from "./main-module.mjs";

const execFileAsync = promisify(execFile);

function clean(value = "") {
  return String(value || "").trim();
}

function list(value = "") {
  return clean(value).split(/[\s,]+/g).map((item) => item.trim()).filter(Boolean);
}

function healthUrl(env = process.env) {
  return clean(env.ORKESTR_CONNECTORS_MCP_HEALTH_URL || "http://127.0.0.1:18914/health");
}

function healthToken(env = process.env) {
  return clean(env.ORKESTR_CONNECTORS_MCP_TOKEN || env.ORKESTR_WA_SERVICE_TOKEN || env.ORKESTR_WA_WORKER_EVENT_TOKEN);
}

export function assessConnectorHealth(payload = {}, env = process.env) {
  const requiredAccounts = list(env.ORKESTR_CONNECTORS_REQUIRED_WA_ACCOUNTS || "sender");
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  const matchesAccount = (account, id) => [
    account.accountId,
    account.id,
    account.runtimeAccountId,
    ...(Array.isArray(account.legacyRoleAliases) ? account.legacyRoleAliases : []),
  ].map(clean).includes(id);
  const accountReady = (account) => account.runtimeUsable === true &&
    account.sendReady === true &&
    account.inboundReady === true;
  const missingAccounts = requiredAccounts.filter((id) => !accounts.some((account) => matchesAccount(account, id)));
  const unavailableAccounts = requiredAccounts.filter((id) => accounts.some((account) =>
    matchesAccount(account, id) && !accountReady(account)
  ));
  const issues = [
    ...(payload.ok === false ? ["gateway_unhealthy"] : []),
    ...(payload.gateway?.ok === false ? ["gateway_unhealthy"] : []),
    ...(payload.worker?.ok === false ? ["worker_unhealthy"] : []),
    ...(missingAccounts.length ? ["required_accounts_missing"] : []),
    ...(unavailableAccounts.length ? ["required_accounts_unavailable"] : []),
    ...(Number(payload.queue?.deadLetter || 0) > 0 ? ["dead_letter_events"] : []),
  ];
  return {
    ok: issues.length === 0,
    issues: [...new Set(issues)],
    missingAccounts,
    unavailableAccounts,
    queue: payload.queue || {},
    workerState: clean(payload.worker?.state || payload.state),
  };
}

function connectorStartupGraceMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CONNECTORS_DOCTOR_STARTUP_GRACE_MS || 180_000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 180_000;
}

function recoveringRequiredAccounts(payload = {}, assessment = {}, env = process.env, nowMs = Date.now()) {
  const graceMs = connectorStartupGraceMs(env);
  if (!graceMs) return [];
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  const recoveringStates = new Set(["starting", "authenticated", "loading", "chat_ops_warming"]);
  return assessment.unavailableAccounts.filter((id) => accounts.some((account) => {
    const aliases = [account.accountId, account.id, account.runtimeAccountId, ...(Array.isArray(account.legacyRoleAliases) ? account.legacyRoleAliases : [])]
      .map(clean);
    if (!aliases.includes(id) || !recoveringStates.has(clean(account.state))) return false;
    const updatedMs = Date.parse(clean(account.updatedAt || account.authenticatedAt || account.startedAt));
    const ageMs = nowMs - updatedMs;
    return Number.isFinite(updatedMs) && ageMs >= 0 && ageMs <= graceMs;
  }));
}

async function loadRepairState(env = process.env) {
  const filePath = clean(env.ORKESTR_CONNECTORS_DOCTOR_STATE_FILE) || path.join(clean(env.ORKESTR_HOME || "/opt/orkestr/data"), "connectors-doctor.json");
  const state = await fs.readFile(filePath, "utf8").then(JSON.parse, () => ({ repairs: [] }));
  return { filePath, repairs: Array.isArray(state.repairs) ? state.repairs : [] };
}

async function repairAllowed(env = process.env) {
  const state = await loadRepairState(env);
  const cutoff = Date.now() - 60 * 60 * 1000;
  const repairs = state.repairs.filter((value) => Date.parse(value) > cutoff);
  const limit = Math.max(1, Number(env.ORKESTR_CONNECTORS_DOCTOR_MAX_REPAIRS_PER_HOUR || 3) || 3);
  return { ...state, repairs, allowed: repairs.length < limit };
}

async function rememberRepair(state, env = process.env) {
  await fs.mkdir(path.dirname(state.filePath), { recursive: true });
  await fs.writeFile(state.filePath, JSON.stringify({ repairs: [...state.repairs, new Date().toISOString()] }), { mode: 0o600 });
}

async function restartService(name = "") {
  await execFileAsync("systemctl", ["restart", `${clean(name)}.service`], { timeout: 30_000 });
}

export async function runConnectorDoctor({ repair = false, env = process.env, fetchImpl = fetch } = {}) {
  let payload;
  try {
    const token = healthToken(env);
    const response = await fetchImpl(healthUrl(env), {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(Math.max(500, Number(env.ORKESTR_CONNECTORS_DOCTOR_TIMEOUT_MS || 5000) || 5000)),
    });
    payload = await response.json().catch(() => ({}));
    if (!response.ok) payload = { ...payload, ok: false, error: payload.error || `health_http_${response.status}` };
  } catch (error) {
    payload = { ok: false, gateway: { ok: false }, worker: { ok: false }, error: clean(error?.message) || "health_unreachable" };
  }
  const assessment = assessConnectorHealth(payload, env);
  if (assessment.ok || !repair) return { ...assessment, repaired: false, health: payload };

  const recoveringAccounts = recoveringRequiredAccounts(payload, assessment, env);
  if (assessment.issues.length === 1 &&
    assessment.issues[0] === "required_accounts_unavailable" &&
    recoveringAccounts.length === assessment.unavailableAccounts.length) {
    return {
      ...assessment,
      repaired: false,
      repairSuppressed: "startup_grace",
      recoveringAccounts,
      health: payload,
    };
  }

  const state = await repairAllowed(env);
  if (!state.allowed) return { ...assessment, repaired: false, repairSuppressed: "hourly_limit", health: payload };
  const workerService = clean(env.ORKESTR_WA_WORKER_SYSTEMD_SERVICE || "orkestr-wa-worker@sender");
  const gatewayService = clean(env.ORKESTR_CONNECTORS_MCP_SYSTEMD_SERVICE || "orkestr-connectors-mcp");
  const repairedServices = [];
  if (assessment.issues.some((issue) => ["worker_unhealthy", "required_accounts_missing", "required_accounts_unavailable"].includes(issue))) {
    await restartService(workerService);
    repairedServices.push(workerService);
  }
  if (assessment.issues.includes("gateway_unhealthy")) {
    await restartService(gatewayService);
    repairedServices.push(gatewayService);
  }
  if (!repairedServices.length) {
    return { ...assessment, repaired: false, repairSuppressed: "manual_intervention", health: payload };
  }
  await rememberRepair(state, env);
  return { ...assessment, repaired: true, repairedServices, health: payload };
}

if (isMainModule(import.meta.url)) {
  const result = await runConnectorDoctor({ repair: process.argv.includes("--repair") });
  console.log(JSON.stringify(result));
  if (!result.ok && !result.repaired && result.repairSuppressed !== "startup_grace") process.exitCode = 1;
}
