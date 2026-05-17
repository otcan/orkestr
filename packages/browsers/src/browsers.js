import fs from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";

const execFileAsync = promisify(execFile);

const browserCatalog = [
  {
    slug: "desktop",
    label: "Desktop",
    purpose: "General-purpose local browser desktop for agent-driven web tasks.",
    startUrl: "about:blank",
  },
  {
    slug: "linkedin",
    label: "LinkedIn",
    purpose: "Log in to LinkedIn with an owned local browser profile.",
    startUrl: "https://www.linkedin.com/",
  },
  {
    slug: "gmail",
    label: "Gmail",
    purpose: "Optional Gmail browser profile for accounts that need browser access.",
    startUrl: "https://mail.google.com/",
  },
];

function browserBySlug(slug) {
  const id = String(slug || "").trim();
  const browser = browserCatalog.find((item) => item.slug === id);
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

function profileDir(slug, env = process.env) {
  return `${dataPaths(env).browsers}/${slug}`;
}

function browserIndex(slug) {
  return Math.max(0, browserCatalog.findIndex((browser) => browser.slug === slug));
}

function debugPortForSlug(slug, env = process.env) {
  const base = Number(env.ORKESTR_BROWSER_DEBUG_PORT_BASE || 9222);
  const safeBase = Number.isFinite(base) && base > 0 ? base : 9222;
  return safeBase + browserIndex(slug);
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

async function readBrowserMetadata(slug, env = process.env) {
  return readJson(`${profileDir(slug, env)}/browser.json`, {});
}

async function writeBrowserMetadata(slug, metadata, env = process.env) {
  await writeJson(`${profileDir(slug, env)}/browser.json`, metadata);
}

async function publicBrowserRecord(browser, env = process.env) {
  const dir = profileDir(browser.slug, env);
  const metadata = await readBrowserMetadata(browser.slug, env);
  const configured = await pathExists(dir);
  const savedPid = Number(metadata.rootPid || metadata.pid || 0) || null;
  const detectedPid = savedPid && isPidRunning(savedPid) ? savedPid : configured ? await findBrowserPidByProfile(dir) : null;
  const rootPid = detectedPid || null;
  const running = !!rootPid;
  const debugPort = Number(metadata.debugPort || debugPortForSlug(browser.slug, env));
  const cdpUrl = configured && (running || metadata.lastOpenedAt) && debugPort ? `http://127.0.0.1:${debugPort}` : null;
  const cdpOk = running && debugPort ? await isTcpPortOpen(debugPort) : false;
  const status = running ? "running" : configured ? "prepared" : "not_prepared";
  return {
    ...browser,
    id: browser.slug,
    type: "desktop",
    access: "local",
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

export async function listVirtualBrowsers(env = process.env) {
  await ensureDataDirs(env);
  return Promise.all(browserCatalog.map((browser) => publicBrowserRecord(browser, env)));
}

export async function prepareVirtualBrowser(slug, env = process.env) {
  const browser = browserBySlug(slug);
  await ensureDataDirs(env);
  const dir = profileDir(browser.slug, env);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const prior = await readBrowserMetadata(browser.slug, env);
  const preparedAt = prior.preparedAt || new Date().toISOString();
  await writeBrowserMetadata(browser.slug, {
    ...prior,
    slug: browser.slug,
    label: browser.label,
    type: "desktop",
    profileDir: dir,
    profile_path: dir,
    startUrl: browser.startUrl,
    debugPort: prior.debugPort || debugPortForSlug(browser.slug, env),
    preparedAt,
    updatedAt: new Date().toISOString(),
  }, env);
  await appendEvent({ type: "browser_prepared", browser: browser.slug, slug: browser.slug, profileDir: dir }, env);
  return publicBrowserRecord(browser, env);
}

export async function openVirtualBrowser(slug, env = process.env) {
  const browser = browserBySlug(slug);
  const prepared = await prepareVirtualBrowser(slug, env);
  const launchDisabled = String(env.ORKESTR_BROWSER_LAUNCH_DISABLED || "").trim() === "1";
  const command = launchDisabled ? "" : await chromeCommand(env);
  let launched = false;
  let pid = null;
  let launchError = "";

  if (!launchDisabled && command) {
    try {
      const debugPort = prepared.debugPort || debugPortForSlug(browser.slug, env);
      const child = spawn(command, [
        `--user-data-dir=${prepared.profileDir}`,
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${debugPort}`,
        "--no-first-run",
        "--new-window",
        browser.startUrl,
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
    startUrl: browser.startUrl,
    preparedAt: prepared.preparedAt || openedAt,
    lastOpenedAt: openedAt,
    launchCommand: command || null,
    launchDisabled,
    launchError: launchError || null,
    rootPid: pid,
    pid,
    debugPort: prepared.debugPort || debugPortForSlug(browser.slug, env),
  }, env);
  await appendEvent({ type: "browser_open_requested", browser: browser.slug, slug: browser.slug, launched, pid, profileDir: prepared.profileDir }, env);
  return {
    ...(await publicBrowserRecord(browser, env)),
    launched,
    pid,
    launchDisabled,
    launchError,
  };
}

export async function stopVirtualBrowser(slug, env = process.env) {
  const browser = browserBySlug(slug);
  const dir = profileDir(browser.slug, env);
  const configured = await pathExists(dir);
  const metadata = await readBrowserMetadata(browser.slug, env);
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
    }, env);
  }
  await appendEvent({ type: "browser_stop_requested", browser: browser.slug, slug: browser.slug, stopped, pid, stopError }, env);
  return {
    ...(await publicBrowserRecord(browser, env)),
    stopped,
    stopError,
  };
}

export async function restartVirtualBrowser(slug, env = process.env) {
  await stopVirtualBrowser(slug, env);
  return openVirtualBrowser(slug, env);
}

export async function cleanupVirtualBrowser(slug, env = process.env) {
  const browser = browserBySlug(slug);
  const current = await publicBrowserRecord(browser, env);
  if (current.root_pid) {
    const error = new Error("browser_running");
    error.statusCode = 409;
    throw error;
  }
  const dir = profileDir(browser.slug, env);
  const existed = await pathExists(dir);
  if (existed) await fs.rm(dir, { recursive: true, force: true });
  await appendEvent({ type: "browser_cleanup_requested", browser: browser.slug, slug: browser.slug, profileDir: dir, existed }, env);
  return {
    ...(await publicBrowserRecord(browser, env)),
    cleaned: existed,
  };
}
