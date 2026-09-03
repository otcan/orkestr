import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const opsComponentUrl = new URL("../apps/web/src/app/ops-page.component.ts", import.meta.url);
const userDeskComponentUrl = new URL("../apps/web/src/app/user-desk-page.component.ts", import.meta.url);
const userDeskTemplateUrl = new URL("../apps/web/src/app/user-desk-page.component.html", import.meta.url);

test("desktop open controls create brokered shares instead of navigating to direct VNC routes", async () => {
  const [opsComponent, userDeskComponent, userDeskTemplate] = await Promise.all([
    fs.readFile(opsComponentUrl, "utf8"),
    fs.readFile(userDeskComponentUrl, "utf8"),
    fs.readFile(userDeskTemplateUrl, "utf8"),
  ]);

  assert.match(opsComponent, /async openBrowserDesktop[\s\S]+?createDesktopShare\(slug, request\)/);
  assert.match(opsComponent, /if \(threadId\) return \{ threadId, start: false \};/);
  assert.match(userDeskComponent, /async openDesktop[\s\S]+?createDesktopShare\(slug, \{[\s\S]+?start: false/);
  assert.match(userDeskTemplate, /\(click\)="openDesktop\(browser\)"/);
  assert.doesNotMatch(userDeskTemplate, /\[href\]="browserOpenUrl\(browser\)"/);
});

test("user desktop lifecycle controls exchange the live lease for a single-use capability", async () => {
  const userDeskComponent = await fs.readFile(userDeskComponentUrl, "utf8");

  assert.match(userDeskComponent, /issueDesktopCapability\(threadId, \{[\s\S]+?fencingToken,[\s\S]+?scope: "lifecycle"/);
  assert.match(userDeskComponent, /browserAction\(slug, action, \{[\s\S]+?desktopCapability: issued\.capability/);
});
