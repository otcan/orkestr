#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { listBrowserSessions } from "../packages/browsers/src/browsers.js";
import { readRuntimeSettings } from "../packages/core/src/runtime-settings.js";
import { dataPaths, ensureDataDirs } from "../packages/storage/src/paths.js";
import { readJson } from "../packages/storage/src/store.js";

function clean(value = "") {
  return String(value || "").trim();
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function csv(value = "") {
  return clean(value)
    .split(/[,\n]/)
    .map((item) => clean(item).toLowerCase())
    .filter(Boolean);
}

function defaultForbiddenNames() {
  return [
    "linkedin",
    "firat-linkedin",
    "kdp-auth",
    "magie-meta",
    "ppt",
    "synbiobeta",
    "synbiobeta-murat",
    "android-emulator",
    "sosv-physical-ai",
  ];
}

function redactForScan(value) {
  return JSON.stringify(value || {}, (key, item) => {
    const lowered = String(key || "").toLowerCase();
    if (/(token|secret|password|key|credential|cookie)/.test(lowered)) return "[redacted]";
    return item;
  });
}

function pathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function safeReadJson(filePath, fallback) {
  return readJson(filePath, fallback).catch(() => fallback);
}

async function exists(filePath) {
  return fs.stat(filePath).then(() => true, () => false);
}

function addCheck(checks, name, ok, details = {}) {
  checks.push({ name, ok: Boolean(ok), ...details });
}

async function readPublicState(paths, env) {
  return {
    runtimeSettings: await readRuntimeSettings(env).catch(() => ({})),
    config: await safeReadJson(paths.config, {}),
    users: await safeReadJson(paths.users, []),
    threads: await safeReadJson(paths.threads, []),
    tenantVms: await safeReadJson(paths.tenantVms, []),
    desktopLeases: await safeReadJson(paths.desktopLeases, {}),
    brokerInstancesJsonExists: await exists(paths.brokerInstances),
    brokerInstancesSqliteExists: await exists(paths.brokerInstancesDb),
  };
}

export async function auditIsolatedDemoInstance(env = process.env, options = {}) {
  const paths = await ensureDataDirs(env);
  const home = paths.home;
  const checks = [];
  const forbiddenNames = csv(env.ORKESTR_ISOLATION_FORBIDDEN_NAMES).length
    ? csv(env.ORKESTR_ISOLATION_FORBIDDEN_NAMES)
    : defaultForbiddenNames();
  const forbiddenRoots = csv(env.ORKESTR_ISOLATION_FORBIDDEN_ROOTS);
  const state = await readPublicState(paths, env);

  for (const [name, value] of Object.entries({
    browsers: paths.browsers,
    files: paths.files,
    messages: paths.messages,
    oauth: paths.oauth,
    userDataRoot: paths.userDataRoot,
    threadMessages: paths.threadMessages,
    workspaces: paths.workspaces,
    runtimeSettings: paths.runtimeSettings,
    desktopLeases: paths.desktopLeases,
    brokerInstancesDb: paths.brokerInstancesDb,
  })) {
    addCheck(checks, `path:${name}:inside-home`, pathInside(value, home), { path: value });
  }

  for (const root of forbiddenRoots) {
    if (!root) continue;
    addCheck(checks, `home:not-inside-forbidden-root:${root}`, !pathInside(home, root), { home });
  }

  const scanned = redactForScan(state).toLowerCase();
  const leaks = forbiddenNames.filter((name) => scanned.includes(name));
  addCheck(checks, "state:no-forbidden-parent-names", leaks.length === 0, { forbiddenMatches: leaks });

  const browserResult = await listBrowserSessions(env).catch((error) => ({
    ok: false,
    source: "audit",
    error: clean(error?.message || String(error)),
    sessions: [],
  }));
  const browserSessions = Array.isArray(browserResult.sessions) ? browserResult.sessions : [];
  const browserText = redactForScan(browserSessions).toLowerCase();
  const browserLeaks = forbiddenNames.filter((name) => browserText.includes(name));
  addCheck(checks, "desktops:no-parent-session-names", browserLeaks.length === 0, {
    error: browserResult.error || "",
    sessions: browserSessions.length,
    forbiddenMatches: browserLeaks,
  });

  if (clean(env.ORKESTR_INSTANCE_DESKTOPS_PROVISIONED).toLowerCase() === "0") {
    addCheck(checks, "desktops:unprovisioned-fails-closed", browserResult.ok === false && browserSessions.length === 0, {
      error: browserResult.error || "",
    });
  }

  if (truthy(env.ORKESTR_ISOLATION_EXPECT_SQLITE_BROKER)) {
    addCheck(checks, "broker:sqlite-registry-present", state.brokerInstancesSqliteExists === true, {
      jsonRegistryPresent: state.brokerInstancesJsonExists,
    });
  }

  const expectedInstanceId = clean(options.expectedInstanceId || env.ORKESTR_ISOLATION_EXPECT_INSTANCE_ID);
  if (expectedInstanceId) {
    const runtimeText = redactForScan(state.runtimeSettings);
    addCheck(checks, "instance:expected-id-not-empty", Boolean(expectedInstanceId), {
      instanceId: expectedInstanceId,
      runtimeMentionsInstanceId: runtimeText.includes(expectedInstanceId),
    });
  }

  const failed = checks.filter((check) => !check.ok);
  return {
    ok: failed.length === 0,
    home,
    generatedAt: new Date().toISOString(),
    summary: {
      checks: checks.length,
      failed: failed.length,
      browserSessions: browserSessions.length,
      forbiddenNames,
    },
    checks,
  };
}

async function main() {
  const result = await auditIsolatedDemoInstance();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: clean(error?.message || String(error)) }));
    process.exit(1);
  });
}
