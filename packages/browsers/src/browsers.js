import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { ensureDataDirs } from "../../storage/src/paths.js";

const execFileAsync = promisify(execFile);

const browsers = [
  {
    slug: "linkedin",
    label: "LinkedIn",
    purpose: "Log in to LinkedIn with an owned local browser profile.",
    url: "https://www.linkedin.com/",
  },
  {
    slug: "gmail",
    label: "Gmail",
    purpose: "Optional Gmail browser profile for accounts that need browser access.",
    url: "https://mail.google.com/",
  },
];

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

async function chromeCommand() {
  for (const command of ["google-chrome", "chrome", "chromium", "chromium-browser"]) {
    if (await commandExists(command)) return command;
  }
  return "";
}

function definition(slug) {
  const browser = browsers.find((entry) => entry.slug === String(slug || "").trim());
  if (!browser) {
    const error = new Error("unknown_browser_session");
    error.statusCode = 404;
    throw error;
  }
  return browser;
}

async function browserRecord(browser, paths) {
  const profileDir = `${paths.browsers}/${browser.slug}`;
  const metadata = await readJson(`${profileDir}/browser.json`, {});
  const configured = await pathExists(profileDir);
  return {
    ...browser,
    id: browser.slug,
    profileDir,
    configured,
    status: configured ? "prepared" : "not_prepared",
    preparedAt: metadata.preparedAt || null,
    lastOpenedAt: metadata.lastOpenedAt || null,
    launchCommand: metadata.launchCommand || null,
  };
}

export async function listVirtualBrowsers(env = process.env) {
  const paths = await ensureDataDirs(env);
  return Promise.all(browsers.map((browser) => browserRecord(browser, paths)));
}

export async function prepareVirtualBrowser(slug, env = process.env) {
  const browser = definition(slug);
  const paths = await ensureDataDirs(env);
  const profileDir = `${paths.browsers}/${browser.slug}`;
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const prior = await readJson(`${profileDir}/browser.json`, {});
  const metadata = {
    ...prior,
    slug: browser.slug,
    label: browser.label,
    profileDir,
    preparedAt: prior.preparedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeJson(`${profileDir}/browser.json`, metadata);
  await appendEvent({ type: "browser_prepared", browser: browser.slug, profileDir }, env);
  return browserRecord(browser, paths);
}

export async function openVirtualBrowser(slug, env = process.env) {
  const browser = definition(slug);
  const prepared = await prepareVirtualBrowser(browser.slug, env);
  const disabled = String(env.ORKESTR_BROWSER_LAUNCH_DISABLED || "").trim() === "1";
  const command = disabled ? "" : await chromeCommand();
  let launched = false;
  let launchError = "";

  if (command) {
    try {
      const child = execFile(command, [`--user-data-dir=${prepared.profileDir}`, "--new-window", browser.url], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      launched = true;
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
  await appendEvent({ type: "browser_open_requested", browser: browser.slug, launched, command: command || null }, env);
  return {
    ...(await browserRecord(browser, await ensureDataDirs(env))),
    launched,
    launchDisabled: disabled,
    launchError,
  };
}
