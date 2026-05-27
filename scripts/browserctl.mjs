#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { constants as fsConstants } from "node:fs";
import { execFileSync, spawn } from "node:child_process";

const catalog = [
  {
    slug: "desktop",
    label: "Desktop",
    purpose: "General-purpose browser desktop for agent-driven web tasks.",
    startUrl: "about:blank",
  },
  {
    slug: "linkedin",
    label: "LinkedIn",
    purpose: "Log in to LinkedIn with an owned browser profile.",
    startUrl: "https://www.linkedin.com/",
  },
  {
    slug: "gmail",
    label: "Gmail",
    purpose: "Optional Gmail browser profile for accounts that need browser access.",
    startUrl: "https://mail.google.com/",
  },
];

function appHome(env = process.env) {
  return path.resolve(env.ORKESTR_HOME || path.join(os.homedir(), ".orkestr"));
}

function browserRoot(env = process.env) {
  return path.join(appHome(env), "browsers");
}

function cleanSlug(value) {
  const slug = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]*$/.test(slug) ? slug : "";
}

function desktopBySlug(value) {
  const slug = cleanSlug(value);
  const desktop = catalog.find((item) => item.slug === slug);
  if (!desktop) throw Object.assign(new Error("browser_not_found"), { statusCode: 404 });
  return desktop;
}

function desktopIndex(slug) {
  return Math.max(0, catalog.findIndex((item) => item.slug === slug));
}

function numberEnv(name, fallback) {
  const parsed = Number(process.env[name] || fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function profileDir(slug) {
  return path.join(browserRoot(), slug);
}

function runtimeDir(slug) {
  return path.join(profileDir(slug), "runtime");
}

function statePath(slug) {
  return path.join(profileDir(slug), "desktop.json");
}

function portsForSlug(slug) {
  const index = desktopIndex(slug);
  return {
    debugPort: numberEnv("ORKESTR_BROWSER_DEBUG_PORT_BASE", 9222) + index,
    vncPort: numberEnv("ORKESTR_DESKTOP_VNC_PORT_BASE", 5901) + index,
    webPort: numberEnv("ORKESTR_DESKTOP_WEB_PORT_BASE", 6080) + index,
    displayNumber: numberEnv("ORKESTR_DESKTOP_DISPLAY_BASE", 90) + index,
  };
}

function desktopUrl(slug) {
  const pathValue = `desktop/${encodeURIComponent(slug)}/websockify`;
  return `/desktop/${encodeURIComponent(slug)}/vnc.html?autoconnect=1&resize=scale&path=${pathValue}`;
}

async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function executableExists(filePath) {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
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

async function commandPath(configName, candidates) {
  const configured = String(process.env[configName] || "").trim();
  if (configured) return configured;
  const searchDirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/") || path.isAbsolute(candidate)) {
      if (await executableExists(candidate)) return candidate;
      continue;
    }
    for (const dir of searchDirs) {
      const resolved = path.join(dir, candidate);
      if (await executableExists(resolved)) return resolved;
    }
  }
  return "";
}

async function chromeCommand() {
  return commandPath("ORKESTR_CHROME_PATH", ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]);
}

async function noVncWebDir() {
  const configured = String(process.env.ORKESTR_NOVNC_WEB_DIR || "").trim();
  for (const candidate of [configured, "/usr/share/novnc"]) {
    if (!candidate) continue;
    if (await pathExists(path.join(candidate, "vnc.html"))) return candidate;
  }
  return "";
}

function dryRun() {
  return ["1", "true", "yes"].includes(String(process.env.ORKESTR_BROWSERCTL_DRY_RUN || "").trim().toLowerCase());
}

function flagEnabled(name) {
  return ["1", "true", "yes"].includes(String(process.env[name] || "").trim().toLowerCase());
}

function commandOutput(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

let runIdentityCache;
function desktopRunIdentity() {
  if (runIdentityCache !== undefined) return runIdentityCache;
  runIdentityCache = null;
  if (process.getuid?.() !== 0) return runIdentityCache;
  const user = String(process.env.ORKESTR_BROWSER_RUN_USER || process.env.ORKESTR_RUN_USER || "").trim();
  if (!user || flagEnabled("ORKESTR_BROWSERCTL_RUN_AS_ROOT")) return runIdentityCache;
  try {
    const uid = Number(commandOutput("id", ["-u", user]));
    const gid = Number(commandOutput("id", ["-g", user]));
    if (Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid >= 0) {
      runIdentityCache = {
        uid,
        gid,
        user,
        home: commandOutput("getent", ["passwd", user]).split(":")[5] || "",
      };
    }
  } catch {
    runIdentityCache = null;
  }
  return runIdentityCache;
}

async function chownTree(target, uid, gid) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(target)) {
      await chownTree(path.join(target, entry), uid, gid);
    }
  }
  await fs.lchown(target, uid, gid).catch(() => {});
}

async function spawnManaged(command, args, extraEnv = {}) {
  const identity = desktopRunIdentity();
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...extraEnv,
      ...(identity?.home ? { HOME: identity.home } : {}),
      ...(identity?.user ? { USER: identity.user, LOGNAME: identity.user } : {}),
    },
    ...(identity ? { uid: identity.uid, gid: identity.gid } : {}),
  });
  child.unref();
  return child.pid || null;
}

async function waitUntil(check, timeoutMs = 7000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function readState(slug) {
  return readJson(statePath(slug), {});
}

async function writeState(slug, patch) {
  const prior = await readState(slug);
  const next = { ...prior, ...patch, updatedAt: new Date().toISOString() };
  await writeJson(statePath(slug), next);
  return next;
}

async function ensurePrepared(slug) {
  const desktop = desktopBySlug(slug);
  const ports = portsForSlug(desktop.slug);
  await fs.mkdir(runtimeDir(desktop.slug), { recursive: true, mode: 0o700 });
  await fs.mkdir(profileDir(desktop.slug), { recursive: true, mode: 0o700 });
  const prior = await readState(desktop.slug);
  const next = await writeState(desktop.slug, {
    slug: desktop.slug,
    label: desktop.label,
    type: "desktop",
    profileDir: profileDir(desktop.slug),
    profile_path: profileDir(desktop.slug),
    startUrl: prior.startUrl || desktop.startUrl,
    preparedAt: prior.preparedAt || new Date().toISOString(),
    debugPort: prior.debugPort || ports.debugPort,
    vncPort: prior.vncPort || ports.vncPort,
    webPort: prior.webPort || ports.webPort,
    display: prior.display || `:${ports.displayNumber}`,
  });
  const identity = desktopRunIdentity();
  if (identity) await chownTree(profileDir(desktop.slug), identity.uid, identity.gid);
  return next;
}

async function sessionRecord(value) {
  const desktop = desktopBySlug(value);
  const slug = desktop.slug;
  const state = await readState(slug);
  const prepared = Boolean(state.preparedAt || await pathExists(profileDir(slug)));
  const dryRunning = dryRun() && state.dryRunRunning === true;
  const webOpen = await isTcpPortOpen(state.webPort || portsForSlug(slug).webPort);
  const cdpOpen = await isTcpPortOpen(state.debugPort || portsForSlug(slug).debugPort);
  const running = dryRunning || webOpen || isPidRunning(state.websockifyPid) || isPidRunning(state.chromePid);
  const status = running ? "running" : prepared ? "prepared" : "not_prepared";
  const ports = portsForSlug(slug);
  const debugPort = Number(state.debugPort || ports.debugPort);
  const vncPort = Number(state.vncPort || ports.vncPort);
  const webPort = Number(state.webPort || ports.webPort);
  const display = String(state.display || `:${ports.displayNumber}`);

  return {
    id: slug,
    slug,
    label: desktop.label,
    purpose: desktop.purpose,
    notes: desktop.purpose,
    type: "desktop",
    access: "desk",
    configured: prepared,
    status,
    state: status,
    url: prepared ? desktopUrl(slug) : desktop.startUrl,
    desk_url: prepared ? desktopUrl(slug) : null,
    desk_proxy_url: prepared ? desktopUrl(slug) : null,
    cdp_url: running || state.startedAt ? `http://127.0.0.1:${debugPort}` : null,
    cdp_ok: cdpOpen,
    web_ok: webOpen,
    owner_service: "orkestr-oss",
    profileDir: profileDir(slug),
    profile: profileDir(slug),
    profile_path: profileDir(slug),
    root_pid: running ? state.chromePid || state.websockifyPid || state.xvfbPid || null : null,
    chrome_pid: running ? state.chromePid || null : null,
    websockify_pid: running ? state.websockifyPid || null : null,
    vnc_pid: running ? state.x11vncPid || null : null,
    debugPort,
    web_port: webPort,
    vnc_port: vncPort,
    display,
    safe_cleanup: prepared && !running,
    control: {
      health: true,
      prepare: true,
      start: true,
      stop: running,
      restart: prepared,
      cleanup: prepared && !running,
    },
    preparedAt: state.preparedAt || null,
    lastOpenedAt: state.startedAt || null,
    stoppedAt: state.stoppedAt || null,
    cleanedAt: state.cleanedAt || null,
    launchError: state.launchError || null,
    source: "orkestr-browserctl",
  };
}

async function listSessions() {
  await fs.mkdir(browserRoot(), { recursive: true, mode: 0o700 });
  return Promise.all(catalog.map((desktop) => sessionRecord(desktop.slug)));
}

async function startDesktop(value) {
  const desktop = desktopBySlug(value);
  const slug = desktop.slug;
  const current = await sessionRecord(slug);
  if (current.status === "running") return current;
  const state = await ensurePrepared(slug);
  const ports = portsForSlug(slug);
  const display = String(state.display || `:${ports.displayNumber}`);
  const startUrl = String(state.startUrl || desktop.startUrl || "about:blank");
  const startedAt = new Date().toISOString();

  if (dryRun()) {
    await writeState(slug, { dryRunRunning: true, startedAt, launchError: null });
    return sessionRecord(slug);
  }

  const xvfb = await commandPath("ORKESTR_XVFB_PATH", ["Xvfb"]);
  const wm = await commandPath("ORKESTR_WINDOW_MANAGER", ["openbox"]);
  const x11vnc = await commandPath("ORKESTR_X11VNC_PATH", ["x11vnc"]);
  const websockify = await commandPath("ORKESTR_WEBSOCKIFY_PATH", ["websockify"]);
  const chrome = await chromeCommand();
  const webDir = await noVncWebDir();
  const missing = [
    ["Xvfb", xvfb],
    ["openbox", wm],
    ["x11vnc", x11vnc],
    ["websockify", websockify],
    ["noVNC web files", webDir],
    ["Chrome/Chromium", chrome],
  ].filter(([, resolved]) => !resolved).map(([name]) => name);
  if (missing.length) {
    throw Object.assign(new Error(`missing_desktop_runtime: ${missing.join(", ")}`), { statusCode: 503 });
  }
  if (process.getuid?.() === 0 && !desktopRunIdentity() && !flagEnabled("ORKESTR_CHROME_NO_SANDBOX")) {
    throw Object.assign(new Error("browserctl_root_requires_run_user_or_explicit_no_sandbox"), { statusCode: 503 });
  }

  try {
    const xvfbPid = await spawnManaged(xvfb, [display, "-screen", "0", "1440x900x24", "-nolisten", "tcp", "-ac"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!isPidRunning(xvfbPid)) throw new Error("xvfb_failed_to_start");
    const windowManagerPid = await spawnManaged(wm, [], { DISPLAY: display });
    const x11vncPid = await spawnManaged(x11vnc, [
      "-display", display,
      "-localhost",
      "-forever",
      "-shared",
      "-rfbport", String(ports.vncPort),
      "-nopw",
      "-quiet",
    ], { DISPLAY: display });
    const websockifyPid = await spawnManaged(websockify, [
      "--web", webDir,
      `127.0.0.1:${ports.webPort}`,
      `127.0.0.1:${ports.vncPort}`,
    ]);
    const chromeArgs = [
      `--user-data-dir=${profileDir(slug)}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${ports.debugPort}`,
      "--no-first-run",
      "--disable-dev-shm-usage",
      "--window-size=1440,900",
      "--start-maximized",
      "--new-window",
    ];
    if (flagEnabled("ORKESTR_CHROME_NO_SANDBOX")) {
      chromeArgs.push("--no-sandbox");
    }
    chromeArgs.push(startUrl);
    const chromePid = await spawnManaged(chrome, chromeArgs, { DISPLAY: display });
    const webReady = await waitUntil(() => isTcpPortOpen(ports.webPort), 7000);
    const cdpReady = await waitUntil(() => isTcpPortOpen(ports.debugPort), 7000);
    if (!webReady) throw new Error("novnc_failed_to_start");
    if (!cdpReady) throw new Error("chrome_cdp_failed_to_start");
    await writeState(slug, {
      xvfbPid,
      windowManagerPid,
      x11vncPid,
      websockifyPid,
      chromePid,
      startedAt,
      stoppedAt: null,
      launchError: null,
      dryRunRunning: false,
    });
    return sessionRecord(slug);
  } catch (error) {
    await writeState(slug, { launchError: error?.message || String(error) });
    await stopDesktop(slug, { quiet: true });
    throw error;
  }
}

async function killPid(pid) {
  if (!isPidRunning(pid)) return;
  try {
    process.kill(Number(pid), "SIGTERM");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 8 && isPidRunning(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isPidRunning(pid)) {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // The process may already be gone.
    }
  }
}

async function stopDesktop(value, options = {}) {
  const desktop = desktopBySlug(value);
  const slug = desktop.slug;
  const state = await readState(slug);
  for (const pid of [state.chromePid, state.websockifyPid, state.x11vncPid, state.windowManagerPid, state.xvfbPid]) {
    await killPid(pid);
  }
  await writeState(slug, {
    chromePid: null,
    websockifyPid: null,
    x11vncPid: null,
    windowManagerPid: null,
    xvfbPid: null,
    dryRunRunning: false,
    stoppedAt: new Date().toISOString(),
  });
  return options.quiet ? null : sessionRecord(slug);
}

async function cleanupDesktop(value, options = {}) {
  const desktop = desktopBySlug(value);
  const current = await sessionRecord(desktop.slug);
  if (current.status === "running" && options.safe) {
    throw Object.assign(new Error("desktop_running"), { statusCode: 409 });
  }
  if (current.status === "running") await stopDesktop(desktop.slug);
  const dir = profileDir(desktop.slug);
  const existed = await pathExists(dir);
  if (existed) await fs.rm(dir, { recursive: true, force: true });
  return { ...(await sessionRecord(desktop.slug)), cleaned: existed };
}

async function main() {
  const [rawCommand, rawSlug, ...rest] = process.argv.slice(2);
  const command = rawCommand === "prepare" ? "health" : String(rawCommand || "list");
  if (command === "list") {
    console.log(JSON.stringify({ ok: true, source: "orkestr-browserctl", sessions: await listSessions() }));
    return;
  }
  const slug = cleanSlug(rawSlug);
  if (!slug) throw Object.assign(new Error("browser_slug_required"), { statusCode: 400 });
  let session;
  if (command === "health") session = await ensurePrepared(slug).then(() => sessionRecord(slug));
  else if (command === "start") session = await startDesktop(slug);
  else if (command === "stop") session = await stopDesktop(slug);
  else if (command === "restart") {
    await stopDesktop(slug, { quiet: true });
    session = await startDesktop(slug);
  } else if (command === "cleanup") {
    session = await cleanupDesktop(slug, { safe: rest.includes("--safe") });
  } else {
    throw Object.assign(new Error("unsupported_browserctl_command"), { statusCode: 400 });
  }
  console.log(JSON.stringify({ ok: true, source: "orkestr-browserctl", session }));
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(Number(error?.statusCode) >= 500 ? 3 : 2);
});
