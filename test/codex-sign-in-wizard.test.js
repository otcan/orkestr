import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { codexCommandAvailable, codexCommandUnavailableHint, codexStateLabel } from "../apps/web/src/app/codex-runtime-status.ts";

test("Codex status helpers explain why sign-in cannot start", () => {
  assert.equal(codexCommandAvailable(null), false);
  assert.equal(codexCommandAvailable({ id: "codex", label: "", state: "partial", summary: "" }), true);
  assert.equal(codexCommandAvailable({ id: "codex", label: "", state: "not_connected", summary: "", details: { command: "codex" } }), true);
  assert.equal(codexCommandAvailable({ id: "codex", label: "", state: "partial", summary: "", details: { disabled: true } }), false);
  const missing = { id: "codex", label: "", state: "not_connected", summary: "", details: { reason: "codex_missing" } };
  assert.equal(codexCommandAvailable(missing), false);
  assert.match(codexCommandUnavailableHint(missing), /runtime is missing/);
  assert.match(codexCommandUnavailableHint({ ...missing, details: { reason: "codex_disabled_on_macos" } }), /ORKESTR_ENABLE_HOST_CODEX=1/);
  assert.equal(codexStateLabel({ id: "codex", label: "", state: "connected", summary: "" }), "connected");
  assert.equal(codexStateLabel({ id: "codex", label: "", state: "partial", summary: "" }), "sign-in required");
  assert.equal(codexStateLabel(missing), "runtime missing");
  assert.equal(codexStateLabel(null), "checking");
});

test("wizard signs Codex in through the panel for admins only; the panel stops polling on destroy", async () => {
  const panel = await fs.readFile("apps/web/src/app/codex-sign-in-panel.component.ts", "utf8");
  const wizard = await fs.readFile("apps/web/src/app/first-thread-wizard.component.html", "utf8");
  assert.match(panel, /ngOnDestroy\(\): void \{\s*this\.destroyed = true;\s*this\.stopPolling\(\);/);
  assert.match(panel, /\[disabled\]="busy \|\| !commandAvailable\(\)"/);
  assert.match(wizard, /@if \(canManageSetup\) \{[\s\S]*<ork-codex-sign-in-panel[\s\S]*\(connected\)="onCodexConnected\(\$event\)"/);
  assert.match(wizard, /needs to sign Codex in first/);
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

test("without an agent only the wizard shows; signing Codex in there opens the app on the same step", { timeout: 120_000 }, async (t) => {
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    t.skip("Puppeteer is not installed for browser e2e.");
    return;
  }
  const chrome = await findChrome();
  if (!chrome) return t.skip("No Chrome or Chromium executable available for browser e2e.");
  try {
    await fs.access("dist/web/browser/index.html");
  } catch {
    return t.skip("Web bundle not built (npm run web:build).");
  }
  const keys = ["ORKESTR_HOME", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_AUTH_REQUIRED"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-wizard-e2e-"));
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fake = { codex: "partial", deviceAuthCalls: 0, external: [], created: [] };
  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new", executablePath: chrome, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(() => { window.open = () => null; });
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
            .concat([{ id: "codex", label: "Codex", state: fake.codex, summary: "", details: { command: "codex" } }]);
          return request.respond(json(real));
        }
        if (route === "GET /api/threads") return request.respond(json({ threads: fake.created.map((body) => ({ id: body.id, name: body.name, title: body.name, status: "idle" })) }));
        if (route === "POST /api/threads") {
          const body = JSON.parse(request.postData() || "{}");
          fake.created.push(body);
          return request.respond(json({ thread: { id: body.id, name: body.name, title: body.name } }));
        }
        if (url.pathname.startsWith("/api/threads/orkestr") || url.pathname.startsWith("/api/desktops/") || url.pathname.startsWith("/api/browser-sessions/")) {
          return request.respond(json({ ok: true, lease: { fencingToken: "1" }, browser: { slug: "desktop" }, messages: [] }));
        }
        if (route === "GET /api/connectors/whatsapp/status") return request.respond(json({ state: "unpaired", mode: "local", accounts: [] }));
        if (route === "POST /api/connectors/codex/device-auth") {
          fake.deviceAuthCalls += 1;
          return request.respond(json({ ok: true, state: "pending", code: "ABCD-1234", authUrl: "https://auth.example.test/codex/device", expiresAt: new Date(Date.now() + 600_000).toISOString() }));
        }
        return request.continue();
      } catch {
        return request.abort();
      }
    });
    const buttons = (label) => page.evaluate((text) => [...document.querySelectorAll(".first-thread-wizard button")].filter((b) => b.textContent.trim() === text).map((b) => !b.disabled), label);
    const click = async (label) => {
      await page.waitForFunction((text) => [...document.querySelectorAll(".first-thread-wizard button")].some((b) => b.textContent.trim() === text && !b.disabled), { timeout: 15_000 }, label);
      await page.evaluate((text) => [...document.querySelectorAll(".first-thread-wizard button")].find((b) => b.textContent.trim() === text && !b.disabled).click(), label);
    };

    await page.goto(`${origin}/`, { waitUntil: "networkidle2" });
    // No coding agent yet: the app shows only the first-run wizard (no shell, no way around it).
    await page.waitForSelector(".runtime-gate-shell .first-thread-wizard", { timeout: 30_000 });
    assert.equal(await page.$(".app-shell"), null, "no entry to the app without Codex or Claude Code");
    assert.equal(await page.evaluate(() => [...document.querySelectorAll(".first-thread-wizard button")].some((b) => b.textContent.trim() === "Close")), false, "the gate wizard cannot be closed");
    await click("Skip for now");
    await page.waitForSelector("ork-codex-sign-in-panel");
    assert.deepEqual(await buttons("Start"), [false], "Start stays disabled until Codex is signed in");
    await click("Open Codex sign-in");
    await page.waitForFunction(() => document.querySelector(".codex-device-code")?.textContent.includes("ABCD-1234"), { timeout: 10_000 });
    assert.equal(fake.deviceAuthCalls, 1);

    fake.codex = "connected";
    await page.waitForFunction(() => !document.querySelector("ork-codex-sign-in-panel"), { timeout: 15_000 });
    // Signing in creates the first conversation "orkestr" right away (no naming step), once.
    await page.waitForFunction(() => !document.querySelector(".first-thread-wizard"), { timeout: 20_000 });
    assert.deepEqual(fake.created.map((body) => [body.id, body.name]), [["orkestr", "orkestr"]]);
    assert.equal(await page.$(".runtime-gate-shell"), null, "the gate lifts once an agent is connected");
    assert.equal(new URL(page.url()).pathname, "/thread/orkestr", "the new conversation opens");
    assert.deepEqual(fake.external, [], "no requests to other hosts");
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
