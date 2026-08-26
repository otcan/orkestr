import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { approvePairingChallenge, createPairingChallenge, listPairingChallenges, pairBrowser, securityCookieName } from "../packages/core/src/security.js";
import { createAppShare } from "../packages/core/src/shared-apps.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { appendThreadMessage, createThread } from "../packages/core/src/threads.js";
import { writeInstanceIdentity } from "../packages/core/src/instance-identity.js";

const envKeys = [
  "ORKESTR_HOME",
  "ORKESTR_AUTH_REQUIRED",
  "ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED",
  "ORKESTR_RECOVER_RUNNING_ON_START",
  "ORKESTR_THREAD_STORE",
  "ORKESTR_CANONICAL_INSTANCE_URLS",
  "ORKESTR_CANONICAL_APP_GATEWAY",
  "ORKESTR_CANONICAL_APP_LINKS",
  "ORKESTR_INSTANCE_ID",
  "ORKESTR_PUBLIC_APP_URL",
  "ORKESTR_APP_URL",
  "ORKESTR_PUBLIC_URL",
  "ORKESTR_PUBLIC_HTTPS_URL",
  "ORKESTR_HTTPS_URL",
  "ORKESTR_CONNECT_PUBLIC_URL",
  "ORKESTR_APP_HOST",
];

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

test("mobile thread routes keep the selected conversation visible and open threads in a drawer", async (t) => {
  const puppeteer = await loadPuppeteer(t);
  if (!puppeteer) return;
  const chrome = await findChrome();
  if (!chrome) {
    t.skip("No Chrome or Chromium executable available for browser e2e.");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mobile-thread-e2e-"));
  const prior = saveEnv();
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "0";
  process.env.ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_THREAD_STORE = "json";
  process.env.ORKESTR_CANONICAL_INSTANCE_URLS = "1";
  process.env.ORKESTR_CANONICAL_APP_GATEWAY = "1";
  process.env.ORKESTR_CANONICAL_APP_LINKS = "1";
  process.env.ORKESTR_INSTANCE_ID = "mobile-instance-internal";
  for (const key of [
    "ORKESTR_PUBLIC_APP_URL",
    "ORKESTR_APP_URL",
    "ORKESTR_PUBLIC_URL",
    "ORKESTR_PUBLIC_HTTPS_URL",
    "ORKESTR_HTTPS_URL",
    "ORKESTR_CONNECT_PUBLIC_URL",
    "ORKESTR_APP_HOST",
  ]) {
    delete process.env[key];
  }
  const instanceRef = "ins_AQEBAQEBAQEBAQEBAQEBAQ";
  await writeInstanceIdentity({ internalInstanceId: "mobile-instance-internal", publicRef: instanceRef }, process.env);
  const thread = await createThread({ id: "mobile-review-thread", name: "Mobile Review Thread" }, process.env);
  await appendThreadMessage("mobile-review-thread", {
    role: "assistant",
    state: "completed",
    phase: "final",
    text: "The selected conversation is visible on mobile.",
  }, process.env);

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
    const canonicalUrl = `${baseUrl}/instance/${instanceRef}/thread/${thread.publicRef}`;
    const widths = [320, 375, 390, 768, 860];
    await page.setViewport({ width: widths[0], height: 844, deviceScaleFactor: 1 });
    await page.goto(canonicalUrl, { waitUntil: "networkidle2" });
    await page.waitForFunction(
      () => document.body.innerText.includes("The selected conversation is visible on mobile."),
      { timeout: 20_000 },
    );
    for (const width of widths) {
      await page.setViewport({ width, height: width <= 390 ? 844 : 900, deviceScaleFactor: 1 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const initial = await page.evaluate(() => {
        const drawer = document.querySelector("#thread-sidebar")?.getBoundingClientRect();
        const chat = document.querySelector(".chat")?.getBoundingClientRect();
        const firstMessage = document.querySelector(".message")?.getBoundingClientRect();
        const composer = document.querySelector(".composer")?.getBoundingClientRect();
        const navItems = [...document.querySelectorAll(".instance-topbar-nav > button, .instance-topbar-nav > details")]
          .map((node) => node.getBoundingClientRect());
        return {
          drawerRight: drawer?.right || 0,
          chatLeft: chat?.left || 0,
          chatWidth: chat?.width || 0,
          firstMessageTop: firstMessage?.top || 0,
          firstMessageBottom: firstMessage?.bottom || 0,
          composerLeft: composer?.left || 0,
          composerRight: composer?.right || 0,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
          navFits: navItems.every((item) => item.left >= -1 && item.right <= window.innerWidth + 1),
        };
      });
      assert.ok(initial.drawerRight <= 1, `drawer at ${width}px`);
      assert.equal(initial.chatLeft, 0, `chat left at ${width}px`);
      assert.ok(initial.chatWidth >= width - 10, `chat width at ${width}px`);
      assert.ok(initial.firstMessageTop < initial.viewportHeight, `message top at ${width}px`);
      assert.ok(initial.firstMessageBottom > 0, `message bottom at ${width}px`);
      assert.ok(
        initial.composerLeft >= -1 && initial.composerRight <= initial.viewportWidth + 1,
        `composer at ${width}px: ${JSON.stringify(initial)}`,
      );
      assert.equal(initial.pageOverflows, false, `page overflow at ${width}px`);
      assert.equal(initial.navFits, true, `top navigation at ${width}px`);
    }

    await page.click("button.mobile-instance-menu");
    await page.waitForFunction(() => {
      const drawer = document.querySelector("#thread-sidebar")?.getBoundingClientRect();
      return Boolean(drawer) && Number(drawer.left) >= -1;
    }, { timeout: 3_000 });
    const openedLeft = await page.$eval("#thread-sidebar", (node) => node.getBoundingClientRect().left);
    assert.ok(openedLeft >= -1);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});

test("pairing page stores tenant app return path on generated challenge", async (t) => {
  const puppeteer = await loadPuppeteer(t);
  if (!puppeteer) return;
  const chrome = await findChrome();
  if (!chrome) {
    t.skip("No Chrome or Chromium executable available for browser e2e.");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pairing-return-e2e-"));
  const prior = saveEnv();
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const requestedPath = "/i/main/app/setup/gmail";
  const expectedParams = new URLSearchParams({
    mcp: "tools/call",
    tool: "orkestr_auth",
    service: "gmail",
    provider: "google_workspace",
    action: "connect",
    instance_id: "main",
  });
  const expectedPath = `/i/main/app/connectors/gmail?${expectedParams}`;
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

    await page.goto(`${baseUrl}/setup/pairing?instanceId=main&return=${encodeURIComponent(requestedPath)}`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => document.body.innerText.includes("Approve this browser"), { timeout: 10_000 });
    await page.waitForFunction(() => document.body.innerText.includes("orkestr connect approve"), { timeout: 10_000 });

    const challenges = await listPairingChallenges({ env: process.env, includeExpired: true });
    const challenge = challenges.challenges.find((item) => item.instanceId === "main");
    assert.ok(challenge);
    assert.equal(challenge.requestedPath, expectedPath);
    assert.equal(challenge.status, "pending");
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
    await page.evaluateOnNewDocument(() => {
      window.__orkestrPairingSnapshots = [];
      const record = () => {
        window.__orkestrPairingSnapshots.push(document.body?.innerText || "");
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
    });

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
    const snapshots = await page.evaluate(() => window.__orkestrPairingSnapshots || []);
    assert.equal(snapshots.some((text) => String(text || "").includes("Orkestr Setup")), false);

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

test("pairing page keeps a new Google connect challenge open when the browser cookie is scoped to an older connect", async (t) => {
  const puppeteer = await loadPuppeteer(t);
  if (!puppeteer) return;
  const chrome = await findChrome();
  if (!chrome) {
    t.skip("No Chrome or Chromium executable available for browser e2e.");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pairing-google-scope-e2e-"));
  const prior = saveEnv();
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  const oldChallenge = await createPairingChallenge({
    env: process.env,
    userId: "admin",
    role: "admin",
    allowedActions: ["orkestr_auth.google.connect:old-connect"],
    authIntent: { service: "gmail", provider: "google_workspace", action: "connect", connectId: "old-connect" },
  });
  await approvePairingChallenge(oldChallenge.challengeId, { env: process.env });
  const oldPair = await pairBrowser({ challengeId: oldChallenge.challengeId, env: process.env });
  const returnPath = "/connect/google?connect=new-connect";
  const newChallenge = await createPairingChallenge({
    env: process.env,
    userId: "admin",
    role: "admin",
    requestedPath: returnPath,
    allowedActions: ["orkestr_auth.google.connect:new-connect"],
    authIntent: { service: "gmail", provider: "google_workspace", action: "connect", connectId: "new-connect" },
  });
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
    await page.setCookie({ name: securityCookieName(process.env), value: oldPair.token, url: baseUrl });
    const pairingUrl = `${baseUrl}/setup/pairing?challengeId=${encodeURIComponent(newChallenge.challengeId)}&return=${encodeURIComponent(returnPath)}`;
    await page.goto(pairingUrl, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => document.body.innerText.includes("Approve this browser"));
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const current = new URL(page.url());
    assert.equal(current.pathname, "/setup/pairing");
    assert.equal(current.searchParams.get("challengeId"), newChallenge.challengeId);
    const command = await page.$eval(".command code", (node) => node.textContent.trim());
    assert.equal(command, `orkestr connect approve ${newChallenge.challenge.approveCode}`);
    const challenges = await listPairingChallenges({ env: process.env, includeExpired: true });
    assert.equal(challenges.challenges.find((item) => item.id === newChallenge.challengeId)?.status, "pending");
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});

test("pairing page keeps a canonical instance challenge open when only a global session exists", async (t) => {
  const puppeteer = await loadPuppeteer(t);
  if (!puppeteer) return;
  const chrome = await findChrome();
  if (!chrome) {
    t.skip("No Chrome or Chromium executable available for browser e2e.");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pairing-canonical-scope-e2e-"));
  const prior = saveEnv();
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  const globalChallenge = await createPairingChallenge({ env: process.env });
  await approvePairingChallenge(globalChallenge.challengeId, { env: process.env });
  const globalPair = await pairBrowser({ challengeId: globalChallenge.challengeId, env: process.env });
  const requestedPath = "/instance/ins_AQEBAQEBAQEBAQEBAQEBAQ/";
  const instanceChallenge = await createPairingChallenge({
    env: process.env,
    instanceId: "main",
    requestedPath,
  });
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
    await page.setCookie({ name: securityCookieName(process.env), value: globalPair.token, url: baseUrl });
    const pairingUrl = `${baseUrl}/setup/pairing?instanceId=main&challengeId=${encodeURIComponent(instanceChallenge.challengeId)}&return=${encodeURIComponent(requestedPath)}`;
    await page.goto(pairingUrl, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => document.body.innerText.includes("Approve this browser"));
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const current = new URL(page.url());
    assert.equal(current.pathname, "/setup/pairing");
    assert.equal(current.searchParams.get("challengeId"), instanceChallenge.challengeId);
    const challenges = await listPairingChallenges({ env: process.env, includeExpired: true });
    assert.equal(challenges.challenges.find((item) => item.id === instanceChallenge.challengeId)?.status, "pending");
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
    const challenges = await listPairingChallenges({ env: process.env, includeExpired: true });
    const routeChallenges = challenges.challenges.filter((challenge) =>
      challenge.instanceId === "main" &&
      challenge.appSlug === "outreach-review" &&
      challenge.requestedPath === requestedPath
    );
    assert.equal(routeChallenges.filter((challenge) => challenge.status === "pending").length, 0);
    assert.equal(routeChallenges.filter((challenge) => challenge.status === "consumed").length, 1);
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
