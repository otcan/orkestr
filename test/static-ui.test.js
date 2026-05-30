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
    const filesResponse = await fetch(`http://127.0.0.1:${port}/files`);
    const timersResponse = await fetch(`http://127.0.0.1:${port}/timers`);
    const deskResponse = await fetch(`http://127.0.0.1:${port}/desk`);
    const connectorsResponse = await fetch(`http://127.0.0.1:${port}/connectors`);
    const skillsResponse = await fetch(`http://127.0.0.1:${port}/skills`);
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
    assert.equal(filesResponse.status, 200);
    assert.equal(timersResponse.status, 200);
    assert.equal(deskResponse.status, 200);
    assert.equal(connectorsResponse.status, 200);
    assert.equal(skillsResponse.status, 200);
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

test("ops audit view exposes normalized filterable events", async () => {
  const template = await fs.readFile("apps/web/src/app/ops-page.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/ops-page.component.ts", "utf8");
  const appComponent = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const auditEvents = await fs.readFile("packages/core/src/audit-events.js", "utf8");
  const sanitizer = await fs.readFile("packages/core/src/llm-sanitizer.js", "utf8");
  const systemController = await fs.readFile("apps/server/src/modules/system/system.controller.ts", "utf8");
  const styles = await fs.readFile("apps/web/src/styles.css", "utf8");

  assert.match(component, /export type ToolsView = .*"audit"/);
  assert.match(appComponent, /"connectors", "users", "audit"/);
  assert.match(template, /\[class\.active\]="toolsView === 'audit'"/);
  assert.match(template, /setToolsView\('audit'\)">Audit<\/button>/);
  assert.match(template, /@if \(toolsView === "audit"\)/);
  assert.match(template, /name="audit-user-filter"/);
  assert.match(template, /name="audit-resource-filter"/);
  assert.match(template, /name="audit-connector-filter"/);
  assert.match(template, /name="audit-outcome-filter"/);
  assert.match(component, /filteredAuditEvents\(\): EventRecord\[\]/);
  assert.match(component, /auditEventMeta\(event: EventRecord\): string/);
  assert.match(api, /events\(limit = 50, filters: Record<string, string> = \{\}\)/);
  assert.match(systemController, /@Query\("connector"\) connector = ""/);
  assert.match(auditEvents, /normalizeAuditEvent\(event = \{\}/);
  assert.match(auditEvents, /sensitiveAuditKey/);
  assert.match(sanitizer, /type: "policy_sanitizer_decision"/);
  assert.match(styles, /\.audit-filters/);
  assert.match(styles, /\.audit-row small/);
});

test("ops users page exposes WhatsApp identity binding controls", async () => {
  const template = await fs.readFile("apps/web/src/app/ops-page.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/ops-page.component.ts", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const usersController = await fs.readFile("apps/server/src/modules/users/users.controller.ts", "utf8");

  assert.match(api, /export interface UserIdentity/);
  assert.match(api, /userIdentities\(id: string\): Observable<UserIdentitiesResponse>/);
  assert.match(api, /linkWhatsAppIdentity\(id: string, body: Record<string, unknown>\)/);
  assert.match(api, /unlinkWhatsAppIdentity\(id: string, body: Record<string, unknown>\)/);
  assert.match(usersController, /@Post\(":userId\/identities\/whatsapp"\)/);
  assert.match(usersController, /@Post\(":userId\/identities\/whatsapp\/unlink"\)/);
  assert.match(component, /opsUserIdentities: UserIdentity\[\] = \[\]/);
  assert.match(component, /loadSelectedUserIdentities\(showBusy = true\)/);
  assert.match(component, /linkWhatsAppIdentity\(user: OrkestrUser\)/);
  assert.match(component, /unlinkWhatsAppIdentity\(user: OrkestrUser, identity: UserIdentity\)/);
  assert.match(component, /selectedUserWhatsAppIdentities\(user: OrkestrUser\): UserIdentity\[\]/);
  assert.match(component, /whatsappIdentitySource\(identity: UserIdentity\): string/);
  assert.match(template, /WhatsApp identities/);
  assert.match(template, /wa-identity-sender-/);
  assert.match(template, /wa-identity-chat-/);
  assert.match(template, /\(submit\)="linkWhatsAppIdentity\(user\); \$event\.preventDefault\(\)"/);
  assert.match(template, /\(click\)="unlinkWhatsAppIdentity\(user, identity\)"/);
});

test("ops users page exposes Gmail and Outlook account assignment controls", async () => {
  const template = await fs.readFile("apps/web/src/app/ops-page.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/ops-page.component.ts", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const usersController = await fs.readFile("apps/server/src/modules/users/users.controller.ts", "utf8");

  assert.match(api, /linkMailIdentity\(id: string, provider: "gmail" \| "outlook" \| string, body: Record<string, unknown>\)/);
  assert.match(api, /unlinkMailIdentity\(id: string, provider: "gmail" \| "outlook" \| string, body: Record<string, unknown>\)/);
  assert.match(api, /startUserGmailOAuth\(id: string, body: Record<string, unknown> = \{\}\)/);
  assert.match(api, /startUserOutlookOAuth\(id: string, body: Record<string, unknown> = \{\}\)/);
  assert.match(usersController, /@Post\(":userId\/identities\/:provider"\)/);
  assert.match(usersController, /@Post\(":userId\/connectors\/gmail\/oauth\/start"\)/);
  assert.match(usersController, /@Post\(":userId\/connectors\/outlook\/oauth\/start"\)/);
  assert.match(component, /mailIdentityProvider: MailIdentityProvider = "gmail"/);
  assert.match(component, /linkMailIdentity\(user: OrkestrUser\)/);
  assert.match(component, /unlinkMailIdentity\(user: OrkestrUser, identity: UserIdentity\)/);
  assert.match(component, /startUserMailOAuth\(user: OrkestrUser\)/);
  assert.match(component, /selectedUserMailIdentities\(user: OrkestrUser\): UserIdentity\[\]/);
  assert.match(template, /Mail accounts/);
  assert.match(template, /mail-identity-provider-/);
  assert.match(template, /mail-identity-account-/);
  assert.match(template, /\(submit\)="linkMailIdentity\(user\); \$event\.preventDefault\(\)"/);
  assert.match(template, /\(click\)="startUserMailOAuth\(user\)"/);
  assert.match(template, /\(click\)="unlinkMailIdentity\(user, identity\)"/);
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
  assert.match(component, /\["chat", "history", "timers", "files", "userTimers", "userDesk", "userConnectors", "userSkills"\]\.includes\(panel\)/);
  assert.match(component, /normalizeUserModeView\(\)/);
  assert.match(component, /isUserNavPanelActive\(panel: Panel\): boolean/);
  assert.match(component, /isRouteLevelUserPanel\(panel: Panel\): boolean/);
  assert.match(component, /This user account is limited to one chat\./);
  assert.match(template, /\[class\.user-mode\]="isUserMode\(\)"/);
  assert.match(template, /class="user-mode-card"/);
  assert.match(template, /class="user-mode-nav"/);
  assert.match(template, /\(click\)="openPanel\('chat'\)">Chat<\/button>/);
  assert.match(template, /\(click\)="openPanel\('files'\)">Files<\/button>/);
  assert.match(template, /\(click\)="openPanel\('userTimers'\)">Timers<\/button>/);
  assert.match(template, /\(click\)="openPanel\('userDesk'\)">Desk<\/button>/);
  assert.match(template, /\(click\)="openPanel\('userConnectors'\)">Connectors<\/button>/);
  assert.match(template, /\(click\)="openPanel\('userSkills'\)">Skills<\/button>/);
  assert.match(template, /\[placeholder\]="sidebarSearchPlaceholder\(\)"/);
  assert.match(template, /@if \(isAdminMode\(\) && visibleChildWorkers\(thread\)\.length > 0\)/);
  assert.match(template, /@if \(activePanel === "settings" && isAdminMode\(\)\)/);
  assert.match(template, /@if \(activePanel === "workers" && isAdminMode\(\)\)/);
  assert.match(template, /@if \(isAdminMode\(\)\) \{\s*<div class="codex-control-scroll"/s);
  assert.match(template, /\[disabled\]="!threadInputReady\(\)"/);
  assert.match(styles, /\.user-mode-card/);
  assert.match(styles, /\.user-mode-nav/);
});

test("web shell exposes a user timer management page", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const timersComponent = await fs.readFile("apps/web/src/app/user-timers-page.component.ts", "utf8");
  const timersTemplate = await fs.readFile("apps/web/src/app/user-timers-page.component.html", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const styles = await fs.readFile("apps/web/src/styles.css", "utf8");

  assert.match(component, /import \{ UserTimersPageComponent \} from "\.\/user-timers-page\.component"/);
  assert.match(component, /type Panel = .*"userTimers"/);
  assert.match(component, /parts\[0\] === "timers"/);
  assert.match(component, /parts\[0\] === "ng" && parts\[1\] === "timers"/);
  assert.match(component, /!this\.isRouteLevelUserPanel\(this\.activePanel\) && !this\.selectedId && this\.threads\.length/);
  assert.match(component, /panel === "userTimers"\) return "\/timers"/);
  assert.match(component, /globalThis\.document\.title = "Timers · Orkestr"/);
  assert.match(template, /<ork-user-timers-page><\/ork-user-timers-page>/);
  assert.match(template, /\(click\)="openPanel\('userTimers'\)"/);
  assert.match(timersComponent, /selector: "ork-user-timers-page"/);
  assert.match(timersComponent, /this\.api\.threads\(\)/);
  assert.match(timersComponent, /this\.api\.timers\(\)/);
  assert.match(timersComponent, /this\.api\.createTimer\(body\)/);
  assert.match(timersComponent, /this\.api\.runTimer\(timer\.id\)/);
  assert.match(timersComponent, /this\.api\.deleteTimer\(timer\.id\)/);
  assert.match(timersComponent, /targetType: "thread"/);
  assert.match(timersTemplate, /name="user-timer-target"/);
  assert.match(api, /createTimer\(body: Record<string, string>\)/);
  assert.match(api, /deleteTimer\(id: string\)/);
  assert.match(api, /runTimer\(id: string\)/);
  assert.match(styles, /\.user-timer-editor/);
  assert.match(styles, /\.timer-actions/);
});

test("web shell exposes a user desktop desk page", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const deskComponent = await fs.readFile("apps/web/src/app/user-desk-page.component.ts", "utf8");
  const deskTemplate = await fs.readFile("apps/web/src/app/user-desk-page.component.html", "utf8");
  const opsComponent = await fs.readFile("apps/web/src/app/ops-page.component.ts", "utf8");
  const opsTemplate = await fs.readFile("apps/web/src/app/ops-page.component.html", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const styles = await fs.readFile("apps/web/src/styles.css", "utf8");

  assert.match(component, /import \{ UserDeskPageComponent \} from "\.\/user-desk-page\.component"/);
  assert.match(component, /type Panel = .*"userDesk"/);
  assert.match(component, /parts\[0\] === "desk"/);
  assert.match(component, /parts\[0\] === "ng" && parts\[1\] === "desk"/);
  assert.match(component, /panel === "userDesk"\) return "\/desk"/);
  assert.match(component, /globalThis\.document\.title = "Desk · Orkestr"/);
  assert.match(template, /<ork-user-desk-page><\/ork-user-desk-page>/);
  assert.match(template, /\(click\)="openPanel\('userDesk'\)"/);
  assert.match(deskComponent, /selector: "ork-user-desk-page"/);
  assert.match(deskComponent, /this\.api\.browserSessions\(\)/);
  assert.match(deskComponent, /this\.api\.desktopLeases\(\)/);
  assert.match(deskComponent, /this\.api\.acquireDesktopLease\(slug/);
  assert.match(deskComponent, /this\.api\.releaseDesktopLease\(slug/);
  assert.match(deskComponent, /this\.api\.createDesktopShare\(slug\)/);
  assert.match(deskTemplate, /Open Desktop/);
  assert.match(deskTemplate, /Reserve/);
  assert.match(api, /interface DesktopLeaseRecord/);
  assert.match(api, /desktopLeases\(includeReleased = false\)/);
  assert.match(api, /acquireDesktopLease\(slug: string/);
  assert.match(api, /releaseDesktopLease\(slug: string/);
  assert.match(opsComponent, /opsDesktopLeases: DesktopLeaseRecord\[\] = \[\]/);
  assert.match(opsComponent, /firstValueFrom\(this\.api\.desktopLeases\(\)\)/);
  assert.match(opsComponent, /forceReleaseDesktopLease\(lease: DesktopLeaseRecord\)/);
  assert.match(opsTemplate, /Desktop leases/);
  assert.match(styles, /\.user-desk-grid/);
  assert.match(styles, /\.desktop-lease-list/);
});

test("web shell exposes a user connector management page", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const connectorsComponent = await fs.readFile("apps/web/src/app/user-connectors-page.component.ts", "utf8");
  const connectorsTemplate = await fs.readFile("apps/web/src/app/user-connectors-page.component.html", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const styles = await fs.readFile("apps/web/src/styles.css", "utf8");

  assert.match(component, /import \{ UserConnectorsPageComponent \} from "\.\/user-connectors-page\.component"/);
  assert.match(component, /type Panel = .*"userConnectors"/);
  assert.match(component, /parts\[0\] === "connectors"/);
  assert.match(component, /parts\[0\] === "ng" && parts\[1\] === "connectors"/);
  assert.match(component, /panel === "userConnectors"\) return "\/connectors"/);
  assert.match(component, /globalThis\.document\.title = "Connectors · Orkestr"/);
  assert.match(template, /<ork-user-connectors-page><\/ork-user-connectors-page>/);
  assert.match(template, /\(click\)="openPanel\('userConnectors'\)"/);
  assert.match(connectorsComponent, /selector: "ork-user-connectors-page"/);
  assert.match(connectorsComponent, /imports: \[FormsModule\]/);
  assert.match(connectorsComponent, /this\.api\.setupStatus\(\)/);
  assert.match(connectorsComponent, /this\.api\.currentUser\(\)/);
  assert.match(connectorsComponent, /this\.api\.startGmailOAuth\(this\.gmailAccount\)/);
  assert.match(connectorsComponent, /this\.api\.startOutlookOAuth\(this\.outlookAccount\)/);
  assert.match(connectorsComponent, /private readonly connectorOrder = \["whatsapp", "gmail", "outlook", "linkedin", "browsers"\]/);
  assert.match(connectorsTemplate, /name="user-gmail-account"/);
  assert.match(connectorsTemplate, /name="user-outlook-account"/);
  assert.match(connectorsTemplate, /Open Gmail sign-in/);
  assert.match(connectorsTemplate, /Open Microsoft sign-in/);
  assert.match(connectorsTemplate, /href="\/desk"/);
  assert.match(api, /startGmailOAuth\(account = ""\)/);
  assert.match(api, /startOutlookOAuth\(account = ""\)/);
  assert.match(styles, /\.user-connector-grid/);
  assert.match(styles, /\.connector-action/);
  assert.match(styles, /\.connector-device-code/);
});

test("web shell exposes a user skills management page", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const skillsComponent = await fs.readFile("apps/web/src/app/user-skills-page.component.ts", "utf8");
  const skillsTemplate = await fs.readFile("apps/web/src/app/user-skills-page.component.html", "utf8");
  const opsComponent = await fs.readFile("apps/web/src/app/ops-page.component.ts", "utf8");
  const opsTemplate = await fs.readFile("apps/web/src/app/ops-page.component.html", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const styles = await fs.readFile("apps/web/src/styles.css", "utf8");

  assert.match(component, /import \{ UserSkillsPageComponent \} from "\.\/user-skills-page\.component"/);
  assert.match(component, /type Panel = .*"userSkills"/);
  assert.match(component, /parts\[0\] === "skills"/);
  assert.match(component, /parts\[0\] === "ng" && parts\[1\] === "skills"/);
  assert.match(component, /panel === "userSkills"\) return "\/skills"/);
  assert.match(component, /globalThis\.document\.title = "Skills · Orkestr"/);
  assert.match(template, /<ork-user-skills-page><\/ork-user-skills-page>/);
  assert.match(template, /\(click\)="openPanel\('userSkills'\)"/);
  assert.match(skillsComponent, /selector: "ork-user-skills-page"/);
  assert.match(skillsComponent, /this\.api\.currentUserSkills\(\)/);
  assert.match(skillsComponent, /enabledSkills\(\): UserSkill\[\]/);
  assert.match(skillsComponent, /this\.skills\.filter\(\(skill\) => skill\.enabled === true\)/);
  assert.match(skillsComponent, /this\.api\.updateCurrentUserSkill\(skill\.id, false\)/);
  assert.match(skillsTemplate, /@for \(skill of enabledSkills\(\); track skill\.id\)/);
  assert.match(api, /interface UserSkill/);
  assert.match(api, /currentUserSkills\(\)/);
  assert.match(api, /userSkills\(id: string\)/);
  assert.match(api, /updateUserSkill\(id: string, skillId: string, enabled: boolean\)/);
  assert.match(opsComponent, /opsUserSkills: UserSkill\[\] = \[\]/);
  assert.match(opsComponent, /loadSelectedUserSkills\(false\)/);
  assert.match(opsComponent, /toggleUserSkill\(user: OrkestrUser, skill: UserSkill\)/);
  assert.match(opsTemplate, /<h4>Skills<\/h4>/);
  assert.match(opsTemplate, /toggleUserSkill\(user, skill\)/);
  assert.match(styles, /\.skills-grid/);
  assert.match(styles, /\.skill-card/);
});

test("web shell exposes a user-scoped files page", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const filesComponent = await fs.readFile("apps/web/src/app/files-page.component.ts", "utf8");
  const filesTemplate = await fs.readFile("apps/web/src/app/files-page.component.html", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const controller = await fs.readFile("apps/server/src/modules/system/system.controller.ts", "utf8");
  const styles = await fs.readFile("apps/web/src/styles.css", "utf8");

  assert.match(component, /import \{ FilesPageComponent \} from "\.\/files-page\.component"/);
  assert.match(component, /type Panel = .*"files"/);
  assert.match(component, /parts\[0\] === "files"/);
  assert.match(component, /parts\[0\] === "ng" && parts\[1\] === "files"/);
  assert.match(component, /!this\.isRouteLevelUserPanel\(this\.activePanel\) && !this\.selectedId && this\.threads\.length/);
  assert.match(component, /panel === "files"\) return "\/files"/);
  assert.match(component, /globalThis\.document\.title = "Files · Orkestr"/);
  assert.match(template, /<ork-files-page><\/ork-files-page>/);
  assert.match(template, /\(click\)="openPanel\('files'\)"/);
  assert.match(filesComponent, /selector: "ork-files-page"/);
  assert.match(filesComponent, /this\.api\.files\(path\)/);
  assert.match(filesComponent, /this\.api\.createFileFolder\(this\.currentPath, name\)/);
  assert.match(filesComponent, /this\.api\.uploadFiles\(this\.currentPath, selected\)/);
  assert.match(filesComponent, /this\.api\.deleteFile\(entry\.path\)/);
  assert.match(filesTemplate, /type="file"/);
  assert.match(filesTemplate, /\[class\.active\]="currentPath === root\.path"/);
  assert.match(api, /createFileFolder\(currentPath: string, name: string\)/);
  assert.match(api, /uploadFiles\(currentPath: string, files: File\[\]\)/);
  assert.match(api, /deleteFile\(path: string\)/);
  assert.match(controller, /@Post\("files\/folders"\)/);
  assert.match(controller, /@Post\("files\/uploads"\)/);
  assert.match(controller, /@Delete\("files"\)/);
  assert.match(styles, /\.files-page/);
  assert.match(styles, /\.file-row/);
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
