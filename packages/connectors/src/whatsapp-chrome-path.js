import fs from "node:fs";

// Chrome for the WhatsApp bridge. An explicit WA_CHROME_PATH or
// PUPPETEER_EXECUTABLE_PATH wins; otherwise an installed Chrome or Chromium is
// used, so `npm ci` does not have to download puppeteer's own browser. When
// nothing is found, "" lets puppeteer fall back to its own download, if any.

const candidates = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

export function installedChromePath(platform = process.platform, exists = fs.existsSync) {
  return (candidates[platform] || []).find((candidate) => exists(candidate)) || "";
}

export function whatsappChromePath(env = process.env, platform = process.platform, exists = fs.existsSync) {
  const explicit = String(env.WA_CHROME_PATH || env.PUPPETEER_EXECUTABLE_PATH || "").trim();
  return explicit || installedChromePath(platform, exists);
}

export const whatsappChromeMissingHint =
  "WhatsApp needs Google Chrome or Chromium on this computer. Install Chrome, or set WA_CHROME_PATH to its executable, then start linking again.";
