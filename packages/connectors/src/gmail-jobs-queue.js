import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { appendEvent } from "../../storage/src/store.js";
import {
  processJobCandidateMessages,
  readJobsQueueSettings,
  updateJobsQueueSettings,
} from "../../core/src/jobs-queue.js";
import { isAdminPrincipal, policyError } from "../../core/src/policy.js";
import { adminUserId, normalizeUserId } from "../../core/src/users.js";
import { getGmailMessage, listGmailMessages } from "./gmail.js";

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const defaultPollIntervalMs = 10 * minuteMs;
const defaultDigestIntervalMs = 2 * hourMs;
const defaultMaxItemsPerRun = 5;
const defaultGogClient = "ops-health-gmail";
const defaultQuery = [
  "newer_than:2d",
  "(job OR jobs OR role OR hiring OR recruiter OR opportunity OR LinkedIn OR StepStone OR Wellfound OR 9am)",
].join(" ");

function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function truthy(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(lower(value)) || value === true || value === 1;
}

function intValue(value, fallback, min, max) {
  const parsed = Number(value);
  const numeric = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.max(min, Math.min(max, numeric));
}

function parseIntervalMs(value, fallbackMs) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.floor(value));
  const text = lower(value);
  if (!text) return fallbackMs;
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/^(\d+)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/);
  if (!match) return fallbackMs;
  const amount = Math.max(1, Number(match[1]));
  if (match[2] === "ms") return amount;
  if (["s", "sec", "secs"].includes(match[2])) return amount * 1000;
  if (["m", "min", "mins"].includes(match[2])) return amount * minuteMs;
  if (["h", "hr", "hrs"].includes(match[2])) return amount * hourMs;
  return amount * 24 * hourMs;
}

function ownerUserIdFor(input = {}, principal = null, env = process.env) {
  if (principal && !isAdminPrincipal(principal)) return normalizeUserId(principal.userId);
  return normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

function jobsQuery(input = {}, env = process.env) {
  return clean(input.query || env.ORKESTR_JOBS_GMAIL_QUERY) || defaultQuery;
}

function jobsTargetThreadId(input = {}, env = process.env) {
  return clean(input.targetThreadId || input.threadId || env.ORKESTR_JOBS_TARGET_THREAD_ID || env.ORKESTR_JOBS_THREAD_ID);
}

function jobsAutomationEnabled(env = process.env) {
  return truthy(env.ORKESTR_JOBS_AUTOMATION_ENABLED, false);
}

function gmailScopeOptions(principal = null, ownerUserId = "") {
  return principal && !isAdminPrincipal(principal)
    ? { principal, userId: ownerUserId }
    : { principal };
}

function commandVector(input = {}, env = process.env) {
  const rawJson = clean(input.gogCommandJson || env.ORKESTR_JOBS_GOG_COMMAND_JSON || env.ORKESTR_GOG_COMMAND_JSON);
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed) && parsed.length) return parsed.map(clean).filter(Boolean);
    } catch {
      return ["gog"];
    }
  }
  return [clean(input.gogCommand || env.ORKESTR_JOBS_GOG_COMMAND || env.ORKESTR_GOG_COMMAND) || "gog"];
}

function parseEnvValue(raw = "") {
  const text = String(raw || "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}

async function envValueFromFile(filePath = "", name = "") {
  if (!filePath || !name) return "";
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match?.[1] === name) return parseEnvValue(match[2]);
  }
  return "";
}

async function gogEnv(input = {}, env = process.env) {
  const nextEnv = { ...process.env, ...env };
  if (!nextEnv.GOG_KEYRING_PASSWORD) {
    const envFile = clean(input.gogEnvFile || env.ORKESTR_JOBS_GOG_ENV_FILE || env.ORKESTR_GOG_ENV_FILE);
    const password = await envValueFromFile(envFile, "GOG_KEYRING_PASSWORD");
    if (password) nextEnv.GOG_KEYRING_PASSWORD = password;
  }
  return nextEnv;
}

async function passwdRecord(username = "") {
  const target = clean(username);
  if (!target) return null;
  const raw = await fs.readFile("/etc/passwd", "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(":");
    if (parts[0] !== target) continue;
    const uid = Number(parts[2]);
    const gid = Number(parts[3]);
    if (!Number.isFinite(uid) || !Number.isFinite(gid)) return null;
    return {
      username: parts[0],
      uid,
      gid,
      home: clean(parts[5]),
      shell: clean(parts[6]),
    };
  }
  return null;
}

async function userRuntimeDir(uid) {
  const runtimeDir = `/run/user/${uid}`;
  const stat = await fs.stat(runtimeDir).catch(() => null);
  return stat?.isDirectory() ? runtimeDir : "";
}

async function userDbusAddress(uid) {
  const runtimeDir = await userRuntimeDir(uid);
  if (!runtimeDir) return "disabled:";
  const busPath = `${runtimeDir}/bus`;
  const stat = await fs.stat(busPath).catch(() => null);
  return stat?.isSocket() ? `unix:path=${busPath}` : "disabled:";
}

async function runJsonCommand(command = [], args = [], env = process.env, input = {}) {
  const runAsUser = clean(input.gogRunAsUser || env.ORKESTR_JOBS_GOG_RUN_AS_USER || env.ORKESTR_GOG_RUN_AS_USER);
  const childEnv = { ...env };
  const spawnOptions = { env: childEnv, stdio: ["ignore", "pipe", "pipe"] };
  if (runAsUser && process.getuid?.() === 0) {
    const record = await passwdRecord(runAsUser);
    if (!record) throw Object.assign(new Error("gog_run_as_user_not_found"), { statusCode: 500 });
    spawnOptions.uid = record.uid;
    spawnOptions.gid = record.gid;
    childEnv.USER = record.username;
    childEnv.LOGNAME = record.username;
    if (record.home) childEnv.HOME = record.home;
    if (record.shell) childEnv.SHELL = record.shell;
    if (!clean(childEnv.XDG_RUNTIME_DIR)) {
      const runtimeDir = await userRuntimeDir(record.uid);
      if (runtimeDir) childEnv.XDG_RUNTIME_DIR = runtimeDir;
    }
    if (!clean(childEnv.DBUS_SESSION_BUS_ADDRESS)) childEnv.DBUS_SESSION_BUS_ADDRESS = await userDbusAddress(record.uid);
    if (!clean(childEnv.NO_AT_BRIDGE)) childEnv.NO_AT_BRIDGE = "1";
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], spawnOptions);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Object.assign(new Error("gog_gmail_timeout"), { statusCode: 504 }));
    }, Math.max(1000, Number(input.gogTimeoutMs || 60_000) || 60_000));
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(Object.assign(new Error(clean(stderr) || `gog_gmail_exit_${code}`), { statusCode: 502 }));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(Object.assign(new Error("gog_gmail_invalid_json"), { statusCode: 502 }));
        }
      }
    });
  });
}

function header(headers = {}, key = "") {
  return clean(headers[key] || headers[key.toLowerCase()] || headers[key.toUpperCase()]);
}

function normalizeGogMessage(summary = {}, detail = {}) {
  const headers = detail.headers && typeof detail.headers === "object" ? detail.headers : {};
  const id = clean(summary.id || detail.id);
  return {
    id,
    threadId: clean(summary.threadId || detail.threadId || id),
    subject: clean(summary.subject || header(headers, "subject")),
    from: clean(summary.from || header(headers, "from")),
    to: clean(summary.to || header(headers, "to")),
    date: clean(summary.date || header(headers, "date")),
    snippet: clean(summary.snippet || detail.message).slice(0, 1000),
    text: clean(detail.body || summary.snippet || detail.message).slice(0, 20_000),
  };
}

async function collectGogJobMessages(input = {}, env = process.env) {
  const maxResults = intValue(input.maxResults ?? input.maxItemsPerRun ?? env.ORKESTR_JOBS_MAX_ITEMS_PER_RUN, defaultMaxItemsPerRun, 1, 250);
  const query = jobsQuery(input, env);
  const command = commandVector(input, env);
  const account = clean(input.gogAccount || input.account || env.ORKESTR_JOBS_GOG_ACCOUNT || env.GOG_ACCOUNT);
  const client = clean(input.gogClient || env.ORKESTR_JOBS_GOG_CLIENT || env.GOG_CLIENT) || defaultGogClient;
  const baseArgs = [...(account ? ["--account", account] : []), "--client", client, "--json", "--no-input"];
  const commandEnv = await gogEnv(input, env);
  const listed = await runJsonCommand(command, [...baseArgs, "gmail", "messages", "search", query, "--max", String(maxResults)], commandEnv, input);
  const summaries = Array.isArray(listed?.messages) ? listed.messages : Array.isArray(listed) ? listed : [];
  const messages = [];
  for (const summary of summaries.slice(0, maxResults)) {
    if (!summary?.id) continue;
    const detail = await runJsonCommand(command, [...baseArgs, "gmail", "get", String(summary.id), "--format", "full"], commandEnv, input);
    messages.push(normalizeGogMessage(summary, detail));
  }
  return {
    ownerUserId: ownerUserIdFor(input, null, env),
    source: "gog",
    query,
    maxResults,
    resultSizeEstimate: Number(listed?.resultSizeEstimate || messages.length) || messages.length,
    nextPageToken: clean(listed?.nextPageToken),
    messages,
  };
}

async function collectOAuthJobMessages(input = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const ownerUserId = ownerUserIdFor(input, options.principal || null, env);
  const maxResults = intValue(input.maxResults ?? input.maxItemsPerRun ?? env.ORKESTR_JOBS_MAX_ITEMS_PER_RUN, defaultMaxItemsPerRun, 1, 250);
  const query = jobsQuery(input, env);
  const gmailOptions = gmailScopeOptions(options.principal || null, ownerUserId);
  const listed = await listGmailMessages({ maxResults, query }, env, fetchImpl, gmailOptions);
  const messages = [];
  for (const message of listed.messages || []) {
    messages.push(await getGmailMessage(message.id, env, fetchImpl, gmailOptions));
  }
  return {
    ownerUserId,
    query,
    maxResults,
    resultSizeEstimate: listed.resultSizeEstimate || 0,
    nextPageToken: listed.nextPageToken || "",
    messages,
  };
}

export async function collectGmailJobMessages(input = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const source = lower(input.gmailSource || env.ORKESTR_JOBS_GMAIL_SOURCE || env.ORKESTR_GMAIL_SOURCE);
  if (source === "gog" || source === "host-native") return collectGogJobMessages(input, env);
  try {
    return await collectOAuthJobMessages(input, env, fetchImpl, options);
  } catch (error) {
    if (error?.connectorState === "reauth_required") throw error;
    const fallbackEnabled = input.gogFallback !== false && env.ORKESTR_JOBS_GOG_FALLBACK !== "0";
    if (source === "oauth" || !fallbackEnabled) throw error;
    const collected = await collectGogJobMessages(input, env);
    return { ...collected, oauthError: clean(error?.message || error).slice(0, 500) };
  }
}

export async function runGmailJobsPoll(input = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const collected = await collectGmailJobMessages(input, env, fetchImpl, options);
  const shouldPresent = input.present === undefined ? truthy(env.ORKESTR_JOBS_POST_NEW, true) : input.present !== false;
  const result = await processJobCandidateMessages({
    ...input,
    ownerUserId: collected.ownerUserId,
    targetThreadId: jobsTargetThreadId(input, env),
    maxResults: collected.maxResults,
    present: shouldPresent,
  }, collected.messages, env, options);
  await appendEvent({
    type: "jobs_gmail_poll_run",
    ownerUserId: collected.ownerUserId,
    query: collected.query,
    collected: collected.messages.length,
    created: result.upserted.created.length,
    duplicates: result.upserted.duplicates.length,
    classified: result.classified.classified.length,
    presented: result.presentation.presented?.length || 0,
  }, env).catch(() => {});
  return {
    ...result,
    query: collected.query,
    resultSizeEstimate: collected.resultSizeEstimate,
    nextPageToken: collected.nextPageToken,
  };
}

export async function runGmailJobsPollForPrincipal(input = {}, principal, env = process.env, fetchImpl = fetch, options = {}) {
  const ownerUserId = ownerUserIdFor(input, principal, env);
  if (!isAdminPrincipal(principal) && !ownerUserId) throw policyError("jobs_queue_owner_required", 403);
  return runGmailJobsPoll({ ...input, ownerUserId }, env, fetchImpl, { ...options, principal });
}

export async function runDueGmailJobsAutomation(env = process.env, now = new Date(), fetchImpl = fetch) {
  if (!jobsAutomationEnabled(env)) return [];
  const settings = await readJobsQueueSettings(env);
  const pausedUntilMs = Date.parse(clean(settings?.pausedUntil));
  if (Number.isFinite(pausedUntilMs) && pausedUntilMs > now.getTime()) return [];
  const nextRunMs = Date.parse(clean(settings?.nextPollAt));
  if (Number.isFinite(nextRunMs) && nextRunMs > now.getTime()) return [];
  const intervalMs = parseIntervalMs(env.ORKESTR_JOBS_POLL_INTERVAL_MS || env.ORKESTR_JOBS_POLL_INTERVAL || "10m", defaultPollIntervalMs);
  try {
    const result = await runGmailJobsPoll({
      ownerUserId: normalizeUserId(env.ORKESTR_JOBS_OWNER_USER_ID || env.ORKESTR_ADMIN_USER_ID || adminUserId),
      targetThreadId: jobsTargetThreadId({}, env),
      maxResults: env.ORKESTR_JOBS_MAX_ITEMS_PER_RUN,
      fitThreshold: env.ORKESTR_JOBS_FIT_THRESHOLD,
      present: true,
    }, env, fetchImpl, { now });
    await updateJobsQueueSettings({
      lastPollAt: now.toISOString(),
      nextPollAt: new Date(now.getTime() + intervalMs).toISOString(),
      digestIntervalMs: parseIntervalMs(env.ORKESTR_JOBS_DIGEST_INTERVAL_MS || "2h", defaultDigestIntervalMs),
      lastError: "",
      lastErrorAt: "",
      blockedReason: "",
      connectorState: "",
    }, env);
    return [result];
  } catch (error) {
    const lastError = clean(error?.message || error).slice(0, 500);
    await updateJobsQueueSettings({
      lastPollAt: now.toISOString(),
      nextPollAt: new Date(now.getTime() + intervalMs).toISOString(),
      lastError,
      lastErrorAt: now.toISOString(),
      blockedReason: error?.connectorState === "reauth_required" ? "blocked_auth" : "",
      connectorState: clean(error?.connectorState),
    }, env);
    await appendEvent({
      type: "jobs_gmail_poll_failed",
      error: lastError,
      blockedReason: error?.connectorState === "reauth_required" ? "blocked_auth" : undefined,
      connectorState: clean(error?.connectorState) || undefined,
    }, env).catch(() => {});
    return [{
      ok: false,
      error: lastError,
      blockedReason: error?.connectorState === "reauth_required" ? "blocked_auth" : "",
      connectorState: clean(error?.connectorState),
    }];
  }
}
