import fs from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { dataPaths, ensureDataDirs, userDataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { isAdminPrincipal } from "../../core/src/policy.js";
import { desktopCatalogFromEnv } from "../../core/src/runtime-settings.js";
import { normalizeUserId } from "../../core/src/users.js";
import { attachDesktopStateToSessions } from "./desktop-leases.js";
import { isBrowserctlUnavailableError, listManagedDesktopSessions, managedDesktopAction, managedDesktopOpenUrl } from "./browserctl.js";

const execFileAsync = promisify(execFile);

function desktopMode(env = process.env) {
  const configured = String(env.ORKESTR_BROWSER_DESKTOP_MODE || "").trim().toLowerCase();
  if (configured) return configured;
  if (
    String(env.ORKESTR_BROWSERCTL_PATH || env.ORKESTR_BROWSERCTL || "").trim() ||
    String(env.ORKESTR_BROWSER_API_URL || env.ORKESTR_BROWSER_SESSIONS_URL || "").trim()
  ) {
    return "browserctl";
  }
  return "profiles";
}

function boolEnv(value, fallback = null) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function desktopUnavailableState(env = process.env) {
  const mode = desktopMode(env);
  if (["disabled", "none", "off"].includes(mode)) {
    return {
      error: "instance_desktops_disabled",
      message: "Managed Desktop is disabled for this Orkestr instance.",
    };
  }
  if (boolEnv(env.ORKESTR_INSTANCE_DESKTOPS_PROVISIONED, null) === false) {
    return {
      error: "instance_desktops_not_provisioned",
      message: "Managed Desktop is not provisioned for this Orkestr instance yet.",
    };
  }
  return null;
}

function desktopUnavailableError(env = process.env) {
  const state = desktopUnavailableState(env);
  if (!state) return null;
  const error = new Error(state.error);
  error.statusCode = state.error === "instance_desktops_disabled" ? 403 : 409;
  error.message = state.error;
  error.publicMessage = state.message;
  return error;
}

function profileFallbackAllowed(env = process.env) {
  const configured = String(env.ORKESTR_BROWSER_PROFILE_FALLBACK || "").trim().toLowerCase();
  if (["1", "true", "yes"].includes(configured)) return true;
  if (["0", "false", "no"].includes(configured)) return false;
  if (desktopMode(env) === "profiles") return true;
  if (desktopMode(env) === "browserctl") return false;
  return true;
}

function shouldFallbackAfterBrowserctlError(error, env = process.env) {
  return profileFallbackAllowed(env) && isBrowserctlUnavailableError(error);
}

function normalizeBrowserOpenUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    const error = new Error("browser_open_url_required");
    error.statusCode = 400;
    throw error;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const error = new Error("browser_open_url_invalid");
    error.statusCode = 400;
    throw error;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    const error = new Error("browser_open_url_unsupported_protocol");
    error.statusCode = 400;
    throw error;
  }
  return parsed.href;
}

export async function listBrowserSessions(env = process.env, options = {}) {
  const unavailable = desktopUnavailableState(env);
  if (unavailable) {
    return {
      ok: false,
      source: "instance",
      sessions: [],
      ...unavailable,
    };
  }
  if (desktopMode(env) !== "profiles") {
    try {
      const payload = await listManagedDesktopSessions(env, options);
      return { ...payload, sessions: filterVisibleBrowserSessions(payload.sessions || [], env) };
    } catch (error) {
      if (!shouldFallbackAfterBrowserctlError(error, env)) {
        return {
          ok: false,
          source: "browserctl",
          sessions: [],
          error: "browser_desktop_system_unavailable",
          message: error?.message || String(error),
        };
      }
    }
  }
  const sessions = await listProfileBrowsers(env, options);
  return { ok: true, source: "profiles", sessions };
}

export function filterVisibleBrowserSessions(sessions = [], env = process.env) {
  const configuredVisible = String(env.ORKESTR_BROWSER_VISIBLE_SLUGS || env.ORKESTR_OPS_DESKTOP_SLUGS || "").trim();
  if (!configuredVisible) return sessions;
  const visible = new Set(visibleBrowserCatalog(env).map((browser) => browser.slug));
  return sessions.filter((session) => visible.has(String(session?.slug || session?.id || "").trim()));
}

function visibleBrowserCatalog(env = process.env) {
  return desktopCatalogFromEnv(env)
    .filter((browser) => browser.enabled !== false)
    .map((browser) => ({
      slug: browser.slug,
      label: browser.label,
      purpose: browser.purpose || "",
      startUrl: browser.startUrl || "about:blank",
    }));
}

function fullBrowserCatalog(env = process.env) {
  return desktopCatalogFromEnv(env, {}, { includeHidden: true })
    .filter((browser) => browser.enabled !== false)
    .map((browser) => ({
      slug: browser.slug,
      label: browser.label,
      purpose: browser.purpose || "",
      startUrl: browser.startUrl || "about:blank",
    }));
}

function browserBySlug(slug, env = process.env) {
  const id = String(slug || "").trim();
  const browser = fullBrowserCatalog(env).find((item) => item.slug === id);
  if (!browser) {
    const error = new Error("browser_not_found");
    error.statusCode = 404;
    throw error;
  }
  return browser;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(command) {
  try {
    await execFileAsync(command, ["--version"], { timeout: 2500 });
    return true;
  } catch {
    return false;
  }
}

async function chromeCommand(env = process.env) {
  const configured = String(env.ORKESTR_CHROME_PATH || env.CHROME_PATH || "").trim();
  if (configured) return configured;
  for (const command of ["google-chrome", "chrome", "chromium", "chromium-browser"]) {
    if (await commandExists(command)) return command;
  }
  return "google-chrome";
}

function stableHash(text) {
  let hash = 0;
  for (const char of String(text || "")) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

export function browserScope(options = {}, env = process.env) {
  const principal = options?.principal || null;
  const personal = Boolean(principal?.userId && !isAdminPrincipal(principal));
  const ownerUserId = normalizeUserId(
    personal
      ? principal.userId
      : options?.ownerUserId || env.ORKESTR_ADMIN_USER_ID || "admin",
  );
  return {
    ownerUserId,
    personal,
    scope: personal ? "user" : "admin",
    scopeLabel: personal ? "Private user desktop" : "Local admin desktop",
    root: personal ? userDataPaths(ownerUserId, env).browsers : dataPaths(env).browsers,
    portOffset: personal ? (stableHash(ownerUserId) % 1000) * 16 : 0,
  };
}

function profileDir(slug, env = process.env, options = {}) {
  return `${browserScope(options, env).root}/${slug}`;
}

function browserIndex(slug, env = process.env) {
  return Math.max(0, fullBrowserCatalog(env).findIndex((browser) => browser.slug === slug));
}

function debugPortForSlug(slug, env = process.env, options = {}) {
  const base = Number(env.ORKESTR_BROWSER_DEBUG_PORT_BASE || 9222);
  const safeBase = Number.isFinite(base) && base > 0 ? base : 9222;
  return safeBase + browserScope(options, env).portOffset + browserIndex(slug, env);
}

function isPidRunning(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function findBrowserPidByProfile(dir) {
  const needle = `--user-data-dir=${dir}`;
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="], { timeout: 2500, maxBuffer: 2 * 1024 * 1024 });
    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const command = match[2] || "";
      if (pid !== process.pid && command.includes(needle)) return pid;
    }
  } catch {
    return null;
  }
  return null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isTcpPortOpen(port) {
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: parsed });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function readBrowserMetadata(slug, env = process.env, options = {}) {
  return readJson(`${profileDir(slug, env, options)}/browser.json`, {});
}

async function writeBrowserMetadata(slug, metadata, env = process.env, options = {}) {
  await writeJson(`${profileDir(slug, env, options)}/browser.json`, metadata);
}

async function publicBrowserRecord(browser, env = process.env, options = {}) {
  const scope = browserScope(options, env);
  const dir = profileDir(browser.slug, env, options);
  const metadata = await readBrowserMetadata(browser.slug, env, options);
  const configured = await pathExists(dir);
  const savedPid = Number(metadata.rootPid || metadata.pid || 0) || null;
  const detectedPid = savedPid && isPidRunning(savedPid) ? savedPid : configured ? await findBrowserPidByProfile(dir) : null;
  const rootPid = detectedPid || null;
  const running = !!rootPid;
  const debugPort = Number(metadata.debugPort || debugPortForSlug(browser.slug, env, options));
  const cdpUrl = configured && (running || metadata.lastOpenedAt) && debugPort ? `http://127.0.0.1:${debugPort}` : null;
  const cdpOk = running && debugPort ? await isTcpPortOpen(debugPort) : false;
  const status = running ? "running" : configured ? "prepared" : "not_prepared";
  return {
    ...browser,
    id: browser.slug,
    type: "desktop",
    access: "local",
    ownerUserId: scope.ownerUserId,
    scope: scope.scope,
    scopeLabel: scope.scopeLabel,
    personal: scope.personal,
    profileDir: dir,
    profile: dir,
    profile_path: dir,
    configured,
    status,
    state: status,
    url: browser.startUrl,
    desk_url: browser.startUrl.startsWith("http") ? browser.startUrl : null,
    cdp_url: cdpUrl,
    cdp_ok: cdpOk,
    owner_service: "orkestr-oss",
    root_pid: running ? rootPid : null,
    launchDisabled: metadata.launchDisabled === true,
    safe_cleanup: configured && !running,
    notes: browser.purpose,
    control: {
      prepare: true,
      start: true,
      stop: running,
      restart: configured,
      cleanup: configured && !running,
    },
    preparedAt: metadata.preparedAt || null,
    lastOpenedAt: metadata.lastOpenedAt || null,
    stoppedAt: metadata.stoppedAt || null,
    cleanedAt: metadata.cleanedAt || null,
    launchCommand: metadata.launchCommand || null,
    launchError: metadata.launchError || null,
    debugPort,
  };
}

async function listProfileBrowsers(env = process.env, options = {}) {
  await ensureDataDirs(env);
  const sessions = await Promise.all(visibleBrowserCatalog(env).map((browser) => publicBrowserRecord(browser, env, options)));
  return attachDesktopStateToSessions(sessions, env, options);
}

export async function listVirtualBrowsers(env = process.env, options = {}) {
  return (await listBrowserSessions(env, options)).sessions;
}

export function virtualBrowserReady(browser = null) {
  if (!browser) return false;
  const status = String(browser.status || browser.state || "").trim().toLowerCase();
  if (!["running", "active", "open"].includes(status)) return false;
  if (browser.readiness && typeof browser.readiness === "object" && browser.readiness.ok === false) return false;
  if (browser.visual_ok === false || browser.bridge_ok === false || browser.web_ok === false) return false;
  return true;
}

export async function ensureVirtualBrowserReady(slug, env = process.env, options = {}) {
  const id = String(slug || "").trim();
  const listed = await listBrowserSessions(env, options);
  const current = (listed.sessions || []).find((browser) => String(browser.slug || browser.id || "").trim() === id);
  if (!current) {
    const error = new Error("browser_session_not_found");
    error.statusCode = 404;
    throw error;
  }
  if (virtualBrowserReady(current)) return current;

  const recovered = await openVirtualBrowser(id, env, "", options);
  if (virtualBrowserReady(recovered)) return recovered;
  const reason = String(
    recovered?.readiness?.status || recovered?.launchError || recovered?.status || recovered?.state || "desktop_recovery_failed",
  ).trim() || "desktop_recovery_failed";
  const error = new Error(reason);
  error.statusCode = 503;
  throw error;
}

export async function prepareVirtualBrowser(slug, env = process.env, options = {}) {
  const unavailable = desktopUnavailableError(env);
  if (unavailable) throw unavailable;
  if (desktopMode(env) !== "profiles") {
    try {
      return await managedDesktopAction(slug, "prepare", env, options);
    } catch (error) {
      if (!shouldFallbackAfterBrowserctlError(error, env)) throw error;
    }
  }
  const browser = browserBySlug(slug, env);
  await ensureDataDirs(env);
  const scope = browserScope(options, env);
  const dir = profileDir(browser.slug, env, options);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const prior = await readBrowserMetadata(browser.slug, env, options);
  const preparedAt = prior.preparedAt || new Date().toISOString();
  await writeBrowserMetadata(browser.slug, {
    ...prior,
    slug: browser.slug,
    label: browser.label,
    type: "desktop",
    ownerUserId: scope.ownerUserId,
    scope: scope.scope,
    profileDir: dir,
    profile_path: dir,
    startUrl: browser.startUrl,
    debugPort: prior.debugPort || debugPortForSlug(browser.slug, env, options),
    preparedAt,
    updatedAt: new Date().toISOString(),
  }, env, options);
  await appendEvent({ type: "browser_prepared", browser: browser.slug, slug: browser.slug, profileDir: dir, ownerUserId: scope.ownerUserId }, env);
  return publicBrowserRecord(browser, env, options);
}

export async function openVirtualBrowser(slug, env = process.env, targetUrl = "", options = {}) {
  const unavailable = desktopUnavailableError(env);
  if (unavailable) throw unavailable;
  if (desktopMode(env) !== "profiles") {
    try {
      return await managedDesktopAction(slug, "start", env, options);
    } catch (error) {
      if (!shouldFallbackAfterBrowserctlError(error, env)) throw error;
    }
  }
  const browser = browserBySlug(slug, env);
  const prepared = await prepareVirtualBrowser(slug, env, options);
  const startUrl = String(targetUrl || browser.startUrl || "about:blank").trim();
  const launchDisabled = String(env.ORKESTR_BROWSER_LAUNCH_DISABLED || "").trim() === "1";
  const command = launchDisabled ? "" : await chromeCommand(env);
  let launched = false;
  let pid = null;
  let launchError = "";

  if (!launchDisabled && command) {
    try {
      const debugPort = prepared.debugPort || debugPortForSlug(browser.slug, env, options);
      const child = spawn(command, [
        `--user-data-dir=${prepared.profileDir}`,
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${debugPort}`,
        "--no-first-run",
        "--new-window",
        startUrl,
      ], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      launched = true;
      pid = child.pid || null;
    } catch (error) {
      launchError = error?.message || String(error);
    }
  }

  const openedAt = new Date().toISOString();
  await writeBrowserMetadata(browser.slug, {
    slug: browser.slug,
    label: browser.label,
    type: "desktop",
    profileDir: prepared.profileDir,
    profile_path: prepared.profileDir,
    startUrl,
    preparedAt: prepared.preparedAt || openedAt,
    lastOpenedAt: openedAt,
    launchCommand: command || null,
    launchDisabled,
    launchError: launchError || null,
    rootPid: pid,
    pid,
    ownerUserId: prepared.ownerUserId,
    scope: prepared.scope,
    debugPort: prepared.debugPort || debugPortForSlug(browser.slug, env, options),
  }, env, options);
  await appendEvent({ type: "browser_open_requested", browser: browser.slug, slug: browser.slug, launched, pid, profileDir: prepared.profileDir }, env);
  return {
    ...(await publicBrowserRecord(browser, env, options)),
    launched,
    pid,
    launchDisabled,
    launchError,
  };
}

export async function openUrlInVirtualBrowser(slug, url, env = process.env, options = {}) {
  const targetUrl = normalizeBrowserOpenUrl(url);
  const unavailable = desktopUnavailableError(env);
  if (unavailable) throw unavailable;
  if (desktopMode(env) !== "profiles") {
    try {
      return await managedDesktopOpenUrl(slug, targetUrl, env, options);
    } catch (error) {
      if (!shouldFallbackAfterBrowserctlError(error, env)) throw error;
    }
  }
  return {
    ...(await openVirtualBrowser(slug, env, targetUrl, options)),
    action: "open-url",
    openedUrl: targetUrl,
  };
}

export async function stopVirtualBrowser(slug, env = process.env, options = {}) {
  const unavailable = desktopUnavailableError(env);
  if (unavailable) throw unavailable;
  if (desktopMode(env) !== "profiles") {
    try {
      return await managedDesktopAction(slug, "stop", env, options);
    } catch (error) {
      if (!shouldFallbackAfterBrowserctlError(error, env)) throw error;
    }
  }
  const browser = browserBySlug(slug, env);
  const dir = profileDir(browser.slug, env, options);
  const configured = await pathExists(dir);
  const metadata = await readBrowserMetadata(browser.slug, env, options);
  const savedPid = Number(metadata.rootPid || metadata.pid || 0) || null;
  const pid = savedPid && isPidRunning(savedPid) ? savedPid : configured ? await findBrowserPidByProfile(dir) : null;
  let stopped = false;
  let stopError = "";

  if (pid && isPidRunning(pid)) {
    try {
      process.kill(pid, "SIGTERM");
      stopped = true;
      for (let attempt = 0; attempt < 10 && isPidRunning(pid); attempt += 1) {
        await wait(100);
      }
    } catch (error) {
      stopError = error?.message || String(error);
    }
  }

  if (configured) {
    await writeBrowserMetadata(browser.slug, {
      ...metadata,
      rootPid: null,
      pid: null,
      stoppedAt: new Date().toISOString(),
      stopError: stopError || null,
      updatedAt: new Date().toISOString(),
    }, env, options);
  }
  await appendEvent({ type: "browser_stop_requested", browser: browser.slug, slug: browser.slug, stopped, pid, stopError }, env);
  return {
    ...(await publicBrowserRecord(browser, env, options)),
    stopped,
    stopError,
  };
}

export async function restartVirtualBrowser(slug, env = process.env, options = {}) {
  const unavailable = desktopUnavailableError(env);
  if (unavailable) throw unavailable;
  if (desktopMode(env) !== "profiles") {
    try {
      return await managedDesktopAction(slug, "restart", env, options);
    } catch (error) {
      if (!shouldFallbackAfterBrowserctlError(error, env)) throw error;
    }
  }
  await stopVirtualBrowser(slug, env, options);
  return openVirtualBrowser(slug, env, "", options);
}

export async function cleanupVirtualBrowser(slug, env = process.env, options = {}) {
  const unavailable = desktopUnavailableError(env);
  if (unavailable) throw unavailable;
  if (desktopMode(env) !== "profiles") {
    try {
      return await managedDesktopAction(slug, "cleanup", env, options);
    } catch (error) {
      if (!shouldFallbackAfterBrowserctlError(error, env)) throw error;
    }
  }
  const browser = browserBySlug(slug, env);
  const current = await publicBrowserRecord(browser, env, options);
  if (current.root_pid) {
    const error = new Error("browser_running");
    error.statusCode = 409;
    throw error;
  }
  const dir = profileDir(browser.slug, env, options);
  const existed = await pathExists(dir);
  if (existed) await fs.rm(dir, { recursive: true, force: true });
  await appendEvent({ type: "browser_cleanup_requested", browser: browser.slug, slug: browser.slug, profileDir: dir, existed }, env);
  return {
    ...(await publicBrowserRecord(browser, env, options)),
    cleaned: existed,
  };
}
