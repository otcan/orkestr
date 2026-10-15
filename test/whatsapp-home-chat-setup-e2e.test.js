import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { createThread } from "../packages/core/src/threads.js";

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
const self = "15550000001@c.us";
// Once linked, the server reports the phone identity as accountId.
const linked = { accountId: "15550000001", id: "15550000001", runtimeAccountId: "account-1", legacyRoleAliases: ["account-1"], state: "ready", ready: true, contactId: self, phoneNumber: "+15550000001" };

test("Setup → WhatsApp shows the linked account as ready and connects Message yourself to orkestr", { timeout: 120_000 }, async (t) => {
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
  const keys = ["ORKESTR_HOME", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_AUTH_REQUIRED", "ORKESTR_OWNER_LOGIN_PROMPT"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-home-chat-setup-"));
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_OWNER_LOGIN_PROMPT = "0";
  await createThread({ id: "orkestr", name: "orkestr", executorId: "noop" }, process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const calls = [];
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
        if (url.origin !== origin) return request.abort();
        if (route === "GET /api/setup/status") {
          const real = await (await fetch(`${origin}/api/setup/status`)).json();
          real.onboarding = { ...(real.onboarding || {}), autoOpen: false };
          real.agentRuntime = { ...(real.agentRuntime || {}), ready: true };
          real.whatsappOnboarding = { ...(real.whatsappOnboarding || {}), selectedMode: "self_hosted", availableModes: ["self_hosted"] };
          real.connectors = (real.connectors || []).filter((item) => !["codex", "whatsapp"].includes(item.id)).concat([
            { id: "codex", label: "Codex", state: "connected", summary: "", details: { command: "codex" } },
            { id: "whatsapp", label: "WhatsApp", state: "connected", summary: "Built-in WhatsApp bridge is paired.", details: { mode: "local", accounts: [linked] } },
          ]);
          return request.respond(json(real));
        }
        if (route === "GET /api/connectors/whatsapp/status") return request.respond(json({ state: "paired", mode: "local", accounts: [linked] }));
        if (route === "POST /api/connectors/whatsapp/onboarding/private-chat") {
          calls.push(JSON.parse(request.postData() || "{}"));
          return request.respond(json({ ok: true, chat: { id: self, name: "orkestr" } }));
        }
        return request.continue();
      } catch {
        return request.abort();
      }
    });
    await page.goto(`${origin}/setup/whatsapp`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".whatsapp-account em", { timeout: 30_000 });
    const states = await page.$$eval(".whatsapp-account", (rows) => rows.map((row) => [row.querySelector("strong")?.textContent.trim(), row.querySelector("em")?.textContent.trim()]));
    assert.deepEqual(states[0], ["WhatsApp 1", "ready"], "the linked account is not shown as idle");
    await page.waitForFunction(() => [...document.querySelectorAll("ork-whatsapp-home-chat-panel button")].some((button) => button.textContent.trim() === "Use Message yourself" && !button.disabled), { timeout: 15_000 });
    await page.evaluate(() => [...document.querySelectorAll("ork-whatsapp-home-chat-panel button")].find((button) => button.textContent.trim() === "Use Message yourself").click());
    await page.waitForFunction(() => document.querySelector("ork-whatsapp-home-chat-panel")?.textContent.includes("Message yourself now talks to orkestr"), { timeout: 15_000 });
    assert.deepEqual(calls, [{ threadId: "orkestr", name: "orkestr", pairedAccountId: "account-1", pairedContactId: self }], "only the owner's own chat on the linked account");
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
