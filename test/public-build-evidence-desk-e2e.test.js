import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";

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

const count = (page, selector) => page.$$eval(selector, (nodes) => nodes.length);
const text = (page, selector) => page.$eval(selector, (node) => node.textContent.trim());

test("evidence desk create, edit, link, score, review, export and reset flows work in a real browser", async (t) => {
  const puppeteer = await loadPuppeteer(t);
  if (!puppeteer) return;
  const chrome = await findChrome();
  if (!chrome) {
    t.skip("No Chrome or Chromium executable available for browser e2e.");
    return;
  }
  try {
    await (await puppeteer.launch({ headless: "new", executablePath: chrome, args: ["--no-sandbox", "--disable-setuid-sandbox"] })).close();
  } catch (error) {
    t.skip(`Browser could not start on this host: ${error.message.split("\n")[0]}`);
    return;
  }
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-evidence-desk-e2e-"));
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const shots = process.env.EVIDENCE_DESK_SCREENSHOT_DIR || "";
  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new", executablePath: chrome, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errors = [];
    const foreign = [];
    page.on("pageerror", (error) => errors.push(error.message || String(error)));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("request", (request) => { if (!request.url().startsWith(baseUrl) && !request.url().startsWith("blob:") && !request.url().startsWith("data:")) foreign.push(request.url()); });
    page.on("dialog", (dialog) => dialog.accept());

    const response = await page.goto(`${baseUrl}/builds/evidence-desk`, { waitUntil: "networkidle0" });
    assert.equal(response.status(), 200);
    await page.waitForSelector("#ed-app:not([hidden])");
    assert.equal(await count(page, "#ed-claims > li"), 5);
    assert.ok(await count(page, "#ed-queue > li") >= 3);
    if (shots) await page.screenshot({ path: path.join(shots, "evidence-desk-desktop.png"), fullPage: true });

    // Create a claim using only the keyboard.
    await page.focus("#ed-new-claim");
    await page.keyboard.type("Evening workshops increased tool returns.");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.id === "ed-detail-title");
    assert.equal(await count(page, "#ed-claims > li"), 6);
    assert.equal(await text(page, "#ed-detail-title"), "Evening workshops increased tool returns.");
    assert.match(await text(page, "#ed-detail .ed-score-label"), /No evidence/);

    // Attach evidence and see the score move.
    await page.type("#ed-new-evidence-source", "Synthetic workshop sign-in sheet");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#ed-detail .ed-score strong")?.textContent === "75");
    assert.match(await text(page, "#ed-detail .ed-score-label"), /Thin evidence/);

    // Edit that evidence into a contradicting item.
    await page.click("#ed-detail .ed-evidence-list button[aria-label^='Edit evidence']");
    const editForm = "#ed-detail .ed-evidence.is-editing form";
    await page.select(`${editForm} select[name=stance]`, "contradicts");
    await page.click(`${editForm} button[type=submit]`);
    await page.waitForFunction(() => document.querySelector("#ed-detail .ed-score strong")?.textContent === "25");
    assert.match(await text(page, "#ed-detail .ed-evidence-list .ed-badge"), /Contradicts/);

    // Link it as contradicting another claim, then mark it reviewed.
    await page.click("#ed-detail .ed-link-form button[type=submit]");
    await page.waitForFunction(() => document.querySelectorAll("#ed-detail .ed-links button.ed-link-button").length === 1);
    const queued = await page.$$eval("#ed-queue > li > button", (nodes) => nodes.map((node) => node.textContent));
    assert.ok(queued.includes("Evening workshops increased tool returns."));
    await page.click("#ed-detail .ed-review button");
    await page.waitForFunction(() => ![...document.querySelectorAll("#ed-queue > li > button")].some((node) => node.textContent.startsWith("Evening workshops")));

    // Edit the claim text.
    await page.$eval("#ed-claim-text", (node) => { node.value = ""; });
    await page.type("#ed-claim-text", "Evening workshops increased on-time returns.");
    await page.click("#ed-detail form[aria-label='Edit claim'] button[type=submit]");
    await page.waitForFunction(() => document.querySelector("#ed-detail-title")?.textContent === "Evening workshops increased on-time returns.");

    // Exports are generated in the browser.
    await page.evaluate(() => {
      window.__exports = [];
      const original = URL.createObjectURL;
      URL.createObjectURL = (blob) => { window.__exports.push(blob); return original.call(URL, blob); };
    });
    await page.click("#ed-export-json");
    await page.click("#ed-export-md");
    const exported = await page.evaluate(async () => Promise.all(window.__exports.map((blob) => blob.text())));
    const json = JSON.parse(exported[0]);
    assert.equal(json.synthetic, true);
    assert.equal(json.claims.length, 6);
    assert.match(exported[1], /# Evidence desk summary \(synthetic demo data\)/);
    assert.match(exported[1], /Evening workshops increased on-time returns\./);

    // Keyboard selection of a claim from the list moves focus to the detail panel.
    await page.focus("#ed-claims > li:first-child button.ed-claim-open");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.id === "ed-detail-title" && document.activeElement.textContent.includes("Brindlemere"));

    // State persists across reloads, and reset restores the sample.
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("#ed-app:not([hidden])");
    assert.equal(await count(page, "#ed-claims > li"), 6);
    await page.click("#ed-reset");
    await page.waitForFunction(() => document.querySelectorAll("#ed-claims > li").length === 5);
    assert.match(await text(page, "#ed-status"), /reset/i);

    // Mobile width: no horizontal overflow and controls stay reachable.
    await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("#ed-app:not([hidden])");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
    await page.tap("#ed-claims > li:nth-child(2) button.ed-claim-open");
    await page.waitForFunction(() => document.querySelector("#ed-detail-title")?.textContent.includes("Saturdays"));
    if (shots) await page.screenshot({ path: path.join(shots, "evidence-desk-mobile.png"), fullPage: true });

    assert.deepEqual(errors, []);
    assert.deepEqual(foreign, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});
