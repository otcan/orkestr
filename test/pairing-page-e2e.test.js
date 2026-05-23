import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer";
import { startServer } from "../apps/server/src/server.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";

const envKeys = ["ORKESTR_HOME", "ORKESTR_AUTH_REQUIRED", "ORKESTR_RECOVER_RUNNING_ON_START"];

function saveEnv() {
  return Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
}

function restoreEnv(prior) {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function findChrome() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next known browser path.
    }
  }
  return "";
}

test("pairing required page generates and consumes a challenge in a real browser", async (t) => {
  const chrome = await findChrome();
  if (!chrome) {
    t.skip("No Chrome or Chromium executable available for browser e2e.");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pairing-e2e-"));
  const prior = saveEnv();
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: chrome,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message || String(error)));

    await page.goto(baseUrl, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => document.body.innerText.includes("Pairing Required"));

    await page.click("button");
    await page.waitForFunction(
      () => {
        const text = document.body.innerText.toLowerCase();
        return text.includes("challenge id") && !text.includes("no challenge yet");
      },
      { timeout: 10_000 },
    );

    const challengeId = await page.$eval(".challenge-box code", (node) => node.textContent.trim());
    const bodyAfterChallenge = await page.$eval("body", (node) => node.innerText);
    const firstButtonText = await page.$eval("button", (node) => node.textContent.trim());
    assert.match(challengeId, /^[A-Za-z0-9_-]{20,}$/);
    assert.match(bodyAfterChallenge, new RegExp(`orkestr security approve ${challengeId}`));
    assert.equal(firstButtonText, "Generate challenge");

    await approvePairingChallenge(challengeId);
    await page.waitForFunction(() => !document.body.innerText.includes("Pairing Required"), { timeout: 15_000 });
    assert.equal(new URL(page.url()).pathname, "/");
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});
