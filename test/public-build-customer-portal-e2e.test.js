import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { renderPublicSite } from "../dist/server/apps/server/src/public-site.js";

const envKeys = ["ORKESTR_HOME", "ORKESTR_AUTH_REQUIRED", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_THREAD_STORE"];

async function withServer(t, run) {
  const prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.ORKESTR_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-build-portal-"));
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_THREAD_STORE = "json";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("customer portal HTML carries no analytics beacon in a production-shaped render", () => {
  const env = { ORKESTR_PUBLIC_SITE_URL: "https://product.example.test", ORKESTR_PUBLIC_APP_URL: "https://app.example.test" };
  const html = renderPublicSite("/builds/customer-portal", env, { host: "product.example.test" });
  assert.match(html, /<h1>B2B customer portal with approval rules<\/h1>/);
  assert.match(html, /rel="canonical" href="https:\/\/product\.example\.test\/builds\/customer-portal"/);
  assert.doesNotMatch(html, /\/api\/public\/events|sendBeacon|orkestrTrack|data-event=|data-view-event=/);
  const scripts = html.match(/<script\b[^>]*>/g) || [];
  assert.deepEqual(scripts.filter((tag) => !/type="application\/ld\+json"/.test(tag)), ['<script type="module" src="/builds/customer-portal/app.js">']);
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

test("live build routes are public, self-contained, and serve only allowlisted assets", async (t) => {
  await withServer(t, async (baseUrl) => {
    const page = await fetch(`${baseUrl}/builds/customer-portal`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Synthetic demo - not a client project, no real orders\./);
    assert.match(html, /After this page loads, it sends nothing back: no analytics, no data uploads\. Your entries stay in this browser\./);
    assert.doesNotMatch(html, /makes no network calls|nothing is sent to a server|sends nothing to a server/i, "no-network wording must be scoped to after load");
    assert.match(html, /What this demo does not do/);
    assert.match(html, /not server-enforced authorization/);
    assert.match(html, /data-action="reset"/);
    assert.match(html, /<script type="module" src="\/builds\/customer-portal\/app\.js"><\/script>/);
    assert.doesNotMatch(html, /orkestrTrack|sendBeacon|\/api\/public\/events|\son[a-z]+="/, "no analytics beacon or inline handlers");
    assert.doesNotMatch(html, /data-event=|data-view-event=/, "no beacon hooks on the page");
    for (const tag of html.match(/<script\b[^>]*>/g) || []) {
      assert.match(tag, /^<script type="module" src="\/builds\/customer-portal\/[a-z-]+\.js">$|^<script type="application\/ld\+json">$/, `unexpected script: ${tag}`);
    }
    assert.doesNotMatch(html, /Book a project call/, "live builds carry no consulting CTA in the header");
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);

    const catalog = await fetch(`${baseUrl}/builds`);
    assert.equal(catalog.status, 200);
    const catalogHtml = await catalog.text();
    assert.match(catalogHtml, /href="\/builds\/customer-portal"/);
    assert.match(catalogHtml, /<a href="\/builds\/customer-portal">B2B customer portal with approval rules<\/a>/);
    assert.match(catalogHtml, /hub-evidence-simulation">Simulation</);

    for (const [asset, type] of [["app.js", /text\/javascript/], ["workflow.js", /text\/javascript/], ["portal.css", /text\/css/]]) {
      const response = await fetch(`${baseUrl}/builds/customer-portal/${asset}`);
      assert.equal(response.status, 200, asset);
      assert.match(response.headers.get("content-type") || "", type);
      // Inspect code only: comments may describe what the code deliberately does not do.
      const body = (await response.text()).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      assert.doesNotMatch(body, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import\(|\/api\/|data-(view-)?event|https?:\/\//, `${asset} must not make network calls`);
    }
    for (const probe of ["/builds/customer-portal/../../../package.json", "/builds/customer-portal/missing.js", "/builds/..%2F..%2Fpackage.json"]) {
      const response = await fetch(`${baseUrl}${probe}`);
      assert.doesNotMatch(await response.text(), /"name": "orkestr-oss"/, probe);
    }
  });
});

test("customer portal demo runs the full order and approval flow in a real browser", async (t) => {
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    t.skip("Puppeteer is not installed for browser e2e.");
    return;
  }
  const chrome = await findChrome();
  if (!chrome) {
    t.skip("No Chrome or Chromium executable available for browser e2e.");
    return;
  }
  await withServer(t, async (baseUrl) => {
    const browser = await puppeteer.launch({ headless: "new", executablePath: chrome, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    try {
      const page = await browser.newPage();
      const problems = [];
      page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
      page.on("console", (message) => { if (message.type() === "error") problems.push(`console: ${message.text()}`); });
      page.on("request", (request) => { if (!request.url().startsWith(baseUrl) && !request.url().startsWith("data:")) problems.push(`external request: ${request.url()}`); });
      // Count every outbound API the page code could use; static asset delivery is not counted.
      await page.evaluateOnNewDocument(() => {
        const calls = [];
        Object.defineProperty(window, "__portalNetworkCalls", { value: calls });
        const wrap = (owner, key, label) => {
          const original = owner[key];
          if (typeof original !== "function") return;
          owner[key] = function (...args) { calls.push(`${label} ${String(args[0] && args[0].url || args[0])}`); return original.apply(this, args); };
        };
        wrap(window, "fetch", "fetch");
        wrap(XMLHttpRequest.prototype, "open", "xhr");
        if (navigator.sendBeacon) wrap(Navigator.prototype, "sendBeacon", "beacon");
        for (const name of ["WebSocket", "EventSource"]) {
          const Original = window[name];
          if (!Original) continue;
          window[name] = function (...args) { calls.push(`${name} ${String(args[0])}`); return new Original(...args); };
        }
      });
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${baseUrl}/builds/customer-portal`, { waitUntil: "networkidle0" });
      await page.waitForSelector("#portal-app.is-ready #portal-order-form");
      // From here on the page must not issue fetch/XHR/beacon/WebSocket/EventSource
      // traffic, same-origin included. Static asset delivery would be fine.
      const requestsAfterLoad = [];
      const recordRequest = (request) => {
        if (["fetch", "xhr", "ping", "websocket", "eventsource"].includes(request.resourceType())) requestsAfterLoad.push(`${request.resourceType()} ${request.url()}`);
      };
      page.on("request", recordRequest);
      const text = (selector) => page.$eval(selector, (node) => node.textContent);
      const waitStatus = async (needle) => {
        try {
          await page.waitForFunction((value) => document.querySelector("#portal-status").textContent.includes(value), { timeout: 10_000 }, needle);
        } catch {
          assert.fail(`status never showed "${needle}"; got "${await text("#portal-status")}"; problems: ${problems.join(" | ")}`);
        }
      };

      // Everything after load must work without the network.
      await page.setOfflineMode(true);
      const submit = '#portal-order-form button[type="submit"]';
      const orderCount = () => page.evaluate(() => document.querySelectorAll("#customer-panel .portal-order").length);

      // Invalid input: empty form and a fractional quantity are refused with messages.
      await page.click(submit);
      await waitStatus("Add at least one product quantity.");
      assert.match(await text("#portal-form-error"), /Add at least one product quantity/);
      await page.type('input[data-sku="VLV-100"]', "2.5");
      assert.equal(await text("#qty-error-VLV-100"), "Enter a whole number of units.");
      await page.click(submit);
      await waitStatus("Check the quantities");
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute("data-sku")), "VLV-100");
      assert.equal(await page.$eval('input[data-sku="VLV-100"]', (node) => node.getAttribute("aria-invalid")), "true");
      assert.equal(await orderCount(), 0);

      // Duplicate submission: a double click and a scripted double submit create one order.
      await page.click('input[data-sku="VLV-100"]', { count: 3 });
      await page.keyboard.type("5");
      assert.equal(await text("#qty-error-VLV-100"), "");
      await page.click(submit);
      await waitStatus("auto-approved");
      await page.click(submit);
      await waitStatus("already submitted. No duplicate order was created.");
      await page.$eval("#portal-order-form", (form) => { form.requestSubmit(); form.requestSubmit(); });
      assert.equal(await orderCount(), 1);
      // Typing the same request in again is recognised as a repeat, not a new order.
      await page.type('input[data-sku="VLV-100"]', "5");
      await page.click(submit);
      await waitStatus("PO-1001 already contains exactly these lines. No duplicate order was created");
      assert.equal(await orderCount(), 1);
      await page.click('input[data-sku="VLV-100"]', { count: 3 });
      await page.keyboard.press("Backspace");
      await page.type('input[data-sku="FLT-405"]', "2");
      assert.match(await text(".portal-preview"), /will pause for an approver/);
      await page.click('#portal-order-form button[type="submit"]');
      await waitStatus("paused for approval");
      await page.type('input[data-sku="SNS-310"]', "50");
      await page.click(submit);
      await waitStatus("PO-1003 paused for approval");
      assert.equal(await orderCount(), 3);
      assert.match(await text("#portal-pending-count"), /2 waiting/);

      // Switch role with the keyboard only: arrow keys move between the native radios.
      await page.focus('input[name="portal-role"][value="customer"]');
      await page.keyboard.press("ArrowRight");
      await page.waitForSelector("#approver-panel");
      assert.match(await text("#approver-panel"), /Approval queue \(2\)/);
      await page.click('button[data-action="reject"][data-order="PO-1003"]');
      assert.match(await text("#portal-status"), /reason is required/);
      await page.type('[data-reason="PO-1003"]', "Stock cannot cover this quarter (synthetic).");
      await page.click('button[data-action="reject"][data-order="PO-1003"]');
      await waitStatus("PO-1003 rejected");
      await page.focus('[data-reason="PO-1002"]');
      await page.keyboard.type("Partial delivery accepted (synthetic).");
      await page.focus('button[data-action="approve"][data-order="PO-1002"]');
      await page.keyboard.press("Enter");
      await waitStatus("PO-1002 approved");
      assert.match(await text("#approver-panel"), /Approval queue \(0\)/);
      const audit = await text(".portal-audit");
      for (const action of ["order submitted", "order auto approved", "order paused", "order approved", "order rejected"]) assert.match(audit, new RegExp(action));

      page.off("request", recordRequest);
      assert.deepEqual(requestsAfterLoad, [], "the demo made API requests after load");
      assert.deepEqual(await page.evaluate(() => window.__portalNetworkCalls), [], "page code called a network API");
      await page.setOfflineMode(false);
      await page.reload({ waitUntil: "networkidle0" });
      await page.waitForSelector("#portal-app.is-ready #approver-panel");
      assert.match(await text("#approver-panel"), /Decided orders \(3\)/, "state persists in localStorage across reloads");

      await page.click('button[data-action="reset"]');
      await waitStatus("Demo reset");
      assert.match(await text(".portal-audit"), /Audit log \(1 entry,/);
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("orkestr-demo-customer-portal-v1")));
      assert.equal(stored.orders.length, 0);

      await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
      await page.reload({ waitUntil: "networkidle0" });
      await page.waitForSelector("#portal-app.is-ready");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `mobile layout overflows horizontally by ${overflow}px`);
      assert.deepEqual(problems, []);
    } finally {
      await browser.close();
    }
  });
});
