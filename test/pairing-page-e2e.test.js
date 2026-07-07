import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { approvePairingChallenge, createPairingChallenge, pairBrowser, securityCookieName } from "../packages/core/src/security.js";
import { createAppShare } from "../packages/core/src/shared-apps.js";
import { adminPrincipal } from "../packages/core/src/principal.js";

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

async function loadPuppeteer(t) {
  try {
    const module = await import("puppeteer");
    return module.default || module;
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip("Puppeteer is not installed for browser e2e.");
      return null;
    }
    throw error;
  }
}

test("pairing required page generates and consumes a challenge in a real browser", async (t) => {
  const puppeteer = await loadPuppeteer(t);
  if (!puppeteer) return;
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

    await page.goto(`${baseUrl}/thread/Test`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => document.body.innerText.includes("Approve this browser"));
    await page.waitForFunction(
      () => {
        const text = document.body.innerText.toLowerCase();
        return text.includes("orkestr connect approve") && text.includes("pending");
      },
      { timeout: 10_000 },
    );

    const command = await page.$eval(".command code", (node) => node.textContent.trim());
    const challengeId = command.split(/\s+/).at(-1) || "";
    const bodyAfterChallenge = await page.$eval("body", (node) => node.innerText);
    assert.match(challengeId, /^[A-Z0-9]{4,8}$/);
    assert.match(bodyAfterChallenge, new RegExp(`orkestr connect approve ${challengeId}`));

    await approvePairingChallenge(challengeId);
    await page.waitForFunction(() => !document.body.innerText.includes("Approve this browser"), { timeout: 15_000 });
    assert.equal(new URL(page.url()).pathname, "/");
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});

test("pairing page redirects to challenge path after pairing", async (t) => {
  const puppeteer = await loadPuppeteer(t);
  if (!puppeteer) return;
  const chrome = await findChrome();
  if (!chrome) {
    t.skip("No Chrome or Chromium executable available for browser e2e.");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pairing-existing-e2e-"));
  const prior = saveEnv();
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  const requestedPath = "/i/main/a/outreach-review/s/share-one";
  const existing = await createPairingChallenge({ env: process.env, instanceId: "main", requestedPath });
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

    await page.goto(`${baseUrl}/setup/pairing?instanceId=main&challengeId=${encodeURIComponent(existing.challengeId)}&return=%2F`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => document.body.innerText.includes("Approve this browser"));
    await page.waitForFunction(
      () => {
        const text = document.body.innerText.toLowerCase();
        return text.includes("orkestr connect approve") && text.includes("pending");
      },
      { timeout: 10_000 },
    );

    const command = await page.$eval(".command code", (node) => node.textContent.trim());
    assert.equal(command, `orkestr connect approve ${existing.challenge.approveCode}`);

    await approvePairingChallenge(existing.challengeId);
    await page.waitForFunction(() => !document.body.innerText.includes("Approve this browser"), { timeout: 15_000 });
    assert.equal(new URL(page.url()).pathname, requestedPath);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});

test("unauthenticated shared app approval stays on the shared route", async (t) => {
  const puppeteer = await loadPuppeteer(t);
  if (!puppeteer) return;
  const chrome = await findChrome();
  if (!chrome) {
    t.skip("No Chrome or Chromium executable available for browser e2e.");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-shared-app-inline-pairing-"));
  const prior = saveEnv();
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  const principal = adminPrincipal({ id: "admin", displayName: "Admin" });
  await createAppShare("main", "outreach-review", {
    shareToken: "share-one",
    title: "Outreach Review",
    filtersJson: { people: [{ id: "betul", name: "Betul Y." }] },
  }, { principal, env: process.env });
  const requestedPath = "/i/main/a/outreach-review/s/share-one";

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
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window, "__orkestrSharedSnapshots", { value: [], configurable: true });
      const record = () => {
        const list = window.__orkestrSharedSnapshots;
        if (!Array.isArray(list) || list.length > 500) return;
        list.push({
          path: location.pathname,
          text: (document.body?.innerText || "").slice(0, 1200),
        });
      };
      const install = () => {
        record();
        new MutationObserver(record).observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
      else install();
      const NativeWebSocket = window.WebSocket;
      Object.defineProperty(window, "__orkestrWsUrls", { value: [], configurable: true });
      function RecordingWebSocket(url, protocols) {
        window.__orkestrWsUrls.push(String(url));
        return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
      }
      Object.setPrototypeOf(RecordingWebSocket, NativeWebSocket);
      RecordingWebSocket.prototype = NativeWebSocket.prototype;
      window.WebSocket = RecordingWebSocket;
    });

    await page.goto(`${baseUrl}${requestedPath}`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => document.body.innerText.includes("Approve this shared review"), { timeout: 10_000 });
    await page.waitForFunction(() => document.body.innerText.includes("orkestr connect approve"), { timeout: 10_000 });
    assert.equal(new URL(page.url()).pathname, requestedPath);
    const snapshots = await page.evaluate(() => window.__orkestrSharedSnapshots || []);
    assert.equal(snapshots.some((snapshot) => snapshot.path === "/setup/pairing"), false);
    assert.equal(snapshots.some((snapshot) => snapshot.text.includes("Approve this browser")), false);
    assert.equal(snapshots.some((snapshot) => snapshot.text.includes("Orkestr Setup")), false);

    const command = await page.$eval(".shared-access-command code", (node) => node.textContent.trim());
    const approveCode = command.split(/\s+/).at(-1) || "";
    assert.match(approveCode, /^[A-Z0-9]{4,8}$/);
    await approvePairingChallenge(approveCode, { env: process.env });
    await page.waitForFunction(() => document.body.innerText.includes("Betul Y."), { timeout: 20_000 });
    const bodyAfterApproval = await page.$eval("body", (node) => node.innerText);
    assert.equal(bodyAfterApproval.includes("Cannot read properties"), false);
    assert.equal(bodyAfterApproval.includes("Approve this shared review"), false);
    assert.equal(new URL(page.url()).pathname, requestedPath);
    const wsUrls = await page.evaluate(() => window.__orkestrWsUrls || []);
    assert.deepEqual(wsUrls.filter((url) => url.includes("/api/threads/summary/stream")), []);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});

test("shared app page does not connect the normal thread summary stream", async (t) => {
  const puppeteer = await loadPuppeteer(t);
  if (!puppeteer) return;
  const chrome = await findChrome();
  if (!chrome) {
    t.skip("No Chrome or Chromium executable available for browser e2e.");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-shared-app-no-thread-stream-"));
  const prior = saveEnv();
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  const principal = adminPrincipal({ id: "admin", displayName: "Admin" });
  const created = await createAppShare("main", "outreach-review", {
    shareToken: "share-one",
    title: "Outreach Review",
    filtersJson: { people: [{ id: "betul", name: "Betul Y." }] },
  }, { principal, env: process.env });
  const requestedPath = "/i/main/a/outreach-review/s/share-one";
  const challenge = await createPairingChallenge({
    env: process.env,
    instanceId: "main",
    shareId: created.share.id,
    appSlug: "outreach-review",
    requestedPath,
    allowedActions: ["setClassification"],
  });
  await approvePairingChallenge(challenge.challengeId, { env: process.env });
  const paired = await pairBrowser({ challengeId: challenge.challengeId, env: process.env });

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
    await page.setCookie({
      url: baseUrl,
      name: securityCookieName(),
      value: paired.token,
      path: "/",
    });
    await page.evaluateOnNewDocument(() => {
      const NativeWebSocket = window.WebSocket;
      Object.defineProperty(window, "__orkestrWsUrls", { value: [], configurable: true });
      function RecordingWebSocket(url, protocols) {
        window.__orkestrWsUrls.push(String(url));
        return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
      }
      Object.setPrototypeOf(RecordingWebSocket, NativeWebSocket);
      RecordingWebSocket.prototype = NativeWebSocket.prototype;
      window.WebSocket = RecordingWebSocket;
    });

    const sharedAppResponse = page.waitForResponse((response) =>
      response.url().includes("/api/shared-apps/i/main/a/outreach-review/s/share-one") && response.status() === 200,
      { timeout: 10_000 },
    );
    await page.goto(`${baseUrl}${requestedPath}`, { waitUntil: "networkidle2" });
    await sharedAppResponse;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const wsUrls = await page.evaluate(() => window.__orkestrWsUrls || []);
    assert.equal(new URL(page.url()).pathname, requestedPath);
    assert.deepEqual(wsUrls.filter((url) => url.includes("/api/threads/summary/stream")), []);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});
