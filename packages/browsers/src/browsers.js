import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent } from "../../storage/src/store.js";

const browserCatalog = [
  {
    slug: "linkedin",
    label: "LinkedIn",
    purpose: "LinkedIn virtual browser profile",
    startUrl: "https://www.linkedin.com/",
  },
  {
    slug: "gmail",
    label: "Gmail",
    purpose: "Gmail virtual browser profile",
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

function chromeCommand(env = process.env) {
  return String(env.ORKESTR_CHROME_PATH || env.CHROME_PATH || "google-chrome").trim();
}

function profileDir(slug, env = process.env) {
  return `${dataPaths(env).browsers}/${slug}`;
}

function publicBrowserRecord(browser, configured, env = process.env) {
  const dir = profileDir(browser.slug, env);
  return {
    ...browser,
    id: browser.slug,
    profileDir: dir,
    profile: dir,
    configured,
    status: configured ? "prepared" : "not_prepared",
    state: configured ? "prepared" : "not_prepared",
    url: browser.startUrl,
  };
}

export async function listVirtualBrowsers(env = process.env) {
  await ensureDataDirs(env);
  const browsers = [];
  for (const browser of browserCatalog) {
    browsers.push(publicBrowserRecord(browser, await pathExists(profileDir(browser.slug, env)), env));
  }
  return browsers;
}

export async function prepareVirtualBrowser(slug, env = process.env) {
  const browser = browserBySlug(slug);
  await ensureDataDirs(env);
  const dir = profileDir(browser.slug, env);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const record = publicBrowserRecord(browser, true, env);
  await appendEvent({ type: "browser_prepared", slug: browser.slug, profileDir: dir }, env);
  return record;
}

export async function openVirtualBrowser(slug, env = process.env) {
  const browser = await prepareVirtualBrowser(slug, env);
  const launchDisabled = String(env.ORKESTR_BROWSER_LAUNCH_DISABLED || "").trim() === "1";
  let launched = false;
  let pid = null;
  if (!launchDisabled) {
    try {
      const child = spawn(chromeCommand(env), [
        `--user-data-dir=${browser.profileDir}`,
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
    } catch {
      launched = false;
    }
  }
  await appendEvent({ type: "browser_open_requested", slug: browser.slug, launched, pid, profileDir: browser.profileDir }, env);
  return { ...browser, launched, pid };
}
