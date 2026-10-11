import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";

const envKeys = ["ORKESTR_HOME", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_PUBLIC_SITE_URL", "ORKESTR_PRIMARY_PUBLIC_URL", "ORKESTR_PRIMARY_DOMAIN", "ORKESTR_DOMAIN"];
const allowedPaths = new Set([
  "/free/workout-log", "/free/workout-log/app.css", "/free/workout-log/app.js", "/free/workout-log/data-panel.js", "/free/workout-log/progression.js",
  "/free/workout-log/store.js", "/free/workout-log/timer.js", "/free/workout-log-sw.js", "/favicon.svg",
  // Static files of the shared site shell.
  "/public-site.css",
]);

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

const text = (page, selector) => page.$eval(selector, (node) => node.textContent.trim());

async function addSet(page, { exercise, weight, reps }) {
  await page.$eval("#wl-exercise", (node) => { node.value = ""; });
  await page.type("#wl-exercise", exercise);
  await page.$eval("#wl-weight", (node) => { node.value = ""; });
  await page.type("#wl-weight", String(weight));
  await page.$eval("#wl-reps", (node) => { node.value = ""; });
  await page.type("#wl-reps", String(reps));
  await page.click("#wl-set-form button[type=submit]");
  await page.waitForFunction((name) => document.getElementById("wl-form-status").textContent.includes(`Added ${name}`), {}, exercise);
}

async function setDate(page, value) {
  await page.$eval("#wl-date", (node, next) => {
    node.value = next;
    node.dispatchEvent(new Event("change"));
  }, value);
}

test("workout log works end to end and sends nothing back after the page loads", { timeout: 120_000 }, async (t) => {
  const puppeteer = await loadPuppeteer(t);
  if (!puppeteer) return;
  const chrome = await findChrome();
  if (!chrome) {
    t.skip("No Chrome or Chromium executable available for browser e2e.");
    return;
  }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-workout-log-e2e-"));
  const prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Render as the public site (canonical URL, structured data) like production.
  process.env.ORKESTR_PUBLIC_SITE_URL = origin;
  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new", executablePath: chrome, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const errors = [];
    const requests = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    page.on("dialog", (dialog) => dialog.accept());
    page.on("request", (request) => requests.push({ url: request.url(), type: request.resourceType(), method: request.method() }));
    // Spy on every way page code could send data, installed before the page's
    // own scripts on each load. Static file delivery is not counted.
    const pageCalls = [];
    await page.exposeFunction("__reportNetworkCall", (kind, target) => pageCalls.push(`${kind} ${target}`));
    await page.evaluateOnNewDocument(() => {
      const report = (kind, target) => window.__reportNetworkCall(kind, String(target));
      const fetchImpl = window.fetch;
      window.fetch = function (input, init) { report("fetch", input && input.url ? input.url : input); return fetchImpl.call(this, input, init); };
      const open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) { report("xhr", url); return open.call(this, method, url, ...rest); };
      if (navigator.sendBeacon) {
        const beacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = (url, data) => { report("sendBeacon", url); return beacon(url, data); };
      }
      for (const name of ["WebSocket", "EventSource"]) {
        const Original = window[name];
        if (Original) window[name] = class extends Original { constructor(url, ...rest) { report(name, url); super(url, ...rest); } };
      }
    });

    await page.goto(`${origin}/free/workout-log`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
    assert.equal(await text(page, "#wl-set-count"), "0");
    assert.equal(await page.$eval("#wl-progress-body", (node) => node.hidden), true);
    assert.ok(await page.$('script[type="application/ld+json"]'), "renders with the production shell");
    // No site beacon: no event hooks, no tracking global, only the page's own module script.
    assert.deepEqual(await page.evaluate(() => ({
      hooks: document.querySelectorAll("[data-event], [data-view-event]").length,
      tracker: typeof window.orkestrTrack,
      // JSON-LD data blocks are not executed; every executable script is listed.
      scripts: [...document.scripts].filter((script) => script.type !== "application/ld+json").map((script) => script.getAttribute("src")),
    })), { hooks: 0, tracker: "undefined", scripts: ["/free/workout-log/app.js"] });

    // Logging: two dates for one exercise, plus a second exercise.
    await setDate(page, "2026-10-01");
    await addSet(page, { exercise: "Squat", weight: 95, reps: 5 });
    await setDate(page, "2026-10-08");
    await addSet(page, { exercise: "Squat", weight: 100, reps: 5 });
    await addSet(page, { exercise: "Squat", weight: 102.5, reps: 5 });
    await addSet(page, { exercise: "Push up", weight: "", reps: 15 });
    assert.equal(await text(page, "#wl-set-count"), "4");
    assert.match(await text(page, "#wl-day-list"), /Squat.*100 kg × 5.*102\.5 kg × 5.*Push up.*bodyweight × 15/s);
    assert.equal(await page.$eval("#wl-timer-stop", (node) => node.disabled), false, "auto rest started the timer");

    // History / progression for the chosen exercise.
    await page.select("#wl-progress-exercise", "Squat");
    assert.match(await text(page, "#wl-best-set"), /102\.5 kg × 5 \(2026-10-08\)/);
    assert.equal(await text(page, "#wl-session-count"), "2");
    assert.equal(await text(page, "#wl-latest-volume"), "1012.5 kg");
    assert.match(await text(page, "#wl-trend"), /^Up 113%/);
    assert.equal(await page.$$eval("#wl-progress-rows tr", (rows) => rows.length), 2);

    // Remove one set from the day list.
    await page.click("#wl-day-list li:last-child button");
    assert.match(await text(page, "#wl-form-status"), /Removed one Squat set/);
    assert.equal(await text(page, "#wl-set-count"), "3");

    // Rest timer: stop, then a short countdown that finishes.
    await page.click("#wl-timer-stop");
    assert.equal(await text(page, "#wl-timer-status"), "Timer stopped.");
    await page.$eval("#wl-rest-seconds", (node) => { node.value = "5"; node.dispatchEvent(new Event("change")); });
    assert.equal(await text(page, "#wl-timer-display"), "0:05");
    await page.click("#wl-timer-start");
    await page.waitForFunction(() => document.getElementById("wl-timer-display").textContent !== "0:05", { timeout: 3_000 });
    await page.waitForFunction(() => document.getElementById("wl-timer-status").textContent === "Rest finished.", { timeout: 8_000 });

    // Export captures the JSON the browser would save as a file.
    await page.evaluate(() => {
      const original = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { window.__exportBlob = blob; return original(blob); };
    });
    await page.click("#wl-export");
    const exported = JSON.parse(await page.evaluate(() => window.__exportBlob.text()));
    assert.equal(exported.format, "orkestr-free-workout-log");
    assert.equal(exported.sets.length, 3);
    assert.equal(exported.settings.restSeconds, 5);

    // Delete all, then import the export back.
    await page.click("#wl-delete-all");
    assert.equal(await text(page, "#wl-set-count"), "0");
    assert.equal(await page.evaluate(() => localStorage.getItem("orkestr.free.workoutLog.v1")), null);
    const exportFile = path.join(home, "export.json");
    await fs.writeFile(exportFile, JSON.stringify(exported));
    const input = await page.$("#wl-import");
    await input.uploadFile(exportFile);
    await page.waitForFunction(() => document.getElementById("wl-data-status").textContent.startsWith("Imported 3 new sets"));
    await input.uploadFile(exportFile);
    await page.waitForFunction(() => document.getElementById("wl-data-status").textContent.startsWith("Imported 0 new sets"));

    // Rejected imports explain why and leave existing data byte-for-byte unchanged.
    const storedBefore = await page.evaluate(() => localStorage.getItem("orkestr.free.workoutLog.v1"));
    const badFiles = [
      ["{not json", /not valid JSON/],
      ["", /empty/],
      [JSON.stringify({ format: "something-else", sets: [] }), /not a workout log export/],
      [JSON.stringify({ ...exported, version: 7 }), /unsupported version/],
      [JSON.stringify({ ...exported, sets: [...exported.sets, { id: "new1", date: "2026-10-09", exercise: "Row", reps: 8, weight: 60 }, { id: "bad", date: "not-a-date", exercise: "Row", reps: -3 }] }), /1 of 5 entries .* invalid/],
      [JSON.stringify({ ...exported, padding: "x".repeat(2 * 1024 * 1024) }), /at most 2 MB/],
    ];
    for (const [content, message] of badFiles) {
      await page.$eval("#wl-data-status", (node) => { node.textContent = ""; });
      await fs.writeFile(exportFile, content);
      await input.uploadFile(exportFile);
      await page.waitForFunction(() => document.getElementById("wl-data-status").textContent !== "");
      const status = await text(page, "#wl-data-status");
      assert.match(status, message);
      assert.match(status, /Nothing was imported; your existing data is unchanged\./);
      assert.equal(await page.$eval("#wl-data-status", (node) => node.classList.contains("wl-error")), true);
      assert.equal(await page.evaluate(() => localStorage.getItem("orkestr.free.workoutLog.v1")), storedBefore, `data unchanged after ${message}`);
    }
    assert.equal(await text(page, "#wl-set-count"), "3");
    assert.match(await text(page, "#wl-storage-notice"), /Browser storage can be lost.*private or incognito.*another browser or device.*Export a JSON file regularly/s);

    // A running rest timer survives a reload.
    await page.click("[data-rest='60']");
    await page.waitForFunction(() => !document.getElementById("wl-timer-stop").disabled);

    // Persistence across reloads and mobile layout without horizontal scroll.
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
    assert.equal(await text(page, "#wl-set-count"), "3");
    assert.equal(await text(page, "#wl-timer-status"), "Rest timer resumed after the page reloaded.");
    assert.equal(await page.$eval("#wl-timer-stop", (node) => node.disabled), false);
    assert.match(await text(page, "#wl-timer-display"), /^0:(5\d|60)$|^1:00$/);
    await page.click("#wl-timer-stop");
    // History survives the reload too.
    await page.select("#wl-progress-exercise", "Squat");
    assert.equal(await page.$$eval("#wl-progress-rows tr", (rows) => rows.length), 2);
    assert.match(await text(page, "#wl-best-set"), /100 kg × 5 \(2026-10-08\)/);

    // Keyboard only: skip link first, then fill the form with Tab and submit with Enter.
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute("tabindex");
    });
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.className), "skip-link");
    await page.focus("#wl-exercise");
    await page.keyboard.type("Row");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "wl-weight");
    await page.keyboard.type("60");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "wl-unit");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "wl-reps");
    await page.keyboard.type("8");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("wl-form-status").textContent.startsWith("Added Row"));
    assert.equal(await page.evaluate(() => document.activeElement.id), "wl-reps", "focus stays in the form for the next set");
    // Repeated Enter / double tap does not log the same set twice.
    await page.keyboard.press("Enter");
    assert.match(await text(page, "#wl-form-status"), /repeated tap was ignored/);
    await page.$eval("#wl-weight", (node) => { node.value = "62.5"; });
    await page.$eval("#wl-set-form button[type=submit]", (button) => { button.click(); button.click(); });
    assert.match(await text(page, "#wl-form-status"), /repeated tap was ignored/);
    assert.equal(await text(page, "#wl-set-count"), "5");
    await page.click("#wl-timer-stop");
    // Removing a set keeps keyboard focus in the day list section.
    await page.focus("#wl-day-list li:last-child button");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "wl-day-title");
    assert.equal(await text(page, "#wl-set-count"), "4");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow at 390px");
    const smallTargets = await page.$$eval("button:not(.wl-link), input:not([type=checkbox]):not([type=file]), select", (nodes) => nodes.filter((node) => node.getBoundingClientRect().height < 40).length);
    assert.equal(smallTargets, 0, "touch targets are at least 40px high");

    // Works offline once the service worker has cached the page.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
    assert.equal(await text(page, "#wl-set-count"), "4");
    await page.setOfflineMode(false);

    // After load the page sends nothing back: page code never called a network
    // API across every load, reload, and the offline reload above...
    assert.deepEqual(pageCalls, [], "no fetch/XHR/sendBeacon/WebSocket/EventSource from page code");
    // ...and the browser only ever requested the page's own static files.
    const network = requests.filter((request) => ["fetch", "xhr", "eventsource", "websocket", "ping"].includes(request.type));
    assert.deepEqual(network, [], "the page made no fetch/XHR/beacon requests");
    // Chrome draws the date-picker icon from a data: URL; that is not a network request.
    for (const request of requests.filter((item) => !item.url.startsWith("data:"))) {
      const url = new URL(request.url);
      assert.equal(url.origin, origin, `unexpected origin ${request.url}`);
      assert.ok(allowedPaths.has(url.pathname), `unexpected request ${url.pathname}`);
      assert.equal(request.method, "GET");
    }
    assert.deepEqual(errors, []);

    // The page CSP also blocks connections if a script ever tried one.
    const blocked = await page.evaluate(() => fetch("/api/public/events", { method: "POST", body: "{}" }).then(() => "sent", () => "blocked"));
    assert.equal(blocked, "blocked");
    assert.deepEqual(pageCalls, ["fetch /api/public/events"], "the spy sees calls, so the empty list above is meaningful");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
});
