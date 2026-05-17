import fs from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";

const execFileAsync = promisify(execFile);

const browserCatalog = [
  {
    slug: "desktop",
    label: "Virtual Desktop",
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

async function publicBrowserRecord(browser, env = process.env) {
  const dir = profileDir(browser.slug, env);
  const metadata = await readJson(`${dir}/browser.json`, {});
  const configured = await pathExists(dir);
  return {
    ...browser,
    id: browser.slug,
    profileDir: dir,
    profile: dir,
    configured,
    status: configured ? "prepared" : "not_prepared",
    state: configured ? "prepared" : "not_prepared",
    url: browser.startUrl,
    preparedAt: metadata.preparedAt || null,
    lastOpenedAt: metadata.lastOpenedAt || null,
    launchCommand: metadata.launchCommand || null,
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
  const prior = await readJson(`${dir}/browser.json`, {});
  const preparedAt = prior.preparedAt || new Date().toISOString();
  await writeJson(`${dir}/browser.json`, {
    ...prior,
    slug: browser.slug,
    label: browser.label,
    profileDir: dir,
    preparedAt,
    updatedAt: new Date().toISOString(),
  });
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
      const child = spawn(command, [
        `--user-data-dir=${prepared.profileDir}`,
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
  await writeJson(`${prepared.profileDir}/browser.json`, {
    slug: browser.slug,
    label: browser.label,
    profileDir: prepared.profileDir,
    preparedAt: prepared.preparedAt || openedAt,
    lastOpenedAt: openedAt,
    launchCommand: command || null,
    launchError: launchError || null,
  });
  await appendEvent({ type: "browser_open_requested", browser: browser.slug, slug: browser.slug, launched, pid, profileDir: prepared.profileDir }, env);
  return {
    ...(await publicBrowserRecord(browser, env)),
    launched,
    pid,
    launchDisabled,
    launchError,
  };
}
