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
    const faviconSvgResponse = await fetch(`http://127.0.0.1:${port}/favicon.svg`);
    const faviconSvg = await faviconSvgResponse.text();
    const faviconIcoResponse = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    const faviconIco = await faviconIcoResponse.text();
    const googleMarketingStartResponse = await fetch(`http://127.0.0.1:${port}/google-marketing/oauth/start`, { redirect: "manual" });
    const googleMarketingStartHtml = await googleMarketingStartResponse.text();

    assert.equal(response.status, 200);
    assertAngularShell(html);
    assert.match(html, /rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/);
    assert.equal(onboardingResponse.status, 200);
    assertAngularShell(onboardingHtml);
    assert.equal(setupGmailResponse.status, 200);
    assert.equal(setupGoogleMarketingResponse.status, 200);
    assert.equal(workflowOnboardingResponse.status, 200);
    assert.equal(legacyOnboardingResponse.status, 200);
    assert.equal(opsResponse.status, 200);
    assert.equal(threadResponse.status, 200);
    assert.equal(faviconSvgResponse.status, 200);
    assert.match(faviconSvgResponse.headers.get("content-type") || "", /image\/svg\+xml/);
    assert.match(faviconSvg, /aria-label="Orkestr"/);
    assert.equal(faviconIcoResponse.status, 200);
    assert.match(faviconIcoResponse.headers.get("content-type") || "", /image\/svg\+xml/);
    assert.match(faviconIco, /aria-label="Orkestr"/);
    assert.doesNotMatch(faviconIco, /<ork-root(?:\s|>)/);
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

test("thread sidebar treats runtime interruption messages as errors", async () => {
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");

  assert.match(component, /this\.messagePhase\(message\) === "runtime_interrupted"/);
  assert.match(component, /thread\.lastMessagePhase \|\| ""\)\.toLowerCase\(\) === "runtime_interrupted"/);
  assert.match(component, /Codex conversation was interrupted\./);
});

test("ops desktop links are only shown for running desktops", async () => {
  const template = await fs.readFile("apps/web/src/app/ops-page.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/ops-page.component.ts", "utf8");
  const appTemplate = await fs.readFile("apps/web/src/app/app.component.html", "utf8");

  assert.match(appTemplate, />DESKTOPS<\/button>/);
  assert.match(appTemplate, /\(click\)="openTools\('desktops'\)"/);
  assert.match(template, /@if \(browserOpenUrl\(browser\)\)/);
  assert.doesNotMatch(template, /@if \(browser\.desk_url \|\| browser\.url\)/);
  assert.match(template, /\[disabled\]="browserActionBusy\(browser\)"/);
  assert.doesNotMatch(template, /browserAction\(browser, 'start'\)" \[disabled\]="busy"/);
  assert.match(component, /browserOpenUrl\(browser: BrowserSession\): string/);
  assert.match(component, /openBrowserDesktop\(browser: BrowserSession\): void/);
  assert.match(component, /browserIsRunning\(browser: BrowserSession\): boolean/);
  assert.match(component, /"active", "running"/);
  assert.match(component, /\/desktop\/\$\{encodedSlug\}\/vnc\.html\?autoconnect=1&resize=scale&path=desktop\/\$\{encodedSlug\}\/websockify/);
  assert.doesNotMatch(component, /return String\(browser\.desk_url \|\| browser\.url \|\| ""\)\.trim\(\)/);
  assert.match(template, /\(click\)="openBrowserDesktop\(browser\)"/);
  assert.match(template, />Open Desktop<\/button>/);
  assert.match(template, />Share Link<\/button>/);
  assert.match(template, />Threads<\/strong>/);
  assert.match(template, /desktopThreads\(browser\)/);
  assert.match(component, /desktopThreads\(browser: BrowserSession\)/);
  assert.match(component, /desktopThreadHref\(thread: Record<string, unknown>\)/);
  assert.doesNotMatch(template, /pid \{\{ browserPid/);
  assert.doesNotMatch(template, /CDP \{\{ browser\.debugPort/);
  assert.doesNotMatch(template, /browserOwner\(browser\)/);
  assert.doesNotMatch(template, />Open Desk<\/a>/);
  assert.doesNotMatch(template, />Mobile<\/a>/);
  assert.doesNotMatch(template, />CDP<\/a>/);
  assert.doesNotMatch(component, /browserMobileUrl\(browser: BrowserSession\): string/);
  assert.match(component, /shouldShowBrowserAction\(browser: BrowserSession/);
  assert.match(component, /action === "restart"\) return running/);
  assert.match(template, /\[class\.live\]="browserIsRunning\(browser\)"/);
  assert.match(component, /activeBrowserActionSlug/);
});

test("ops users page exposes targeted browser pairing and revocation", async () => {
  const template = await fs.readFile("apps/web/src/app/ops-page.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/ops-page.component.ts", "utf8");
  const securityPanel = await fs.readFile("apps/web/src/app/security-challenges-panel.component.html", "utf8");
  const securityComponent = await fs.readFile("apps/web/src/app/security-challenges-panel.component.ts", "utf8");

  assert.match(component, /SecurityChallenge, SecuritySession/);
  assert.match(component, /opsSecurityChallenges: SecurityChallenge\[\] = \[\]/);
  assert.match(component, /opsSecuritySessions: SecuritySession\[\] = \[\]/);
  assert.match(component, /firstValueFrom\(this\.api\.securitySessions\(\)\)/);
  assert.match(component, /createSecurityChallengeForUser\(user\.id\)/);
  assert.match(component, /revokeUserSession\(session: SecuritySession\)/);
  assert.match(component, /userBrowserSessions\(user: OrkestrUser\): SecuritySession\[\]/);
  assert.match(component, /userBrowserChallenges\(user: OrkestrUser\): SecurityChallenge\[\]/);
  assert.match(template, /Browser access/);
  assert.match(template, /userBrowserChallenges\(user\)/);
  assert.match(template, /orkestr security approve \{\{ challenge\.id \}\}/);
  assert.match(template, /userBrowserSessions\(user\)/);
  assert.match(template, /\(click\)="revokeUserSession\(session\)"/);
  assert.match(securityPanel, /Target \{\{ challengeTarget\(challenge\) \}\}/);
  assert.match(securityPanel, /Assigned to \{\{ sessionTarget\(session\) \}\}/);
  assert.match(securityComponent, /challengeTarget\(challenge: SecurityChallenge\): string/);
  assert.match(securityComponent, /sessionTarget\(session: SecuritySession\): string/);
});

test("thread settings exposes detailed repo metadata editing", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");

  assert.match(template, /thread-settings-remote-url-/);
  assert.match(template, /thread-settings-remote-branch-/);
  assert.match(template, /thread-settings-base-branch-/);
  assert.match(template, /Working branch/);
  assert.match(component, /threadRemoteUrlDraft/);
  assert.match(component, /threadRemoteBranchDraft/);
  assert.match(component, /threadBaseBranchDraft/);
  assert.match(component, /repoRemoteUrl: this\.threadRemoteUrlDraft\.trim\(\)/);
  assert.match(component, /remoteBranch: this\.threadRemoteBranchDraft\.trim\(\)/);
  assert.match(component, /baseBranch: this\.threadBaseBranchDraft\.trim\(\)/);
});

test("web shell switches to a constrained non-admin user mode", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const usersController = await fs.readFile("apps/server/src/modules/users/users.controller.ts", "utf8");
  const styles = await fs.readFile("apps/web/src/styles.css", "utf8");

  assert.match(api, /currentUser\(\): Observable<UserResponse>/);
  assert.match(usersController, /@Get\("me"\)/);
  assert.match(component, /currentUser: OrkestrUser \| null = null/);
  assert.match(component, /firstValueFrom\(this\.api\.currentUser\(\)\)/);
  assert.match(component, /shouldShowCodexRequiredShell\(\): boolean/);
  assert.match(component, /this\.appReady && this\.isAdminMode\(\) && !this\.codexAgentReady\(\)/);
  assert.match(component, /uiRuntimeReady\(\): boolean/);
  assert.match(component, /return this\.isUserMode\(\) \|\| this\.codexAgentReady\(\)/);
  assert.match(component, /panelAllowedForCurrentUser\(panel: Panel\): boolean/);
  assert.match(component, /\["chat", "history", "timers"\]\.includes\(panel\)/);
  assert.match(component, /normalizeUserModeView\(\)/);
  assert.match(component, /This user account is limited to one chat\./);
  assert.match(template, /\[class\.user-mode\]="isUserMode\(\)"/);
  assert.match(template, /class="user-mode-card"/);
  assert.match(template, /\[placeholder\]="sidebarSearchPlaceholder\(\)"/);
  assert.match(template, /@if \(isAdminMode\(\) && visibleChildWorkers\(thread\)\.length > 0\)/);
  assert.match(template, /@if \(activePanel === "settings" && isAdminMode\(\)\)/);
  assert.match(template, /@if \(activePanel === "workers" && isAdminMode\(\)\)/);
  assert.match(template, /@if \(isAdminMode\(\)\) \{\s*<div class="codex-control-scroll"/s);
  assert.match(template, /\[disabled\]="!threadInputReady\(\)"/);
  assert.match(styles, /\.user-mode-card/);
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
