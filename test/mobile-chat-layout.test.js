import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { appendThreadMessage, createThread } from "../packages/core/src/threads.js";

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

test("phone layout loads after the other global styles", async () => {
  const angular = JSON.parse(await fs.readFile("angular.json", "utf8"));
  const styles = Object.values(angular.projects)[0].architect.build.options.styles;
  assert.equal(styles.at(-1), "apps/web/src/mobile-chat.css");
});

// iPhone-sized viewport (Safari with its bars showing): the messages must get
// the screen, not the header, tools and composer.
test("on a phone the conversation shows its messages, not just one line", { timeout: 120_000 }, async (t) => {
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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mobile-layout-"));
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_OWNER_LOGIN_PROMPT = "0";
  await createThread({ id: "demo", name: "demo-thread-with-a-long-name", executorId: "noop" }, process.env);
  for (let i = 0; i < 8; i += 1) {
    await appendThreadMessage("demo", { role: i % 2 ? "assistant" : "user", text: `Message ${i}: ${"A longer message that wraps over several lines. ".repeat(3)}` }, process.env);
  }
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new", executablePath: chrome, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 664, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      const url = new URL(request.url());
      if (url.origin !== origin) return request.abort();
      if (request.method() === "GET" && url.pathname === "/api/setup/status") {
        // A connected agent, so the app opens instead of the first-run gate.
        const real = await (await fetch(`${origin}/api/setup/status`)).json();
        real.onboarding = { ...(real.onboarding || {}), autoOpen: false };
        real.agentRuntime = { ...(real.agentRuntime || {}), ready: true };
        real.connectors = (real.connectors || []).filter((item) => item.id !== "codex")
          .concat([{ id: "codex", label: "Codex", state: "connected", summary: "", details: { command: "codex" } }]);
        return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(real) });
      }
      return request.continue();
    });
    await page.goto(`${origin}/thread/demo`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".chat > .messages .message", { timeout: 30_000 });
    const box = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
      const messages = rect(".chat > .messages");
      const nav = rect(".instance-topbar-nav > button");
      const menu = rect(".mobile-instance-menu");
      const tools = rect(".composer-tools");
      return {
        messages: messages?.height || 0,
        overlap: nav && menu ? nav.left < menu.right : true,
        toolsHeight: tools?.height || 0,
        pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      };
    });
    assert.ok(box.messages >= 664 * 0.45, `messages get at least 45% of the screen (got ${box.messages}px)`);
    assert.equal(box.overlap, false, "the Menu button does not cover the navigation");
    assert.ok(box.toolsHeight <= 40, "composer tools stay on one row");
    assert.ok(box.pageScroll <= 1, "the page itself does not scroll; only the messages do");
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
