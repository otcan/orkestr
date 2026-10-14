import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { clearWizardProgress, loadWizardProgress, saveWizardProgress } from "../apps/web/src/app/first-thread-wizard-progress.ts";

function memoryStore() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

test("wizard progress round-trips, stays within one instance and user, expires after a day, and survives corrupt storage", () => {
  const store = memoryStore();
  const scope = "/instance/a|user-1";
  const progress = { stepIndex: 2, threadName: "orkest", repoUrl: "https://example.test/a.git", runtimeProvider: "codex", whatsappAccessMode: "self_hosted", whatsappModeTouched: false, scope };
  saveWizardProgress(progress, store, 1_000);
  assert.deepEqual(loadWizardProgress(scope, store, 2_000), { ...progress, savedAt: 1_000 });
  assert.equal(loadWizardProgress("/instance/b|user-1", store, 2_000), null, "another instance never sees the draft");
  assert.equal(loadWizardProgress("/instance/a|user-2", store, 2_000), null, "another user never sees the draft");
  assert.equal(loadWizardProgress(scope, store, 1_000 + 25 * 60 * 60_000), null);
  store.setItem("orkestr:first-run-wizard", "{not json");
  assert.equal(loadWizardProgress(scope, store), null);
  saveWizardProgress({ ...progress, stepIndex: -3, runtimeProvider: "other", whatsappAccessMode: "other" }, store, 5);
  assert.deepEqual(loadWizardProgress(scope, store, 6), { ...progress, stepIndex: 0, savedAt: 5 });
  clearWizardProgress(store);
  assert.equal(loadWizardProgress(scope, store), null);
});

test("first run opens the wizard, not the setup page; returning from Setup resumes the wizard", async () => {
  const app = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const html = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  assert.doesNotMatch(app, /shouldAutoOpenOnboarding/);
  assert.match(app, /if \(this\.shouldAutoOpenFirstRunWizard\(\)\) this\.openFirstRunWizard\(\);/);
  assert.match(app, /parts\[0\] === "setup"\) return !globalThis\.location\?\.search;/);
  assert.match(app, /isUserMode\(\) \|\| this\.threadWizardOpen \|\| !this\.canCreateThreadFromSidebar\(\)/);
  assert.match(app, /if \(this\.resumeWizardAfterSetup && this\.canCreateThreadFromSidebar\(\)\)/);
  assert.match(html, /\(setupRequested\)="openSetupFromWizard\(\$event\)"/);
  assert.match(html, /\[progressScope\]="wizardProgressScope\(\)"/);
  assert.match(app, /this\.pairingRequired \|\| this\.threadWizardOpen\) return false;/, "the instance launcher redirect never hides an open wizard");
  assert.match(app, /Back from a Setup page that the wizard opened[\s\S]*this\.resumeWizardAfterSetup = false;\s*this\.threadWizardOpen = true;/);
  const panel = await fs.readFile("apps/web/src/app/codex-sign-in-panel.component.ts", "utf8");
  assert.match(panel, /startCodexDeviceAuth\(\)\);\s*\/\/[^\n]*\n\s*if \(this\.destroyed\) return;/, "no polling after the panel closed mid-request");
});

async function findChrome() {
  for (const candidate of [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean)) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next known browser path.
    }
  }
  return "";
}

const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

test("fresh install: / and bare /setup show the wizard, /setup/<section> stays Setup, and Setup returns to the same step", { timeout: 150_000 }, async (t) => {
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    return t.skip("Puppeteer is not installed for browser e2e.");
  }
  const chrome = await findChrome();
  if (!chrome) return t.skip("No Chrome or Chromium executable available for browser e2e.");
  try {
    await fs.access("dist/web/browser/index.html");
  } catch {
    return t.skip("Web bundle not built (npm run web:build).");
  }
  const keys = ["ORKESTR_HOME", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_AUTH_REQUIRED", "ORKESTR_ONBOARDING_AUTO_OPEN"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-first-run-e2e-"));
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new", executablePath: chrome, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      const url = new URL(request.url());
      try {
        if (url.origin !== origin && !url.protocol.startsWith("data")) return request.abort();
        if (request.method() === "GET" && url.pathname === "/api/setup/status") {
          const real = await (await fetch(`${origin}/api/setup/status`)).json();
          // Codex installed but not signed in: a real first run.
          real.connectors = (real.connectors || []).filter((item) => item.id !== "codex")
            .concat([{ id: "codex", label: "Codex", state: "partial", summary: "", details: { command: "codex" } }]);
          return request.respond(json(real));
        }
        if (request.method() === "GET" && url.pathname === "/api/connectors/whatsapp/status") return request.respond(json({ state: "unpaired", mode: "local", accounts: [] }));
        return request.continue();
      } catch {
        return request.abort();
      }
    });
    const shows = (selector) => page.waitForSelector(selector, { timeout: 30_000 });
    const click = async (label) => {
      await page.waitForFunction((text) => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === text && !b.disabled), { timeout: 15_000 }, label);
      await page.evaluate((text) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text && !b.disabled).click(), label);
    };

    await page.goto(`${origin}/`, { waitUntil: "networkidle2" });
    await shows(".first-thread-wizard");
    assert.equal(await page.$(".onboarding-shell"), null, "the long setup page is not shown on first run");

    await page.goto(`${origin}/setup`, { waitUntil: "networkidle2" });
    await shows(".first-thread-wizard");
    assert.equal(new URL(page.url()).pathname, "/");

    await page.goto(`${origin}/setup/system`, { waitUntil: "networkidle2" });
    await shows(".onboarding-shell");
    assert.equal(await page.$(".first-thread-wizard"), null, "explicit Setup sections stay Setup");

    await page.goto(`${origin}/`, { waitUntil: "networkidle2" });
    await shows(".first-thread-wizard");
    await click("Skip for now");
    await shows("ork-codex-sign-in-panel");
    await click("More Codex options (API key)");
    await shows(".onboarding-shell");
    await click("Back to Orkestr");
    await shows(".first-thread-wizard");
    await page.waitForFunction(() => document.querySelector(".first-thread-wizard")?.textContent.includes("Step 2 of 2"), { timeout: 15_000 });
    assert.ok(await page.$("ork-codex-sign-in-panel"), "the wizard is back on the AI step");

    // The browser Back button from a Setup page the wizard opened does the same.
    await click("More Codex options (API key)");
    await shows(".onboarding-shell");
    await page.goBack();
    await shows(".first-thread-wizard");
    await page.waitForFunction(() => document.querySelector(".first-thread-wizard")?.textContent.includes("Step 2 of 2"), { timeout: 15_000 });
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});

test("Setup keeps the compact Codex link working through the shared panel and shows the timezone in Connections", { timeout: 150_000 }, async (t) => {
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    return t.skip("Puppeteer is not installed for browser e2e.");
  }
  const chrome = await findChrome();
  if (!chrome) return t.skip("No Chrome or Chromium executable available for browser e2e.");
  try {
    await fs.access("dist/web/browser/index.html");
  } catch {
    return t.skip("Web bundle not built (npm run web:build).");
  }
  const keys = ["ORKESTR_HOME", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_AUTH_REQUIRED", "ORKESTR_ONBOARDING_AUTO_OPEN"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-setup-compact-e2e-"));
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fake = { codex: "partial", deviceAuthCalls: 0 };
  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new", executablePath: chrome, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(() => { window.open = () => null; });
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      const url = new URL(request.url());
      try {
        if (url.origin !== origin && !url.protocol.startsWith("data")) return request.abort();
        if (request.method() === "GET" && url.pathname === "/api/setup/status") {
          const real = await (await fetch(`${origin}/api/setup/status`)).json();
          real.connectors = (real.connectors || []).filter((item) => item.id !== "codex")
            .concat([{ id: "codex", label: "Codex", state: fake.codex, summary: "", details: { command: "codex" } }]);
          return request.respond(json(real));
        }
        if (request.method() === "POST" && url.pathname === "/api/connectors/codex/device-auth") {
          fake.deviceAuthCalls += 1;
          return request.respond(json({ ok: true, state: "pending", code: "WXYZ-9876", authUrl: "https://auth.example.test/codex/device", expiresAt: new Date(Date.now() + 600_000).toISOString() }));
        }
        return request.continue();
      } catch {
        return request.abort();
      }
    });

    await page.goto(`${origin}/setup/system`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".onboarding-shell", { timeout: 30_000 });
    await page.waitForFunction(() => document.body.innerText.includes("Your timezone"), { timeout: 15_000 });
    assert.ok(await page.$("input[name='onboarding-timezone']"), "timezone form is in Connections");
    const text = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(text, /Start with one capability|Ready to run|Step \d+ of \d+/);

    await page.goto(`${origin}/setup/codex?compact=1`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => document.querySelector(".codex-device-code")?.textContent.includes("WXYZ-9876"), { timeout: 15_000 });
    assert.equal(fake.deviceAuthCalls, 1, "the compact link starts sign-in by itself, once");
    fake.codex = "connected";
    await page.waitForFunction(() => !document.querySelector(".onboarding-shell"), { timeout: 20_000 });
    assert.equal(new URL(page.url()).pathname, "/", "the compact page opens the app once Codex is connected");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});
