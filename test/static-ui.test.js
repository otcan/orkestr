import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";

function assertAngularShell(html) {
  assert.match(html, /<ork-root(?:\s|>)/);
  assert.ok(html.includes("Loading Orkestr"));
  assert.match(html, /src="main[^"]*\.js"/);
}

test("server serves the built Angular UI at root", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-static-ui-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorOverlay = process.env.ORKESTR_OVERLAY_DIR;
  process.env.ORKESTR_HOME = home;
  delete process.env.ORKESTR_OVERLAY_DIR;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const html = await response.text();
    const onboardingResponse = await fetch(`http://127.0.0.1:${port}/setup`);
    const onboardingHtml = await onboardingResponse.text();
    const setupGmailResponse = await fetch(`http://127.0.0.1:${port}/setup/gmail`);
    const setupGoogleMarketingResponse = await fetch(`http://127.0.0.1:${port}/setup/google-marketing`);
    const workflowOnboardingResponse = await fetch(`http://127.0.0.1:${port}/onboarding`);
    const legacyOnboardingResponse = await fetch(`http://127.0.0.1:${port}/ng/onboarding`);
    const opsResponse = await fetch(`http://127.0.0.1:${port}/ops`);
    const threadResponse = await fetch(`http://127.0.0.1:${port}/thread/demo`);
    const googleMarketingStartResponse = await fetch(`http://127.0.0.1:${port}/google-marketing/oauth/start`, { redirect: "manual" });
    const googleMarketingStartHtml = await googleMarketingStartResponse.text();

    assert.equal(response.status, 200);
    assertAngularShell(html);
    assert.equal(onboardingResponse.status, 200);
    assertAngularShell(onboardingHtml);
    assert.equal(setupGmailResponse.status, 200);
    assert.equal(setupGoogleMarketingResponse.status, 200);
    assert.equal(workflowOnboardingResponse.status, 200);
    assert.equal(legacyOnboardingResponse.status, 200);
    assert.equal(opsResponse.status, 200);
    assert.equal(threadResponse.status, 200);
    assert.equal(googleMarketingStartResponse.status, 500);
    assert.ok(googleMarketingStartHtml.includes("Google Marketing auth failed"));
    assert.doesNotMatch(googleMarketingStartHtml, /<ork-root(?:\s|>)/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorOverlay === undefined) delete process.env.ORKESTR_OVERLAY_DIR;
    else process.env.ORKESTR_OVERLAY_DIR = priorOverlay;
  }
});

test("global shell keeps onboarding footer reachable", async () => {
  const styles = await fs.readFile("apps/web/src/styles.css", "utf8");
  const onboardingTemplate = await fs.readFile("apps/web/src/app/onboarding-page.component.html", "utf8");
  const bodyBlock = styles.match(/body\s*{[^}]*}/)?.[0] || "";

  assert.match(onboardingTemplate, /<footer class="setup-nav">/);
  assert.doesNotMatch(bodyBlock, /overflow:\s*hidden/);
  assert.match(styles, /\.app-shell\s*{[^}]*overflow:\s*hidden/s);
});

test("ops desktop links are only shown for running desktops", async () => {
  const template = await fs.readFile("apps/web/src/app/ops-page.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/ops-page.component.ts", "utf8");

  assert.match(template, /@if \(browserOpenUrl\(browser\)\)/);
  assert.doesNotMatch(template, /@if \(browser\.desk_url \|\| browser\.url\)/);
  assert.match(template, /\[disabled\]="browserActionBusy\(browser\)"/);
  assert.doesNotMatch(template, /browserAction\(browser, 'start'\)" \[disabled\]="busy"/);
  assert.match(component, /browserOpenUrl\(browser: BrowserSession\): string/);
  assert.match(component, /browserIsRunning\(browser: BrowserSession\): boolean/);
  assert.match(component, /"active", "running"/);
  assert.match(component, /\/desktop\/\$\{encodedSlug\}\/vnc\.html\?autoconnect=1&resize=scale&path=desktop\/\$\{encodedSlug\}\/websockify/);
  assert.doesNotMatch(component, /return String\(browser\.desk_url \|\| browser\.url \|\| ""\)\.trim\(\)/);
  assert.match(component, /browserMobileUrl\(browser: BrowserSession\): string/);
  assert.match(template, /browserMobileUrl\(browser\)/);
  assert.match(template, /\[class\.live\]="browserIsRunning\(browser\)"/);
  assert.match(component, /activeBrowserActionSlug/);
});

test("mobile desktop shell wraps noVNC with phone-first controls", async () => {
  const proxy = await fs.readFile("apps/server/src/desktop-proxy.ts", "utf8");
  const shell = await fs.readFile("apps/server/src/mobile-desktop-shell.ts", "utf8");
  const sharePage = await fs.readFile("apps/server/src/static-fallback.ts", "utf8");

  assert.match(proxy, /isMobileDesktopRoute/);
  assert.match(proxy, /serveMobileDesktopShell/);
  assert.match(proxy, /portFromEndpoint\(session\.upstream\)/);
  assert.ok(shell.includes('import RFB from "/desktop/${encodedSlug}/core/rfb.js"'));
  assert.match(shell, /id="touchpad">Touchpad/);
  assert.match(shell, /id="direct">Tap/);
  assert.match(shell, /id="keyboard">Keyboard/);
  assert.match(shell, /id="paste">Paste/);
  assert.match(shell, /id="ctrlV">Ctrl\+V/);
  assert.match(shell, /new WheelEvent\("wheel"/);
  assert.match(sharePage, /mobileDestination/);
  assert.match(sharePage, /id="mobile"/);
  assert.match(sharePage, /const desktopUrl = body\.desktopUrl/);
  assert.match(sharePage, /desktop\/.*\/mobile/);
});
