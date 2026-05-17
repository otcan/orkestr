import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanupVirtualBrowser,
  listVirtualBrowsers,
  openVirtualBrowser,
  prepareVirtualBrowser,
  stopVirtualBrowser,
} from "../packages/browsers/src/browsers.js";
import { listEvents } from "../packages/storage/src/store.js";

test("virtual browsers can be prepared without launching Chrome", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-browsers-"));
  const env = { ORKESTR_HOME: home, ORKESTR_BROWSER_LAUNCH_DISABLED: "1" };

  const prepared = await prepareVirtualBrowser("linkedin", env);
  const opened = await openVirtualBrowser("linkedin", env);
  const browsers = await listVirtualBrowsers(env);
  const events = await listEvents(env);

  assert.equal(prepared.slug, "linkedin");
  assert.equal(opened.launched, false);
  assert.equal(opened.debugPort, 9223);
  assert.equal(browsers.find((browser) => browser.slug === "linkedin").configured, true);
  assert.equal(browsers.find((browser) => browser.slug === "linkedin").type, "desktop");
  assert.equal(events.at(-1).type, "browser_open_requested");
});

test("virtual browser management exposes stop and cleanup actions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-browsers-"));
  const env = { ORKESTR_HOME: home, ORKESTR_BROWSER_LAUNCH_DISABLED: "1" };

  await prepareVirtualBrowser("desktop", env);
  const stopped = await stopVirtualBrowser("desktop", env);
  const cleaned = await cleanupVirtualBrowser("desktop", env);
  const browsers = await listVirtualBrowsers(env);
  const desktop = browsers.find((browser) => browser.slug === "desktop");

  assert.equal(stopped.slug, "desktop");
  assert.equal(cleaned.cleaned, true);
  assert.equal(desktop.configured, false);
  assert.equal(desktop.status, "not_prepared");
});
