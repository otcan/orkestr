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

async function waitUntil(page, fn, label) {
  try {
    await page.waitForFunction(fn, { timeout: 15_000 });
  } catch (error) {
    throw new Error(`Timed out waiting for: ${label} (${error.message})`);
  }
}

// Keyboard activation: independent of smooth scrolling (a mouse click computed
// mid-scroll can land on the sticky header) and exercises keyboard access.
async function activate(page, selector) {
  await page.$eval(selector, (node) => node.focus());
  await page.keyboard.press("Enter");
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
    assert.equal(await count(page, "#ed-sources > li"), 8);
    assert.doesNotMatch(await page.$eval("#ed-app", (node) => node.textContent), /\[object |undefined|NaN/);
    assert.match(await text(page, "#ed-source-s1"), /Cited by: E6 on C1/);
    if (shots) await page.screenshot({ path: path.join(shots, "evidence-desk-desktop.png"), fullPage: true });

    // Create a claim using only the keyboard.
    await page.focus("#ed-new-claim");
    await page.keyboard.type("Evening workshops increased tool returns.");
    await page.keyboard.press("Enter");
    await waitUntil(page, () => document.activeElement?.id === "ed-detail-title", "step 1");
    assert.equal(await count(page, "#ed-claims > li"), 6);
    assert.equal(await text(page, "#ed-detail-title"), "Evening workshops increased tool returns.");
    assert.match(await text(page, "#ed-detail .ed-score-label"), /No evidence/);

    // Attach evidence and see the score move.
    await page.type("#ed-new-evidence-source", "Synthetic workshop sign-in sheet");
    await page.keyboard.press("Enter");
    await waitUntil(page, () => document.querySelector("#ed-detail .ed-score strong")?.textContent === "75", "step 2");
    assert.match(await text(page, "#ed-detail .ed-score-label"), /Thin evidence/);

    // Edit that evidence into a contradicting item.
    await page.click("#ed-detail .ed-evidence-list button[aria-label^='Edit evidence']");
    const editForm = "#ed-detail .ed-evidence.is-editing form";
    await page.select(`${editForm} select[name=stance]`, "contradicts");
    await activate(page, `${editForm} button[type=submit]`);
    await waitUntil(page, () => document.querySelector("#ed-detail .ed-score strong")?.textContent === "25", "step 3");
    assert.match(await text(page, "#ed-detail .ed-evidence-list .ed-badge"), /Contradicts/);

    // Every evidence item links to an in-app source record.
    await activate(page, "#ed-detail .ed-evidence-list .ed-source-link");
    await waitUntil(page, () => /^ed-source-s\d+$/.test(document.activeElement?.id || ""), "step 4");
    assert.match(await page.evaluate(() => document.activeElement.textContent), /Synthetic workshop sign-in sheet[\s\S]*Provenance: Entered in this browser/);

    // Link it as contradicting another claim, then record an accept decision.
    await activate(page, "#ed-detail .ed-link-form button[type=submit]");
    await waitUntil(page, () => document.querySelectorAll("#ed-detail .ed-links button.ed-link-button").length === 1, "step 5");
    const queued = await page.$$eval("#ed-queue > li > button", (nodes) => nodes.map((node) => node.textContent));
    assert.ok(queued.includes("Evening workshops increased tool returns."));
    await page.select("#ed-decision-outcome", "accepted");
    await page.type("#ed-decision-rationale", "Checked against the synthetic sheet.");
    await activate(page, "#ed-detail form[aria-label='Record review decision'] button[type=submit]");
    await waitUntil(page, () => ![...document.querySelectorAll("#ed-queue > li > button")].some((node) => node.textContent.startsWith("Evening workshops")), "step 6");
    assert.match(await text(page, "#ed-detail .ed-review-status"), /Decision: Accepted — Checked against the synthetic sheet\./);

    // Editing the claim reopens review and is written to the decision history.
    await page.$eval("#ed-claim-text", (node) => { node.value = ""; });
    await page.type("#ed-claim-text", "Evening workshops increased on-time returns.");
    await activate(page, "#ed-detail form[aria-label='Edit claim'] button[type=submit]");
    await waitUntil(page, () => document.querySelector("#ed-detail-title")?.textContent === "Evening workshops increased on-time returns.", "step 7");
    assert.ok((await page.$$eval("#ed-queue > li > button", (nodes) => nodes.map((node) => node.textContent))).includes("Evening workshops increased on-time returns."));
    const history = await page.$$eval("#ed-detail .ed-history > li", (nodes) => nodes.map((node) => node.textContent));
    assert.match(history[0], /Earlier review decision cleared: claim text changed/);
    assert.ok(history.some((entry) => /Review decision: Accepted/.test(entry)));

    // Exports are generated in the browser and are byte-identical for the same data.
    await page.evaluate(() => {
      window.__exports = [];
      const original = URL.createObjectURL;
      URL.createObjectURL = (blob) => { window.__exports.push(blob); return original.call(URL, blob); };
    });
    await activate(page, "#ed-export-json");
    await activate(page, "#ed-export-md");
    await activate(page, "#ed-export-json");
    const exported = await page.evaluate(async () => Promise.all(window.__exports.map((blob) => blob.text())));
    assert.equal(exported[0], exported[2]);
    const json = JSON.parse(exported[0]);
    assert.equal(json.synthetic, true);
    assert.equal(json.claims.length, 6);
    assert.equal(json.checksum, await text(page, "#ed-checksum"));
    assert.match(exported[1], /# Evidence desk summary — fictional demo data/);
    assert.match(exported[1], /Evening workshops increased on-time returns\./);
    assert.match(exported[1], /Not a calibrated or scientific confidence measure/);

    // Keyboard selection of a claim from the list moves focus to the detail panel.
    await page.focus("#ed-claims > li:first-child button.ed-claim-open");
    await page.keyboard.press("Enter");
    await waitUntil(page, () => document.activeElement?.id === "ed-detail-title" && document.activeElement.textContent.includes("Brindlemere"), "step 8");

    // State persists across reloads, and reset restores the sample.
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("#ed-app:not([hidden])");
    assert.equal(await count(page, "#ed-claims > li"), 6);
    await activate(page, "#ed-reset");
    await waitUntil(page, () => document.querySelectorAll("#ed-claims > li").length === 5, "step 9");
    assert.match(await text(page, "#ed-status"), /reset/i);

    // Mobile width: no horizontal overflow and controls stay reachable.
    await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("#ed-app:not([hidden])");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
    await page.tap("#ed-claims > li:nth-child(2) button.ed-claim-open");
    await waitUntil(page, () => document.querySelector("#ed-detail-title")?.textContent.includes("Saturdays"), "step 10");
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
