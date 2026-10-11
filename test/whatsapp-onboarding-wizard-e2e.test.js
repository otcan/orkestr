import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";

// Browser E2E of the first-run wizard for self-hosted WhatsApp (mode A in
// docs/whatsapp-docker-onboarding-plan.md). The WhatsApp bridge, thread
// creation and desktop calls are answered with synthetic responses in the
// browser, so no WhatsApp account, Chrome-for-WhatsApp, or network is used.

const envKeys = ["ORKESTR_HOME", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_PUBLIC_SITE_URL", "ORKESTR_AUTH_REQUIRED"];

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

const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

test("wizard links WhatsApp by QR, binds only the paired owner's private chat, and shows the inbound/reply check", { timeout: 120_000 }, async (t) => {
  const puppeteer = await loadPuppeteer(t);
  if (!puppeteer) return;
  const chrome = await findChrome();
  if (!chrome) {
    t.skip("No Chrome or Chromium executable available for browser e2e.");
    return;
  }
  try {
    await fs.access("dist/web/browser/index.html");
  } catch {
    t.skip("Web bundle not built (npm run web:build).");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-wizard-e2e-"));
  const prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const fake = { started: false, linked: false, inbound: false, calls: [], external: [] };
  // Mirrors the real status shape: once linked, accountId becomes the phone
  // identity and the slot id moves to runtimeAccountId.
  const whatsappAccount = () => ({
    accountId: fake.linked ? "15550000001" : "account-1",
    runtimeAccountId: "account-1",
    legacyRoleAliases: fake.linked ? ["account-1"] : [],
    contactId: fake.started ? "15550000001@c.us" : "",
    state: fake.linked ? "ready" : fake.started ? "qr_needed" : "idle",
    qrUrl: fake.started && !fake.linked ? "/__fake/qr.svg" : "",
    updatedAt: "2026-10-11T12:00:00.000Z",
  });
  const thread = { id: "orkest", name: "orkest", title: "orkest" };

  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new", executablePath: chrome, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      const url = new URL(request.url());
      const route = `${request.method()} ${url.pathname}`;
      try {
        if (url.origin !== origin && !url.protocol.startsWith("data")) {
          fake.external.push(request.url());
          return request.abort();
        }
        if (route === "GET /api/setup/status") {
          const real = await (await fetch(`${origin}/api/setup/status`)).json();
          real.onboarding = { ...(real.onboarding || {}), autoOpen: false };
          real.connectors = (real.connectors || []).filter((item) => item.id !== "codex")
            .concat([{ id: "codex", state: "connected", summary: "Codex Agent is connected (synthetic)." }]);
          real.settings = { ...(real.settings || {}), connectors: { ...(real.settings?.connectors || {}), whatsapp: { accessMode: "own" } } };
          return request.respond(json(real));
        }
        if (route === "GET /api/threads") return request.respond(json({ threads: fake.created ? [thread] : [] }));
        if (route === "GET /api/connectors/whatsapp/status") return request.respond(json({ state: fake.linked ? "connected" : "unpaired", mode: "local", accounts: [whatsappAccount()] }));
        if (route === "POST /api/connectors/whatsapp/config") {
          fake.calls.push(["config", JSON.parse(request.postData() || "{}")]);
          return request.respond(json({ ok: true }));
        }
        if (route === "POST /api/connectors/whatsapp/bridge/accounts/account-1/start") {
          fake.started = true;
          fake.calls.push(["start"]);
          return request.respond(json({ state: "starting" }));
        }
        if (route === "GET /__fake/qr.svg") {
          return request.respond({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>' });
        }
        if (route === "POST /api/setup/demo-preferences") {
          fake.calls.push(["preferences", JSON.parse(request.postData() || "{}")]);
          return request.respond(json({ ok: true }));
        }
        if (route === "POST /api/threads") {
          fake.created = true;
          fake.calls.push(["create-thread"]);
          return request.respond(json({ thread }));
        }
        if (url.pathname.startsWith("/api/threads/orkest/desktop") || url.pathname.startsWith("/api/desktops/") || url.pathname.startsWith("/api/browsers/")) {
          fake.calls.push(["desktop", route]);
          return request.respond(json({ ok: true, lease: { fencingToken: "synthetic" } }));
        }
        if (route === "POST /api/connectors/whatsapp/thread-groups") {
          fake.calls.push(["shared-thread-groups"]);
          return request.respond(json({ ok: false }, 500));
        }
        if (route === "POST /api/connectors/whatsapp/onboarding/private-chat") {
          fake.calls.push(["thread-group", JSON.parse(request.postData() || "{}")]);
          return request.respond(json({ ok: true, created: false, privateOwnerChat: true, chat: { id: "15550000001@c.us", name: "orkest", isGroup: false } }));
        }
        if (route === "GET /api/threads/orkest/messages") {
          const messages = fake.inbound
            ? [{ id: "m1", role: "user", source: "whatsapp_inbound", originSurface: "whatsapp", text: "hi" }, { id: "m2", role: "assistant", text: "Hello from orkest" }]
            : [];
          return request.respond(json({ messages }));
        }
        return request.continue();
      } catch {
        return request.abort();
      }
    });

    await page.goto(`${origin}/`, { waitUntil: "networkidle2" });
    // A fresh home already has the built-in watcher thread, so open the wizard like a user would.
    await page.waitForFunction(() => [...document.querySelectorAll("button, a")].some((node) => node.textContent.trim() === "New Coding Agent"), { timeout: 30_000 });
    await page.evaluate(() => [...document.querySelectorAll("button, a")].find((node) => node.textContent.trim() === "New Coding Agent").click());
    await page.waitForSelector(".first-thread-wizard", { timeout: 30_000 });
    const clickButton = async (label) => {
      await page.waitForFunction((text) => [...document.querySelectorAll(".first-thread-wizard button")].some((button) => button.textContent.trim() === text && !button.disabled), { timeout: 15_000 }, label);
      await page.evaluate((text) => [...document.querySelectorAll(".first-thread-wizard button")].find((button) => button.textContent.trim() === text && !button.disabled).click(), label);
    };

    await clickButton("Next"); // welcome
    await clickButton("Next"); // coding agent (synthetic Codex connected)
    await page.waitForSelector("ork-whatsapp-pair-panel");
    assert.match(await page.$eval(".wizard-choice-grid .choice-card.active", (node) => node.textContent), /Use my own WhatsApp/, "self-hosted is the default without a broker");
    await clickButton("Show QR code");
    await page.waitForSelector("img.whatsapp-pair-qr", { timeout: 10_000 });
    assert.deepEqual(fake.calls.find((call) => call[0] === "config")[1], { bridgeMode: "local" });
    fake.linked = true;
    await page.waitForFunction(() => document.querySelector(".whatsapp-pair-panel")?.textContent.includes("linked and ready"), { timeout: 10_000 });
    assert.equal(await page.$("img.whatsapp-pair-qr"), null, "the QR disappears once linked");

    await clickButton("Next"); // review
    await page.waitForFunction(() => document.querySelector(".wizard-review")?.textContent.includes("Own WhatsApp (linked)"));
    await clickButton("Start orkest");
    await page.waitForSelector(".wizard-proof", { timeout: 20_000 });
    const group = fake.calls.find((call) => call[0] === "thread-group");
    assert.deepEqual(group[1], {
      threadId: "orkest",
      name: "orkest",
      pairedAccountId: "account-1",
      pairedContactId: "15550000001@c.us",
    }, "the wizard requests only the paired account's own chat and adds nobody");
    assert.equal(fake.calls.some((call) => call[0] === "shared-thread-groups"), false, "the wizard does not use the shared thread-groups route");
    assert.deepEqual(fake.calls.find((call) => call[0] === "preferences")[1], { whatsappAccessMode: "self_hosted" });
    assert.match(await page.$eval(".wizard-proof", (node) => node.textContent), /…\s*Message received from WhatsApp/);

    fake.inbound = true;
    await page.waitForFunction(() => /✔\s*orkest replied/.test(document.querySelector(".wizard-proof")?.textContent || ""), { timeout: 15_000 });
    assert.match(await page.$eval(".wizard-proof", (node) => node.textContent), /✔\s*Message received from WhatsApp/);
    await clickButton("Open thread");
    await page.waitForFunction(() => !document.querySelector(".wizard-proof"), { timeout: 10_000 });
    assert.deepEqual(fake.external, [], "self-hosted onboarding makes no requests to other hosts");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Background tasks may still be finishing writes; cleanup is best effort.
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});
