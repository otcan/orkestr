#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;

function clean(value = "") {
  return String(value || "").trim();
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function csv(value = "") {
  return [...new Set(clean(value).split(",").map(clean).filter(Boolean))];
}

export function parseDurationMs(value, fallbackMs) {
  const text = clean(value).toLowerCase();
  if (!text) return fallbackMs;
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) return fallbackMs;
  const factors = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(Number(match[1]) * factors[match[2]]);
}

function numberValue(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function lifecycleConfig(env = process.env) {
  return {
    enforce: truthy(env.ORKESTR_RESOURCE_LIFECYCLE_ENFORCE),
    browserctlPath: clean(env.ORKESTR_RESOURCE_LIFECYCLE_BROWSERCTL_PATH || "/usr/local/bin/browserctl"),
    orkestrPath: clean(env.ORKESTR_RESOURCE_LIFECYCLE_ORKESTR_PATH || "/usr/local/bin/orkestr"),
    kubectlPath: clean(env.ORKESTR_RESOURCE_LIFECYCLE_KUBECTL_PATH || "kubectl"),
    crictlPath: clean(env.ORKESTR_RESOURCE_LIFECYCLE_CRICTL_PATH || "crictl"),
    stateDir: clean(env.ORKESTR_RESOURCE_LIFECYCLE_STATE_DIR || "/var/lib/orkestr-resource-lifecycle"),
    tabCleanupEnabled: env.ORKESTR_RESOURCE_LIFECYCLE_TAB_CLEANUP_ENABLED !== "0",
    tabMaxAgeMs: parseDurationMs(env.ORKESTR_RESOURCE_LIFECYCLE_TAB_MAX_AGE, 2 * 3_600_000),
    tabMaxCount: numberValue(env.ORKESTR_RESOURCE_LIFECYCLE_TAB_MAX_COUNT, 8, { min: 2, max: 100 }),
    tabMinKeep: numberValue(env.ORKESTR_RESOURCE_LIFECYCLE_TAB_MIN_KEEP, 2, { min: 1, max: 20 }),
    tabMaxClosePerRun: numberValue(env.ORKESTR_RESOURCE_LIFECYCLE_TAB_MAX_CLOSE_PER_RUN, 3, { min: 1, max: 20 }),
    protectedUrlPatterns: csv(env.ORKESTR_RESOURCE_LIFECYCLE_PROTECTED_URL_PATTERNS).length
      ? csv(env.ORKESTR_RESOURCE_LIFECYCLE_PROTECTED_URL_PATTERNS)
      : [
          "^chrome:",
          "^devtools:",
          "linkedin\\.com/(feed|sales/home)",
          "accounts\\.google\\.com",
          "/setup/pairing",
          "orkestr\\.(de|app)",
        ],
    browserRestartEnabled: env.ORKESTR_RESOURCE_LIFECYCLE_BROWSER_RESTART_ENABLED !== "0",
    browserRestartRssBytes: numberValue(env.ORKESTR_RESOURCE_LIFECYCLE_BROWSER_RESTART_RSS_GIB, 8, { min: 1, max: 128 }) * GIB,
    browserRestartUptimeMs: parseDurationMs(env.ORKESTR_RESOURCE_LIFECYCLE_BROWSER_RESTART_UPTIME, 7 * 24 * 3_600_000),
    browserRestartMinIntervalMs: parseDurationMs(env.ORKESTR_RESOURCE_LIFECYCLE_BROWSER_RESTART_MIN_INTERVAL, 6 * 3_600_000),
    maxDesktopActionsPerRun: numberValue(env.ORKESTR_RESOURCE_LIFECYCLE_MAX_DESKTOP_ACTIONS_PER_RUN, 1, { min: 1, max: 20 }),
    desktopIdleStopEnabled: env.ORKESTR_RESOURCE_LIFECYCLE_DESKTOP_STOP_ENABLED !== "0",
    desktopIdleStopMs: parseDurationMs(env.ORKESTR_RESOURCE_LIFECYCLE_DESKTOP_IDLE_STOP, 30 * 60_000),
    transientDesktopSlugs: new Set(csv(env.ORKESTR_RESOURCE_LIFECYCLE_TRANSIENT_DESKTOPS || [
      "android-emulator",
      "wa-windows",
      "ppt",
      "synbiobeta",
      "synbiobeta-murat",
      "sosv-physical-ai",
      "wa-voice",
      "jobseeker-can",
    ].join(","))),
    desktopVmSlugs: new Set(csv(env.ORKESTR_RESOURCE_LIFECYCLE_DESKTOP_VMS || "android-emulator,wa-windows")),
    fullInstanceStopEnabled: truthy(env.ORKESTR_RESOURCE_LIFECYCLE_INSTANCE_STOP_ENABLED),
    orphanCleanupEnabled: env.ORKESTR_RESOURCE_LIFECYCLE_ORPHAN_CLEANUP_ENABLED !== "0",
    orphanGraceMs: parseDurationMs(env.ORKESTR_RESOURCE_LIFECYCLE_ORPHAN_GRACE, 15 * 60_000),
    orphanMinObservations: numberValue(env.ORKESTR_RESOURCE_LIFECYCLE_ORPHAN_MIN_OBSERVATIONS, 3, { min: 2, max: 100 }),
    healthStaleMs: parseDurationMs(env.ORKESTR_RESOURCE_LIFECYCLE_HEALTH_STALE_AFTER, 12 * 60_000),
    alertCommand: clean(env.ORKESTR_RESOURCE_LIFECYCLE_ALERT_COMMAND || "/usr/local/sbin/orkestr-restart-watch"),
  };
}

export function classifyDesktop(session = {}, config = lifecycleConfig({})) {
  const slug = clean(session.slug || session.id).toLowerCase();
  const type = clean(session.type).toLowerCase();
  if (config.desktopVmSlugs.has(slug) || /windows\s+11\s+vm|android emulator/i.test(clean(session.notes))) return "desktop_vm";
  if (type === "desktop" && session.managed !== false) return "host_browser_desktop";
  if (type === "desktop") return "host_browser_desktop";
  if (type === "service") return "service_browser";
  return "unmanaged";
}

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function timestamp(value) {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function hash(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function protectedUrl(url, patterns = []) {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(String(url || ""));
    } catch {
      return false;
    }
  });
}

export function trackTabsAndPlan(priorTabs = {}, observedTabs = [], options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const maxAgeMs = Number(options.maxAgeMs || 2 * 3_600_000);
  const maxCount = Number(options.maxCount || 8);
  const minKeep = Number(options.minKeep || 2);
  const maxClose = Number(options.maxClose || 3);
  const patterns = options.protectedUrlPatterns || [];
  const tracked = {};
  const normalized = observedTabs
    .filter((tab) => clean(tab.id) && clean(tab.type || "page") === "page")
    .map((tab) => {
      const id = clean(tab.id);
      const url = clean(tab.url);
      const prior = priorTabs[id] || {};
      const urlHash = hash(url);
      const sameNavigation = prior.urlHash === urlHash;
      const firstSeenAt = sameNavigation && timestamp(prior.firstSeenAt) ? prior.firstSeenAt : iso(nowMs);
      const item = {
        id,
        firstSeenAt,
        lastSeenAt: iso(nowMs),
        urlHash,
        active: tab.active === true,
        activityKnown: tab.activityKnown === true,
        protected: protectedUrl(url, patterns),
      };
      tracked[id] = {
        firstSeenAt: item.firstSeenAt,
        lastSeenAt: item.lastSeenAt,
        urlHash: item.urlHash,
      };
      return item;
    });
  if (options.desktopActive || options.cleanupEnabled === false || normalized.length <= minKeep) {
    return { tracked, closeIds: [], observedCount: normalized.length };
  }
  const candidates = normalized
    .filter((tab) => !tab.protected && tab.activityKnown && !tab.active)
    .filter((tab) => nowMs - timestamp(tab.firstSeenAt) >= maxAgeMs)
    .sort((left, right) => timestamp(left.firstSeenAt) - timestamp(right.firstSeenAt));
  const agedAllowance = Math.max(0, normalized.length - minKeep);
  const overflow = Math.max(0, normalized.length - maxCount);
  const desired = Math.max(overflow, candidates.length ? Math.min(candidates.length, agedAllowance) : 0);
  const closeIds = candidates.slice(0, Math.min(maxClose, desired, agedAllowance)).map((tab) => tab.id);
  for (const id of closeIds) delete tracked[id];
  return { tracked, closeIds, observedCount: normalized.length };
}

export function evaluateDesktopPolicy(input = {}, config = lifecycleConfig({})) {
  const nowMs = Number(input.nowMs || Date.now());
  const prior = input.prior || {};
  const active = input.leaseActive === true || input.connectionActive === true;
  const lastInteractiveAt = active ? iso(nowMs) : prior.lastInteractiveAt || iso(nowMs);
  const idleMs = Math.max(0, nowMs - timestamp(lastInteractiveAt));
  const resourceClass = input.resourceClass || classifyDesktop(input.session, config);
  const transient = config.transientDesktopSlugs.has(clean(input.session?.slug).toLowerCase());
  const running = ["active", "running"].includes(clean(input.session?.status || input.session?.state).toLowerCase());
  const observedBefore = timestamp(prior.firstObservedAt) > 0;
  let action = "none";
  let reason = active ? "active" : "within_policy";
  if (running && !active && transient && config.desktopIdleStopEnabled && idleMs >= config.desktopIdleStopMs) {
    action = "stop";
    reason = "idle_timeout";
  } else if (
    running &&
    !active &&
    observedBefore &&
    resourceClass === "host_browser_desktop" &&
    config.browserRestartEnabled &&
    nowMs - timestamp(prior.lastRestartAt) >= config.browserRestartMinIntervalMs &&
    (Number(input.rssBytes || 0) >= config.browserRestartRssBytes || Number(input.uptimeMs || 0) >= config.browserRestartUptimeMs)
  ) {
    action = "restart";
    reason = Number(input.rssBytes || 0) >= config.browserRestartRssBytes ? "rss_limit" : "uptime_limit";
  }
  return { action, reason, active, idleMs, lastInteractiveAt, resourceClass };
}

export function observeOrphanRuntime(prior = {}, runtime = {}, input = {}, config = lifecycleConfig({})) {
  const nowMs = Number(input.nowMs || Date.now());
  const unmatched = input.apiResourceExists !== true;
  const reachable = input.instanceReachable === true;
  const firstObservedAt = unmatched ? prior.firstObservedAt || iso(nowMs) : null;
  const observations = unmatched ? Number(prior.observations || 0) + 1 : 0;
  const ageMs = firstObservedAt ? Math.max(0, nowMs - timestamp(firstObservedAt)) : 0;
  const cleanupEligible = unmatched && !reachable && observations >= config.orphanMinObservations && ageMs >= config.orphanGraceMs;
  return {
    id: clean(runtime.id),
    namespace: clean(runtime.namespace),
    name: clean(runtime.name),
    vmName: clean(runtime.vmName),
    firstObservedAt,
    lastObservedAt: iso(nowMs),
    observations,
    apiResourceExists: !unmatched,
    instanceReachable: reachable,
    cleanupEligible,
    action: cleanupEligible && config.orphanCleanupEnabled ? "cleanup" : "none",
    reason: !unmatched ? "api_managed" : reachable ? "reachable_instance_protected" : cleanupEligible ? "orphan_confirmed" : "orphan_grace",
  };
}

export function lifecycleHealth(state = {}, nowMs = Date.now(), staleMs = 12 * 60_000) {
  const lastSuccessMs = timestamp(state.lastSuccessAt);
  const ageMs = lastSuccessMs ? Math.max(0, nowMs - lastSuccessMs) : Number.POSITIVE_INFINITY;
  const stale = !lastSuccessMs || ageMs > staleMs || state.lastRun?.ok === false;
  return {
    ok: !stale,
    stale,
    ageMs,
    reason: !lastSuccessMs ? "never_succeeded" : state.lastRun?.ok === false ? "last_run_failed" : stale ? "heartbeat_stale" : "healthy",
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function commandJson(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs || 30_000,
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    env: options.env || process.env,
  });
  return JSON.parse(result.stdout);
}

async function commandText(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs || 30_000,
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    env: options.env || process.env,
  });
  return result.stdout;
}

function activeLeaseMap(payload = {}, nowMs = Date.now()) {
  const leases = Array.isArray(payload.desktopLeases) ? payload.desktopLeases : [];
  const result = new Map();
  for (const lease of leases) {
    const slug = clean(lease.desktopSlug || lease.slug).toLowerCase();
    const expiresAt = timestamp(lease.expiresAt);
    if (!slug || lease.releasedAt || (expiresAt && expiresAt <= nowMs)) continue;
    result.set(slug, lease);
  }
  return result;
}

function parsePort(value = "") {
  const match = clean(value).match(/:(\d+)$/);
  return match ? Number(match[1]) : 0;
}

async function establishedPorts() {
  const text = await commandText("ss", ["-Htn", "state", "established"], { timeoutMs: 10_000 }).catch(() => "");
  const ports = new Set();
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(/:(\d+)\b/g)) ports.add(Number(match[1]));
  }
  return ports;
}

function parseUptimeMs(value = "") {
  const match = clean(value).match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return 0;
  return (((Number(match[1] || 0) * 24 + Number(match[2] || 0)) * 60 + Number(match[3] || 0)) * 60 + Number(match[4] || 0)) * 1000;
}

async function processTreeRssBytes(rootPid) {
  const root = Number(rootPid || 0);
  if (!Number.isInteger(root) || root <= 0) return 0;
  const procEntries = await fs.readdir("/proc").catch(() => []);
  const rows = [];
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const status = await fs.readFile(`/proc/${entry}/status`, "utf8").catch(() => "");
    if (!status) continue;
    const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] || 0);
    const rssKiB = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0);
    rows.push({ pid: Number(entry), ppid, rssKiB });
  }
  const descendants = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => descendants.has(row.pid)).reduce((sum, row) => sum + row.rssKiB * 1024, 0);
}

async function cdpActivity(tab, timeoutMs = 1_200) {
  if (!tab.webSocketDebuggerUrl || typeof WebSocket !== "function") return { activityKnown: false, active: false };
  return new Promise((resolve) => {
    const socket = new WebSocket(tab.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.close();
      resolve({ activityKnown: false, active: false });
    }, timeoutMs);
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: "Boolean(document.hasFocus()) || document.visibilityState === 'visible'", returnByValue: true },
    })));
    socket.addEventListener("message", (event) => {
      let payload = null;
      try { payload = JSON.parse(String(event.data || "")); } catch {}
      if (payload?.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      resolve({ activityKnown: true, active: payload?.result?.result?.value === true });
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      resolve({ activityKnown: false, active: false });
    });
  });
}

async function desktopTabs(session) {
  const cdpBase = clean(session.cdp_url || session.cdpUrl || session.localControl?.cdpUrl);
  if (!cdpBase || session.cdp_ok === false) return { cdpBase, tabs: [] };
  const response = await fetch(new URL("/json/list", cdpBase), { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`cdp_list_failed_${response.status}`);
  const targets = await response.json();
  const pages = (Array.isArray(targets) ? targets : []).filter((target) => target.type === "page");
  const activity = await Promise.all(pages.map((tab) => cdpActivity(tab)));
  return {
    cdpBase,
    tabs: pages.map((tab, index) => ({ id: tab.id, type: tab.type, url: tab.url, ...activity[index] })),
  };
}

async function closeCdpTab(cdpBase, targetId) {
  const response = await fetch(new URL(`/json/close/${encodeURIComponent(targetId)}`, cdpBase), {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`cdp_close_failed_${response.status}`);
}

async function browserInventory(config) {
  const payload = await commandJson(config.browserctlPath, ["list", "--json"]);
  return Array.isArray(payload.sessions) ? payload.sessions : Array.isArray(payload.desktops) ? payload.desktops : [];
}

function runtimeFromSandbox(item = {}) {
  return {
    id: clean(item.id),
    namespace: clean(item.metadata?.namespace || item.labels?.["io.kubernetes.pod.namespace"]),
    name: clean(item.metadata?.name || item.labels?.["io.kubernetes.pod.name"]),
    uid: clean(item.metadata?.uid || item.labels?.["io.kubernetes.pod.uid"]),
    vmName: clean(item.labels?.["vm.kubevirt.io/name"] || item.labels?.["vmi.kubevirt.io/id"] || item.labels?.app),
    state: clean(item.state),
  };
}

async function instanceInventory(config) {
  const [instancesPayload, slicesPayload, podsPayload, vmisPayload, sandboxesPayload] = await Promise.all([
    commandJson(config.orkestrPath, ["instances", "--probe", "--json"], { timeoutMs: 90_000 }),
    commandJson(config.orkestrPath, ["vm-slice", "list", "--json"], { timeoutMs: 30_000 }),
    commandJson(config.kubectlPath, ["get", "pods", "-A", "-o", "json"], { timeoutMs: 30_000 }),
    commandJson(config.kubectlPath, ["get", "vmi", "-A", "-o", "json"], { timeoutMs: 30_000 }),
    commandJson(config.crictlPath, ["pods", "-o", "json"], { timeoutMs: 30_000 }),
  ]);
  return {
    instances: Array.isArray(instancesPayload.instances) ? instancesPayload.instances : [],
    slices: Array.isArray(slicesPayload.tenantSlices) ? slicesPayload.tenantSlices : [],
    pods: Array.isArray(podsPayload.items) ? podsPayload.items : [],
    vmis: Array.isArray(vmisPayload.items) ? vmisPayload.items : [],
    sandboxes: (Array.isArray(sandboxesPayload.items) ? sandboxesPayload.items : []).map(runtimeFromSandbox),
  };
}

function instanceReachability(inventory, vmName) {
  const expected = `vm-${clean(vmName)}`.toLowerCase();
  return inventory.instances.some((instance) => clean(instance.id).toLowerCase() === expected && clean(instance.status).toLowerCase() === "running");
}

function apiRuntimeExists(inventory, runtime) {
  return inventory.pods.some((pod) => clean(pod.metadata?.uid) === runtime.uid || (
    clean(pod.metadata?.namespace) === runtime.namespace && clean(pod.metadata?.name) === runtime.name
  )) || inventory.vmis.some((vmi) => clean(vmi.metadata?.namespace) === runtime.namespace && clean(vmi.metadata?.name) === runtime.vmName);
}

async function runLifecycle(env = process.env) {
  const config = lifecycleConfig(env);
  const statePath = path.join(config.stateDir, "state.json");
  const prior = await readJson(statePath, { version: 1, desktops: {}, orphans: {} });
  const nowMs = Date.now();
  const state = {
    ...prior,
    version: 1,
    lastStartedAt: iso(nowMs),
    lastRun: { ok: null, status: "running", startedAt: iso(nowMs), completedAt: null, actions: [], warnings: [], errors: [] },
  };
  await writeJsonAtomic(statePath, state);
  try {
    const [desktops, leasesPayload, ports] = await Promise.all([
      browserInventory(config),
      readJson(path.join(clean(env.ORKESTR_HOME || "/var/lib/orkestr"), "desktop-leases.json"), { desktopLeases: [] }),
      establishedPorts(),
    ]);
    const leases = activeLeaseMap(leasesPayload, nowMs);
    const nextDesktops = {};
    let desktopActions = 0;
    for (const session of desktops) {
      const slug = clean(session.slug || session.id).toLowerCase();
      if (!slug || session.managed === false) continue;
      const priorDesktop = prior.desktops?.[slug] || {};
      const leaseActive = leases.has(slug) || session.leased === true;
      const connectionActive = ports.has(parsePort(session.upstream));
      const resourceClass = classifyDesktop(session, config);
      let tabs = { cdpBase: "", tabs: [] };
      try {
        tabs = await desktopTabs(session);
      } catch (error) {
        state.lastRun.warnings.push({ resource: slug, code: clean(error.message || error) });
      }
      const tabPlan = trackTabsAndPlan(priorDesktop.tabs || {}, tabs.tabs, {
        nowMs,
        maxAgeMs: config.tabMaxAgeMs,
        maxCount: config.tabMaxCount,
        minKeep: config.tabMinKeep,
        maxClose: config.tabMaxClosePerRun,
        protectedUrlPatterns: config.protectedUrlPatterns,
        desktopActive: leaseActive || connectionActive,
        cleanupEnabled: config.tabCleanupEnabled,
      });
      const rssBytes = await processTreeRssBytes(session.root_pid);
      const policy = evaluateDesktopPolicy({
        nowMs,
        prior: priorDesktop,
        session,
        leaseActive,
        connectionActive,
        rssBytes,
        uptimeMs: parseUptimeMs(session.uptime),
        resourceClass,
      }, config);
      const record = {
        resourceClass,
        status: clean(session.status || session.state),
        firstObservedAt: priorDesktop.firstObservedAt || iso(nowMs),
        lastObservedAt: iso(nowMs),
        lastInteractiveAt: policy.lastInteractiveAt,
        lastRestartAt: priorDesktop.lastRestartAt || null,
        rssBytes,
        tabCount: tabPlan.observedCount,
        tabs: tabPlan.tracked,
        policy: { action: policy.action, reason: policy.reason },
      };
      if (tabPlan.closeIds.length && tabs.cdpBase && config.enforce) {
        for (const targetId of tabPlan.closeIds) {
          await closeCdpTab(tabs.cdpBase, targetId).catch((error) => state.lastRun.errors.push({ resource: slug, action: "close_tab", code: clean(error.message || error) }));
        }
        state.lastRun.actions.push({ resource: slug, action: "close_tabs", count: tabPlan.closeIds.length });
      }
      const deferRestart = tabPlan.closeIds.length > 0;
      if (policy.action !== "none" && !deferRestart && config.enforce) {
        if (desktopActions >= config.maxDesktopActionsPerRun) {
          record.policy = { action: "deferred", reason: "per_run_action_limit", requestedAction: policy.action };
          state.lastRun.warnings.push({ resource: slug, code: "desktop_action_deferred_budget", action: policy.action });
        } else {
          await commandText(config.browserctlPath, [policy.action, slug], { timeoutMs: 120_000 });
          desktopActions += 1;
          state.lastRun.actions.push({ resource: slug, action: policy.action, reason: policy.reason });
          if (policy.action === "restart") record.lastRestartAt = iso(nowMs);
        }
      }
      nextDesktops[slug] = record;
    }
    state.desktops = nextDesktops;

    const inventory = await instanceInventory(config);
    const apiKeys = new Set(inventory.pods.map((pod) => `${clean(pod.metadata?.namespace)}/${clean(pod.metadata?.name)}`));
    const nextOrphans = {};
    for (const runtime of inventory.sandboxes.filter((item) => item.name.startsWith("virt-launcher-"))) {
      const priorRuntime = prior.orphans?.[runtime.id] || {};
      const observation = observeOrphanRuntime(priorRuntime, runtime, {
        nowMs,
        apiResourceExists: apiRuntimeExists(inventory, runtime),
        instanceReachable: instanceReachability(inventory, runtime.vmName),
      }, config);
      nextOrphans[runtime.id] = observation;
      if (!observation.apiResourceExists) {
        state.lastRun.warnings.push({
          resource: `${runtime.namespace}/${runtime.vmName}`,
          code: observation.reason,
          observations: observation.observations,
        });
      }
      if (observation.action === "cleanup" && config.enforce) {
        await commandText(config.crictlPath, ["stopp", runtime.id], { timeoutMs: 90_000 });
        await commandText(config.crictlPath, ["rmp", runtime.id], { timeoutMs: 90_000 });
        state.lastRun.actions.push({ resource: `${runtime.namespace}/${runtime.vmName}`, action: "cleanup_orphan_runtime" });
        delete nextOrphans[runtime.id];
      }
    }
    state.orphans = nextOrphans;
    state.instances = {
      observedAt: iso(nowMs),
      total: inventory.instances.length,
      running: inventory.instances.filter((item) => clean(item.status).toLowerCase() === "running").length,
      slices: inventory.slices.length,
      apiPodCount: apiKeys.size,
      vmiCount: inventory.vmis.length,
      fullInstanceStopEnabled: config.fullInstanceStopEnabled,
      stopDecision: config.fullInstanceStopEnabled ? "blocked_missing_wake_contract" : "disabled_fail_closed",
    };
    state.lastRun.ok = state.lastRun.errors.length === 0;
  } catch (error) {
    state.lastRun.errors.push({ resource: "controller", code: clean(error.message || error) || "resource_lifecycle_failed" });
    state.lastRun.ok = false;
  }
  const completedAt = Date.now();
  state.lastRun.completedAt = iso(completedAt);
  state.lastRun.status = "completed";
  state.lastCompletedAt = state.lastRun.completedAt;
  if (state.lastRun.ok) state.lastSuccessAt = state.lastRun.completedAt;
  await writeJsonAtomic(statePath, state);
  process.stdout.write(`${JSON.stringify({
    ok: state.lastRun.ok,
    enforce: config.enforce,
    actions: state.lastRun.actions,
    warnings: state.lastRun.warnings.length,
    errors: state.lastRun.errors,
    completedAt: state.lastCompletedAt,
  })}\n`);
  if (!state.lastRun.ok) process.exitCode = 1;
}

async function sendHealthAlert(config, health, healthState) {
  const bodyPath = path.join(config.stateDir, "health-alert.txt");
  const subject = `[${os.hostname()}] resource lifecycle watchdog ${health.stale ? "stale" : "recovered"}`;
  const body = [
    `Orkestr resource lifecycle watchdog on ${os.hostname()}`,
    "",
    `Status: ${health.stale ? "stale" : "healthy"}`,
    `Reason: ${health.reason}`,
    `Last successful run age: ${Number.isFinite(health.ageMs) ? Math.round(health.ageMs / 1000) : "unknown"} seconds`,
    `Checked at: ${iso()}`,
  ].join("\n");
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(bodyPath, `${body}\n`, { mode: 0o600 });
  await commandText(config.alertCommand, ["--send-alert", subject, bodyPath], { timeoutMs: 90_000 });
  return { ...healthState, lastAlertAt: iso(), lastAlertLevel: health.stale ? "stale" : "healthy" };
}

async function runHealth(env = process.env) {
  const config = lifecycleConfig(env);
  const state = await readJson(path.join(config.stateDir, "state.json"), {});
  let healthState = await readJson(path.join(config.stateDir, "health.json"), {});
  const health = lifecycleHealth(state, Date.now(), config.healthStaleMs);
  const level = health.stale ? "stale" : "healthy";
  const shouldAlert = health.stale
    ? healthState.lastAlertLevel !== "stale"
    : healthState.lastAlertLevel === "stale";
  if (shouldAlert) {
    try {
      healthState = await sendHealthAlert(config, health, healthState);
    } catch (error) {
      healthState.lastAlertError = clean(error.message || error);
      if (health.stale) process.exitCode = 1;
    }
  }
  healthState = { ...healthState, level, checkedAt: iso(), reason: health.reason, ageMs: health.ageMs };
  await writeJsonAtomic(path.join(config.stateDir, "health.json"), healthState);
  process.stdout.write(`${JSON.stringify({ ok: health.ok, ...health })}\n`);
  if (!health.ok) process.exitCode = 1;
}

async function main() {
  const command = clean(process.argv[2] || "run").toLowerCase();
  if (command === "run") return runLifecycle();
  if (command === "health") return runHealth();
  throw new Error("Usage: resource-lifecycle-watchdog.mjs [run|health]");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${clean(error.message || error) || "resource_lifecycle_failed"}\n`);
    process.exitCode = 1;
  });
}
