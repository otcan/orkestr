import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { createGoogleWorkspaceConnectLink } from "../packages/connectors/src/google-workspace.js";
import { __brokerInstanceRegistryTestInternals, registerBrokerInstance } from "../packages/core/src/broker-instance-registry.js";
import { approvePairingChallenge, createPairingChallenge, listPairingChallenges, pairBrowser, sessionCookieHeader } from "../packages/core/src/security.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { createTenantVm } from "../packages/core/src/tenant-vm-registry.js";
import { userDataPaths } from "../packages/storage/src/paths.js";

const publicRuntimeEnvKeys = [
  "ORKESTR_PRIMARY_DOMAIN",
  "ORKESTR_DOMAIN",
  "ORKESTR_APP_HOST",
  "ORKESTR_AUTH_HOST",
  "ORKESTR_PUBLIC_SITE_URL",
  "ORKESTR_PRIMARY_PUBLIC_URL",
  "ORKESTR_PUBLIC_URL",
  "ORKESTR_PUBLIC_APP_URL",
  "ORKESTR_PUBLIC_AUTH_URL",
  "ORKESTR_AUTH_ENTRY_URL",
  "ORKESTR_PAIRING_URL",
  "ORKESTR_AUTH_URL",
  "ORKESTR_GOOGLE_WORKSPACE_CONNECT_PUBLIC_URL",
  "ORKESTR_APP_URL",
  "ORKESTR_PUBLIC_HTTPS_URL",
  "ORKESTR_HTTPS_URL",
  "ORKESTR_TAILSCALE_HTTPS_NAME",
  "ORKESTR_CONNECT_PUBLIC_URL",
  "ORKESTR_COOKIE_DOMAIN",
  "ORKESTR_AUTH_REQUIRED",
];

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function clearEnv(keys) {
  for (const key of keys) delete process.env[key];
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function assertAngularShell(html) {
  assert.match(html, /<ork-root(?:\s|>)/);
  assert.ok(html.includes("Loading Orkestr"));
  assert.match(html, /src="main[^"]*\.js"/);
}

function assertPublicShell(html) {
  assert.match(html, /<title>Orkestr<\/title>/);
  assert.match(html, /<h1>Orkestr<\/h1>/);
  assert.match(html, /Invite-only private beta/);
  assert.match(html, /Orkestr is an invite-only assistant app and self-hosted agent workstation/);
  assert.match(html, /Gmail access is optional and user approved/);
  assert.match(html, /Gmail send access is used to send emails that the user requests or approves from Orkestr/);
  assert.match(html, /No Google user data used for advertising or model training/);
  assert.match(html, /Join waitlist/);
  assert.match(html, /id="waitlist-form"/);
  assert.match(html, /\/api\/public\/waitlist/);
  assert.match(html, /name="timezone"/);
  assert.match(html, /resolvedOptions\(\)\.timeZone/);
  assert.match(html, /View OSS repo/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="\/terms"/);
  assert.doesNotMatch(html, />Open app</);
  assert.doesNotMatch(html, /<ork-root(?:\s|>)/);
}

function assertConnectorIntentReturn(returnTo, { instanceId, connector = "gmail" } = {}) {
  const target = new URL(returnTo, "http://localhost");
  assert.equal(target.pathname, `/i/${instanceId}/app/connectors/${connector}`);
  assert.equal(target.searchParams.get("mcp"), "tools/call");
  assert.equal(target.searchParams.get("tool"), "orkestr_auth");
  assert.equal(target.searchParams.get("service"), connector);
  if (connector === "gmail") {
    assert.equal(target.searchParams.get("provider"), "google_workspace");
    assert.equal(target.searchParams.get("action"), "connect");
  }
  assert.equal(target.searchParams.get("instance_id"), instanceId);
  assert.equal(target.searchParams.has("compact"), false);
}

function assertInstancePairingRedirect(response, { instanceId, returnPath = "", connector = "" } = {}) {
  assert.equal(response.status, 302);
  const redirect = new URL(response.headers.get("location") || "", "http://localhost");
  assert.equal(redirect.pathname, "/setup/pairing");
  assert.equal(redirect.searchParams.get("instanceId"), instanceId);
  const returnTo = redirect.searchParams.get("return") || "";
  if (connector) assertConnectorIntentReturn(returnTo, { instanceId, connector });
  else assert.equal(returnTo, returnPath);
}

test("server serves the public site at root and Angular UI at app routes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-static-ui-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorOverlay = process.env.ORKESTR_OVERLAY_DIR;
  const priorPublicRuntimeEnv = snapshotEnv(publicRuntimeEnvKeys);
  process.env.ORKESTR_HOME = home;
  delete process.env.ORKESTR_OVERLAY_DIR;
  clearEnv(publicRuntimeEnvKeys);
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const brokerRegistration = await registerBrokerInstance({
    env: process.env,
    trustedAdmin: true,
    request: { ip: "127.0.0.1", headers: { "user-agent": "node:test" } },
    body: { encryptionPublicKey: client.publicKey, displayName: "static-ui-demo" },
  });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const html = await response.text();
    const appResponse = await fetch(`http://127.0.0.1:${port}/app`);
    const appHtml = await appResponse.text();
    const termsResponse = await fetch(`http://127.0.0.1:${port}/terms`);
    const termsHtml = await termsResponse.text();
    const privacyResponse = await fetch(`http://127.0.0.1:${port}/privacy`);
    const privacyHtml = await privacyResponse.text();
    const acceptableUseResponse = await fetch(`http://127.0.0.1:${port}/acceptable-use`);
    const dataDeletionResponse = await fetch(`http://127.0.0.1:${port}/data-deletion`);
    const supportResponse = await fetch(`http://127.0.0.1:${port}/support`);
    const betaResponse = await fetch(`http://127.0.0.1:${port}/beta`);
    const publicAssetResponse = await fetch(`http://127.0.0.1:${port}/public-assets/orkestr-three-screen-demo.png`);
    const onboardingResponse = await fetch(`http://127.0.0.1:${port}/setup`);
    const onboardingHtml = await onboardingResponse.text();
    const setupGmailResponse = await fetch(`http://127.0.0.1:${port}/setup/gmail`);
    const setupGoogleMarketingResponse = await fetch(`http://127.0.0.1:${port}/setup/google-marketing`);
    const instanceSetupResponse = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/setup`, { redirect: "manual" });
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
    const googleWorkspaceConnectResponse = await fetch(`http://127.0.0.1:${port}/connect/google?connect=missing`);
    const googleWorkspaceConnectHtml = await googleWorkspaceConnectResponse.text();

    assert.equal(response.status, 200);
    assertPublicShell(html);
    assert.match(html, /rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/);
    assert.equal(appResponse.status, 200);
    assertAngularShell(appHtml);
    assert.equal(termsResponse.status, 200);
    assert.match(termsHtml, /Only connect accounts you own or are authorized to use/);
    assert.equal(privacyResponse.status, 200);
    assert.match(privacyHtml, /Parent connector apps can provide OAuth entry points/);
    assert.equal(acceptableUseResponse.status, 200);
    assert.equal(dataDeletionResponse.status, 200);
    assert.equal(supportResponse.status, 200);
    assert.equal(betaResponse.status, 200);
    assert.equal(publicAssetResponse.status, 200);
    assert.match(publicAssetResponse.headers.get("content-type") || "", /image\/png/);
    assert.equal(onboardingResponse.status, 200);
    assertAngularShell(onboardingHtml);
    assert.equal(setupGmailResponse.status, 200);
    assert.equal(setupGoogleMarketingResponse.status, 200);
    assert.equal(instanceSetupResponse.status, 302);
    assert.equal(instanceSetupResponse.headers.get("location"), `/setup/pairing?instanceId=${brokerRegistration.instanceId}&return=%2Fi%2F${brokerRegistration.instanceId}%2Fapp%2F`);
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
    assert.equal(googleWorkspaceConnectResponse.status, 400);
    assert.ok(googleWorkspaceConnectHtml.includes("Connect Google Workspace"));
    assert.doesNotMatch(googleWorkspaceConnectHtml, /<ork-root(?:\s|>)/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorOverlay === undefined) delete process.env.ORKESTR_OVERLAY_DIR;
    else process.env.ORKESTR_OVERLAY_DIR = priorOverlay;
    restoreEnv(priorPublicRuntimeEnv);
  }
});

test("instance connect setup requires a registered broker UUID", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-static-instance-connect-"));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const brokerRegistration = await registerBrokerInstance({
    env: process.env,
    trustedAdmin: true,
    request: { ip: "127.0.0.1", headers: { "user-agent": "node:test" } },
    body: { encryptionPublicKey: client.publicKey, displayName: "connect-route-demo" },
  });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  try {
    const registered = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/setup`, { redirect: "manual" });
    const gmailReturn = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/setup?return=%2Fsetup%2Fgmail`, { redirect: "manual" });
    const gmailConnector = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/setup?connector=gmail`, { redirect: "manual" });
    const staleCodexReturn = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/setup?return=%2Fi%2F${brokerRegistration.instanceId}%2Fapp%2Fsetup%2Fcodex%3Fcompact%3D1`, { redirect: "manual" });
    const staleGmailReturn = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/setup?return=%2Fi%2F${brokerRegistration.instanceId}%2Fapp%2Fsetup%2Fgmail%3Fcompact%3D1`, { redirect: "manual" });
    const unknown = await fetch(`http://127.0.0.1:${port}/i/demo-vm-001/setup`, { redirect: "manual" });

    assertInstancePairingRedirect(registered, { instanceId: brokerRegistration.instanceId, returnPath: `/i/${brokerRegistration.instanceId}/app/` });
    assertInstancePairingRedirect(gmailReturn, { instanceId: brokerRegistration.instanceId, connector: "gmail" });
    assertInstancePairingRedirect(gmailConnector, { instanceId: brokerRegistration.instanceId, connector: "gmail" });
    assertInstancePairingRedirect(staleCodexReturn, { instanceId: brokerRegistration.instanceId, returnPath: `/i/${brokerRegistration.instanceId}/app/` });
    assertInstancePairingRedirect(staleGmailReturn, { instanceId: brokerRegistration.instanceId, connector: "gmail" });
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});

test("google workspace brokered connect links require instance and owner scoped browser pairing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-static-google-connect-pairing-"));
  const envKeys = [
    ...publicRuntimeEnvKeys,
    "ORKESTR_HOME",
    "ORKESTR_OVERLAY_DIR",
    "ORKESTR_ADMIN_EMAIL",
    "ORKESTR_WHATSAPP_REPAIR_NOTIFY_EMAILS",
    "ORKESTR_WHATSAPP_REPAIR_NOTIFY_EMAIL",
    "ORKESTR_WHATSAPP_ACCOUNT_IDS",
    "ORKESTR_WHATSAPP_REPAIR_GMAIL_SOURCE",
    "ORKESTR_GMAIL_SOURCE",
    "ORKESTR_JOBS_GMAIL_SOURCE",
    "ORKESTR_WHATSAPP_REPAIR_GOG_ACCOUNT",
    "ORKESTR_GMAIL_GOG_ACCOUNT",
    "ORKESTR_JOBS_GOG_ACCOUNT",
    "GOG_ACCOUNT",
  ];
  const prior = snapshotEnv(envKeys);
  clearEnv(envKeys);
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_CONNECT_PUBLIC_URL = "https://connect.crawlerai.de";
  process.env.ORKESTR_PUBLIC_AUTH_URL = "https://connect.orkestr.de/setup/pairing";
  process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS = "sender";

  const connect = await createGoogleWorkspaceConnectLink({
    principal: userPrincipal({ id: "firat", displayName: "Firat" }),
    thread: {
      id: "firat-thread",
      binding: { chatId: "firat-chat", outboundAccountId: "sender" },
    },
    brokerInstanceId: "instance-firat",
    brokerTenantVmId: "firat-jobs-vm",
    brokerTenantUserId: "firat",
    brokerTenantThreadId: "firat-thread",
    brokerTenantChatId: "firat-chat",
    brokerTenantAccountId: "sender",
    brokerServerRequest: true,
  }, process.env);
  const connectorUrl = new URL(connect.link);
  assert.equal(connectorUrl.origin, "https://connect.orkestr.de");
  assert.equal(connectorUrl.pathname, "/i/instance-firat/app/connectors/gmail");
  const connectUrl = new URL(connect.connectLink);
  assert.equal(connectUrl.origin, "https://connect.orkestr.de");
  assert.equal(connectUrl.pathname, "/i/instance-firat/app/connectors/gmail");
  assert.equal(connectUrl.searchParams.get("connect"), connect.connectId);
  const connectPath = `/connect/google?connect=${encodeURIComponent(connect.connectId)}`;
  const startPath = `/connect/google/start?connect=${encodeURIComponent(connect.connectId)}&capability=gmail_read`;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${connectPath}`, { redirect: "manual" });
    assert.equal(response.status, 302);
    const location = response.headers.get("location") || "";
    const redirect = new URL(location, `http://127.0.0.1:${port}`);
    assert.equal(redirect.pathname, "/setup/pairing");
    assert.equal(redirect.searchParams.get("return"), connectPath);
    const challengeId = redirect.searchParams.get("challengeId") || "";
    assert.ok(challengeId);

    const challengeStatus = await fetch(`http://127.0.0.1:${port}/api/setup/security/challenges/${challengeId}`);
    const challengePayload = await challengeStatus.json();
    assert.equal(challengePayload.challenge.instanceId, "instance-firat");
    assert.equal(challengePayload.challenge.userId, "firat");
    assert.equal(challengePayload.challenge.role, "user");
    assert.equal(challengePayload.challenge.requestedPath, connectPath);
    assert.deepEqual(challengePayload.challenge.allowedActions, [`orkestr_auth.google.connect:${connect.connectId}`]);
    assert.equal(challengePayload.challenge.authIntent.tool, "orkestr_auth");
    assert.equal(challengePayload.challenge.authIntent.mcp, "tools/call");
    assert.equal(challengePayload.challenge.authIntent.service, "gmail");
    assert.equal(challengePayload.challenge.authIntent.provider, "google_workspace");
    assert.equal(challengePayload.challenge.authIntent.action, "connect");
    assert.equal(challengePayload.challenge.authIntent.connectId, connect.connectId);
    assert.equal(challengePayload.challenge.authIntent.instanceId, "instance-firat");
    assert.equal(challengePayload.challenge.authIntent.tenantVmId, "firat-jobs-vm");
    assert.equal(challengePayload.challenge.authIntent.userId, "firat");
    assert.equal(challengePayload.challenge.authIntent.thread, "firat-thread");
    assert.equal(challengePayload.challenge.authIntent.restartCommand, "/connect google");
    assert.equal(challengePayload.challenge.authIntent.restartSurface, "whatsapp");

    const beforePreview = await listPairingChallenges({ env: process.env, includeExpired: true });
    const previewResponse = await fetch(`http://127.0.0.1:${port}${connectPath}`, {
      headers: { "user-agent": "facebookexternalhit/1.1" },
      redirect: "manual",
    });
    const previewHtml = await previewResponse.text();
    assert.equal(previewResponse.status, 200);
    assert.match(previewHtml, /Open this link in a browser/);
    const afterPreview = await listPairingChallenges({ env: process.env, includeExpired: true });
    assert.equal(afterPreview.challenges.length, beforePreview.challenges.length);

    const startResponse = await fetch(`http://127.0.0.1:${port}${startPath}`, { redirect: "manual" });
    assert.equal(startResponse.status, 302);
    const startRedirect = new URL(startResponse.headers.get("location") || "", `http://127.0.0.1:${port}`);
    assert.equal(startRedirect.pathname, "/setup/pairing");
    assert.equal(startRedirect.searchParams.get("return"), startPath);

    const adminChallenge = await createPairingChallenge({ env: process.env });
    await approvePairingChallenge(adminChallenge.challengeId, { env: process.env, approvedBy: "node:test" });
    const adminPaired = await pairBrowser({ challengeId: adminChallenge.challengeId, env: process.env });
    const adminCookie = sessionCookieHeader(adminPaired.token, process.env);
    const regularSession = await fetch(`http://127.0.0.1:${port}${connectPath}`, { headers: { cookie: adminCookie }, redirect: "manual" });
    assert.equal(regularSession.status, 302);
    const regularRedirect = new URL(regularSession.headers.get("location") || "", `http://127.0.0.1:${port}`);
    assert.equal(regularRedirect.pathname, "/setup/pairing");
    assert.equal(regularRedirect.searchParams.get("return"), connectPath);

    const regularStartSession = await fetch(`http://127.0.0.1:${port}${startPath}`, { headers: { cookie: adminCookie }, redirect: "manual" });
    assert.equal(regularStartSession.status, 302);
    const regularStartRedirect = new URL(regularStartSession.headers.get("location") || "", `http://127.0.0.1:${port}`);
    assert.equal(regularStartRedirect.pathname, "/setup/pairing");
    assert.equal(regularStartRedirect.searchParams.get("return"), startPath);

    const otherChallenge = await createPairingChallenge({
      env: process.env,
      instanceId: "instance-firat",
      userId: "mallory",
      role: "user",
      allowedActions: [`orkestr_auth.google.connect:${connect.connectId}`],
      authIntent: challengePayload.challenge.authIntent,
    });
    await approvePairingChallenge(otherChallenge.challengeId, { env: process.env, approvedBy: "node:test" });
    const otherPaired = await pairBrowser({ challengeId: otherChallenge.challengeId, env: process.env });
    const otherCookie = sessionCookieHeader(otherPaired.token, process.env);
    const wrongUser = await fetch(`http://127.0.0.1:${port}${connectPath}`, { headers: { cookie: otherCookie } });
    const wrongUserHtml = await wrongUser.text();
    assert.equal(wrongUser.status, 403);
    assert.match(wrongUserHtml, /google_workspace_connect_pairing_user_mismatch/);

    const currentChallenges = await listPairingChallenges({ env: process.env, includeExpired: true });
    const currentConnectChallenge = currentChallenges.challenges.find((challenge) =>
      challenge.status === "pending" &&
      challenge.instanceId === "instance-firat" &&
      challenge.userId === "firat" &&
      challenge.authIntent?.connectId === connect.connectId &&
      challenge.requestedPath === connectPath
    );
    assert.ok(currentConnectChallenge);
    assert.notEqual(currentConnectChallenge.id, challengeId);
    await assert.rejects(
      () => approvePairingChallenge(challengeId, { env: process.env, approvedBy: "node:test" }),
      /pairing_challenge_superseded/,
    );
    await approvePairingChallenge(currentConnectChallenge.id, { env: process.env, approvedBy: "node:test" });
    const paired = await pairBrowser({ challengeId: currentConnectChallenge.id, env: process.env });
    assert.deepEqual(paired.session.allowedActions, [`orkestr_auth.google.connect:${connect.connectId}`]);
    assert.equal(paired.session.authIntent.tool, "orkestr_auth");
    assert.equal(paired.session.authIntent.service, "gmail");
    const cookie = sessionCookieHeader(paired.token, process.env);
    const pairedResponse = await fetch(`http://127.0.0.1:${port}${connectPath}`, { headers: { cookie } });
    const pairedHtml = await pairedResponse.text();
    assert.equal(pairedResponse.status, 200);
    assert.match(pairedHtml, /Connect Google Workspace/);
    assert.match(pairedHtml, /orkestr_auth/);
    assert.match(pairedHtml, /google_workspace/);

    const waRepairResponse = await fetch(`http://127.0.0.1:${port}/api/connectors/whatsapp/bridge/repair?accountId=sender`, { headers: { cookie } });
    const waRepairHtml = await waRepairResponse.text();
    assert.equal(waRepairResponse.status, 200);
    assert.match(waRepairHtml, /WhatsApp Repair/);
    assert.match(waRepairHtml, /Email Fresh QR/);

    const waRepairPostResponse = await fetch(`http://127.0.0.1:${port}/api/connectors/whatsapp/bridge/repair/send-email`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ accountId: "sender" }),
    });
    const waRepairPostPayload = await waRepairPostResponse.json();
    assert.equal(waRepairPostResponse.status, 409);
    assert.equal(waRepairPostPayload.error, "recipient_missing");

    const appResponse = await fetch(`http://127.0.0.1:${port}/app`, { headers: { cookie }, redirect: "manual" });
    const appPayload = await appResponse.json();
    assert.equal(appResponse.status, 403);
    assert.equal(appPayload.error, "auth_intent_session_scope_denied");

    const apiResponse = await fetch(`http://127.0.0.1:${port}/api/threads`, { headers: { cookie }, redirect: "manual" });
    const apiPayload = await apiResponse.json();
    assert.equal(apiResponse.status, 403);
    assert.equal(apiPayload.error, "auth_intent_session_scope_denied");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});

test("broker instance app path pairs on broker and proxies the VM WebUI", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-static-instance-app-"));
  const envKeys = [
    ...publicRuntimeEnvKeys,
    "ORKESTR_HOME",
    "GMAIL_OAUTH_CLIENT_ID",
    "GMAIL_OAUTH_CLIENT_SECRET",
    "GMAIL_OAUTH_REDIRECT_URI",
    "GOOGLE_OAUTH_REDIRECT_URI",
    "ORKESTR_GOOGLE_WORKSPACE_CONNECT_PUBLIC_URL",
  ];
  const prior = snapshotEnv(envKeys);
  clearEnv(envKeys);
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_CONNECT_PUBLIC_URL = "https://connect.crawlerai.de";
  process.env.ORKESTR_PUBLIC_AUTH_URL = "https://connect.orkestr.de/setup/pairing";
  process.env.GMAIL_OAUTH_CLIENT_ID = "gmail-client";
  process.env.GMAIL_OAUTH_REDIRECT_URI = "https://app.orkestr.de/oauth/gmail/callback";
  const upstreamRequests = [];
  const upstream = http.createServer((request, response) => {
    upstreamRequests.push({ url: request.url, headers: request.headers });
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><base href="/" /><link rel="icon" type="image/svg+xml" href="/favicon.svg" /></head><body><ork-root>Loading Orkestr</ork-root><script src="main.js"></script></body></html>`);
      return;
    }
    if (String(request.url || "").startsWith("/connectors/gmail")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><base href="/" /></head><body><ork-root>Connect Gmail</ork-root><script src="main.js"></script></body></html>`);
      return;
    }
    if (request.url === "/api/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, name: "tenant-vm", generatedAt: "2026-07-04T00:00:00.000Z" }));
      return;
    }
    if (request.url === "/api/setup/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, connectors: [{ id: "gmail", state: "connected" }], generatedAt: "2026-07-04T00:00:00.000Z" }));
      return;
    }
    if (request.url === "/api/users/me") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, user: { id: "firat", role: "user" } }));
      return;
    }
    if (request.method === "GET" && String(request.url || "").startsWith("/api/connectors/gmail/oauth/start")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, authorizeUrl: "https://accounts.google.test/oauth" }));
      return;
    }
    if (request.method === "DELETE" && request.url === "/api/connectors/gmail/auth") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, provider: "gmail", state: "disconnected" }));
      return;
    }
    if (request.url === "/redirect-home") {
      response.writeHead(302, { location: "/" });
      response.end("redirecting");
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const brokerRegistration = await registerBrokerInstance({
    env: process.env,
    trustedAdmin: true,
    request: { ip: "127.0.0.1", headers: { "user-agent": "node:test" } },
    body: {
      encryptionPublicKey: client.publicKey,
      displayName: "instance-app-demo",
      endpointBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    },
  });
  await createTenantVm({
    id: "firat-jobs-vm",
    ownerUserId: "firat",
    labels: { brokerInstanceId: brokerRegistration.instanceId },
  }, process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  try {
    const brokeredConnect = await createGoogleWorkspaceConnectLink({
      principal: userPrincipal({ id: "firat", displayName: "Firat" }),
      thread: {
        id: "firat-thread",
        name: "Firat Jobs",
        binding: { chatId: "firat-chat", outboundAccountId: "sender" },
      },
      brokerInstanceId: brokerRegistration.instanceId,
      brokerTenantUserId: "firat",
      brokerTenantThreadId: "firat-thread",
      brokerTenantThreadName: "Firat Jobs",
      brokerTenantChatId: "firat-chat",
      brokerTenantAccountId: "sender",
      brokerServerRequest: true,
    }, process.env);
    const brokeredConnectUrl = new URL(brokeredConnect.connectLink);
    assert.equal(brokeredConnectUrl.pathname, `/i/${brokerRegistration.instanceId}/app/connectors/gmail`);
    assert.equal(brokeredConnectUrl.searchParams.get("connect"), brokeredConnect.connectId);
    const rawBrokeredConnectUrl = new URL(`/connect/google?connect=${encodeURIComponent(brokeredConnect.connectId)}`, "https://connect.orkestr.de");
    const topLevelBrokeredConnect = await fetch(
      `http://127.0.0.1:${port}${rawBrokeredConnectUrl.pathname}${rawBrokeredConnectUrl.search}`,
      { redirect: "manual" },
    );
    const noSlash = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app`, { redirect: "manual" });
    const unpaired = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app/`, { redirect: "manual" });
    const unpairedLegacyGmailSetup = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app/setup/gmail`, { redirect: "manual" });
    const unpairedLegacyGoogleConnect = await fetch(
      `http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app/connect/google?connect=legacy-connect-id&user_id=firat&thread=Firat%20Jobs`,
      { redirect: "manual" },
    );
    const unpairedApi = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app/api/threads`, { redirect: "manual" });
    const staleOtherChallenge = await createPairingChallenge({
      env: process.env,
      instanceId: "stale-instance",
      userId: "mallory",
      role: "user",
      requestedPath: "/i/stale-instance/app/connectors/gmail",
      allowedActions: ["orkestr_auth.google.connect:stale-connect"],
      authIntent: {
        mcp: "tools/call",
        tool: "orkestr_auth",
        service: "gmail",
        provider: "google_workspace",
        action: "connect",
        connectId: "stale-connect",
        instanceId: "stale-instance",
        userId: "mallory",
      },
    });
    await approvePairingChallenge(staleOtherChallenge.challengeId, { approvedBy: "node:test", env: process.env });
    const staleOtherPaired = await pairBrowser({ challengeId: staleOtherChallenge.challengeId, env: process.env });
    const staleOtherCookie = sessionCookieHeader(staleOtherPaired.token, process.env);
    const staleOtherConnect = await fetch(`http://127.0.0.1:${port}${brokeredConnectUrl.pathname}${brokeredConnectUrl.search}`, {
      headers: { cookie: staleOtherCookie },
      redirect: "manual",
    });
    const staleSameChallenge = await createPairingChallenge({
      env: process.env,
      instanceId: brokerRegistration.instanceId,
      userId: "firat",
      role: "user",
      requestedPath: `/i/${brokerRegistration.instanceId}/app/connectors/gmail`,
      allowedActions: ["orkestr_auth.google.connect:old-connect"],
      authIntent: {
        mcp: "tools/call",
        tool: "orkestr_auth",
        service: "gmail",
        provider: "google_workspace",
        action: "connect",
        connectId: "old-connect",
        instanceId: brokerRegistration.instanceId,
        userId: "firat",
      },
    });
    await approvePairingChallenge(staleSameChallenge.challengeId, { approvedBy: "node:test", env: process.env });
    const staleSamePaired = await pairBrowser({ challengeId: staleSameChallenge.challengeId, env: process.env });
    const staleSameCookie = sessionCookieHeader(staleSamePaired.token, process.env);
    const staleSameConnect = await fetch(`http://127.0.0.1:${port}${brokeredConnectUrl.pathname}${brokeredConnectUrl.search}`, {
      headers: { cookie: staleSameCookie },
      redirect: "manual",
    });
    const globalChallenge = await createPairingChallenge({ env: process.env });
    await approvePairingChallenge(globalChallenge.challengeId, { approvedBy: "node:test", env: process.env });
    const globalPaired = await pairBrowser({ challengeId: globalChallenge.challengeId, env: process.env });
    const globalCookie = sessionCookieHeader(globalPaired.token, process.env);
    const globalSessionScopeResponse = await fetch(`http://127.0.0.1:${port}/api/setup/security/session-scope?instanceId=${encodeURIComponent(brokerRegistration.instanceId)}&return=${encodeURIComponent(`${brokeredConnectUrl.pathname}${brokeredConnectUrl.search}`)}`, {
      headers: { cookie: globalCookie },
    });
    const globalSessionScope = await globalSessionScopeResponse.json();
    const globalCookieConnect = await fetch(`http://127.0.0.1:${port}${brokeredConnectUrl.pathname}${brokeredConnectUrl.search}`, {
      headers: { cookie: globalCookie },
      redirect: "manual",
    });
    const freshConnectChallenge = await createPairingChallenge({
      env: process.env,
      instanceId: brokerRegistration.instanceId,
      userId: "firat",
      role: "user",
      requestedPath: `/i/${brokerRegistration.instanceId}/app/connectors/gmail`,
      allowedActions: [`orkestr_auth.google.connect:${brokeredConnect.connectId}`],
      authIntent: {
        mcp: "tools/call",
        tool: "orkestr_auth",
        service: "gmail",
        provider: "google_workspace",
        action: "connect",
        connectId: brokeredConnect.connectId,
        instanceId: brokerRegistration.instanceId,
        tenantVmId: "firat-jobs-vm",
        userId: "firat",
        thread: "Firat Jobs",
        threadId: "firat-thread",
      },
    });
    await approvePairingChallenge(freshConnectChallenge.challengeId, { approvedBy: "node:test", env: process.env });
    const freshConnectPaired = await pairBrowser({ challengeId: freshConnectChallenge.challengeId, env: process.env });
    const staleFirstDuplicateCookie = [
      staleSameCookie.split(";")[0],
      sessionCookieHeader(freshConnectPaired.token, process.env).split(";")[0],
    ].join("; ");
    const staleFirstConnect = await fetch(`http://127.0.0.1:${port}${brokeredConnectUrl.pathname}${brokeredConnectUrl.search}`, {
      headers: { cookie: staleFirstDuplicateCookie },
      redirect: "manual",
    });
    const staleFirstConnectHtml = await staleFirstConnect.text();
    const staleFirstStartResponse = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app/api/connectors/gmail/oauth/start`, {
      headers: { cookie: staleFirstDuplicateCookie },
    });
    const staleFirstStartPayload = await staleFirstStartResponse.json();
    const challenge = await createPairingChallenge({ env: process.env, instanceId: brokerRegistration.instanceId });
    await approvePairingChallenge(challenge.challengeId, { approvedBy: "node:test", env: process.env });
    const paired = await pairBrowser({ challengeId: challenge.challengeId, env: process.env });
    const cookie = sessionCookieHeader(paired.token, process.env);
    const htmlResponse = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app/`, { headers: { cookie } });
    const html = await htmlResponse.text();
    const apiResponse = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app/api/version`, { headers: { cookie } });
    const apiPayload = await apiResponse.json();
    const redirectResponse = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app/redirect-home`, { headers: { cookie }, redirect: "manual" });
    const authIntentChallenge = await createPairingChallenge({
      env: process.env,
      instanceId: brokerRegistration.instanceId,
      userId: "firat",
      role: "user",
      requestedPath: `/i/${brokerRegistration.instanceId}/app/connectors/gmail`,
      allowedActions: ["orkestr_auth.google.connect"],
      authIntent: {
        mcp: "tools/call",
        tool: "orkestr_auth",
        service: "gmail",
        provider: "google_workspace",
        action: "connect",
        instanceId: brokerRegistration.instanceId,
        userId: "firat",
        account: "old-hint@example.com",
      },
    });
    await approvePairingChallenge(authIntentChallenge.challengeId, { approvedBy: "node:test", env: process.env });
    const authIntentPaired = await pairBrowser({ challengeId: authIntentChallenge.challengeId, env: process.env });
    const authIntentCookie = sessionCookieHeader(authIntentPaired.token, process.env);
    const intentParams = new URLSearchParams({
      mcp: "tools/call",
      tool: "orkestr_auth",
      service: "gmail",
      provider: "google_workspace",
      action: "connect",
      instance_id: brokerRegistration.instanceId,
      auto: "0",
    });
    const intentConnectorResponse = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app/connectors/gmail?${intentParams}`, { headers: { cookie: authIntentCookie } });
    const intentConnectorHtml = await intentConnectorResponse.text();
    const intentSetupResponse = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app/api/setup/status`, { headers: { cookie: authIntentCookie } });
    const intentSetupPayload = await intentSetupResponse.json();
    const intentUserResponse = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app/api/users/me`, { headers: { cookie: authIntentCookie } });
    const intentUserPayload = await intentUserResponse.json();
    const intentStartResponse = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app/api/connectors/gmail/oauth/start`, { headers: { cookie: authIntentCookie } });
    const intentStartPayload = await intentStartResponse.json();
    const intentSavedState = JSON.parse(await fs.readFile(path.join(userDataPaths("firat", process.env).oauth, "gmail-state.json"), "utf8"));
    const intentDisconnectResponse = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app/api/connectors/gmail/auth`, { method: "DELETE", headers: { cookie: authIntentCookie } });
    const intentDisconnectPayload = await intentDisconnectResponse.json();
    const intentThreadsResponse = await fetch(`http://127.0.0.1:${port}/i/${brokerRegistration.instanceId}/app/api/threads`, { headers: { cookie: authIntentCookie }, redirect: "manual" });
    const intentThreadsPayload = await intentThreadsResponse.json();
    const parentAppResponse = await fetch(`http://127.0.0.1:${port}/app`, { headers: { cookie: authIntentCookie }, redirect: "manual" });
    const parentAppPayload = await parentAppResponse.json();

    assert.equal(topLevelBrokeredConnect.status, 302);
    {
      const brokeredRedirect = new URL(topLevelBrokeredConnect.headers.get("location") || "", "http://localhost");
      assert.equal(brokeredRedirect.pathname, `/i/${brokerRegistration.instanceId}/app/connectors/gmail`);
      assert.equal(brokeredRedirect.searchParams.get("connect"), brokeredConnect.connectId);
      assert.equal(brokeredRedirect.searchParams.get("user_id"), "firat");
      assert.equal(brokeredRedirect.searchParams.get("thread"), "Firat Jobs");
    }
    assert.equal(noSlash.status, 302);
    assert.equal(noSlash.headers.get("location"), `/i/${brokerRegistration.instanceId}/app/`);
    assert.equal(unpaired.status, 302);
    assert.equal(unpaired.headers.get("location"), `/setup/pairing?instanceId=${brokerRegistration.instanceId}&return=%2Fi%2F${brokerRegistration.instanceId}%2Fapp%2F`);
    assertInstancePairingRedirect(unpairedLegacyGmailSetup, { instanceId: brokerRegistration.instanceId, connector: "gmail" });
    assert.equal(unpairedLegacyGoogleConnect.status, 302);
    {
      const legacyRedirect = new URL(unpairedLegacyGoogleConnect.headers.get("location") || "", "http://localhost");
      assert.equal(legacyRedirect.pathname, `/i/${brokerRegistration.instanceId}/app/connectors/gmail`);
      assert.equal(legacyRedirect.searchParams.get("mcp"), "tools/call");
      assert.equal(legacyRedirect.searchParams.get("tool"), "orkestr_auth");
      assert.equal(legacyRedirect.searchParams.get("service"), "gmail");
      assert.equal(legacyRedirect.searchParams.get("provider"), "google_workspace");
      assert.equal(legacyRedirect.searchParams.get("action"), "connect");
      assert.equal(legacyRedirect.searchParams.get("instance_id"), brokerRegistration.instanceId);
      assert.equal(legacyRedirect.searchParams.get("user_id"), "firat");
      assert.equal(legacyRedirect.searchParams.get("thread"), "Firat Jobs");
      assert.equal(legacyRedirect.searchParams.get("connect"), "legacy-connect-id");
      assert.equal(legacyRedirect.searchParams.get("auto"), "0");
    }
    assert.equal(unpairedApi.status, 401);
    assert.equal(await unpairedApi.text(), "broker_instance_pairing_required");
    for (const [name, response] of [["other", staleOtherConnect], ["same", staleSameConnect]]) {
      const body = await response.text();
      assert.equal(response.status, 302, `${name}: ${body}`);
      const redirect = new URL(response.headers.get("location") || "", "http://localhost");
      assert.equal(redirect.pathname, "/setup/pairing");
      assert.equal(redirect.searchParams.get("instanceId"), brokerRegistration.instanceId);
      const returnUrl = new URL(redirect.searchParams.get("return") || "", "http://localhost");
      assert.equal(returnUrl.pathname, `/i/${brokerRegistration.instanceId}/app/connectors/gmail`);
      assert.equal(returnUrl.searchParams.get("connect"), brokeredConnect.connectId);
    }
    assert.equal(globalSessionScopeResponse.status, 200);
    assert.equal(globalSessionScope.paired, true);
    assert.equal(globalSessionScope.validForReturn, false);
    assert.equal(globalSessionScope.reason, "instance_mismatch");
    assert.equal(globalCookieConnect.status, 302);
    assert.match(globalCookieConnect.headers.get("set-cookie") || "", /orkestr_session=; Path=\//);
    assert.match(globalCookieConnect.headers.get("set-cookie") || "", new RegExp(`Path=/i/${brokerRegistration.instanceId}/app`));
    assert.equal(staleFirstConnect.status, 200);
    assert.match(staleFirstConnectHtml, /Connect Gmail/);
    assert.equal(staleFirstStartResponse.status, 200);
    assert.equal(staleFirstStartPayload.provider, "google_workspace");
    assert.equal(staleFirstStartPayload.connectId, brokeredConnect.connectId);
    assert.equal(htmlResponse.status, 200);
    assert.match(html, new RegExp(`<base href="/i/${brokerRegistration.instanceId}/app/"`));
    assert.match(html, new RegExp(`href="/i/${brokerRegistration.instanceId}/app/favicon\\.svg"`));
    assert.equal(apiResponse.status, 200);
    assert.equal(apiPayload.name, "tenant-vm");
    assert.equal(redirectResponse.status, 302);
    assert.equal(redirectResponse.headers.get("location"), `/i/${brokerRegistration.instanceId}/app/`);
    assert.equal(intentConnectorResponse.status, 200);
    assert.match(intentConnectorHtml, /Connect Gmail/);
    assert.equal(intentSetupResponse.status, 200);
    assert.equal(intentSetupPayload.connectors[0].state, "connected");
    assert.equal(intentUserResponse.status, 200);
    assert.equal(intentUserPayload.user.id, "firat");
    assert.equal(intentStartResponse.status, 200);
    assert.equal(intentStartPayload.provider, "google_workspace");
    assert.ok(intentStartPayload.connectId);
    assert.deepEqual(intentStartPayload.capabilities, ["gmail_send"]);
    const intentAuthorizeUrl = new URL(intentStartPayload.authorizeUrl);
    const intentScopes = String(intentAuthorizeUrl.searchParams.get("scope") || "").split(/\s+/g);
    assert.equal(intentAuthorizeUrl.origin, "https://accounts.google.com");
    assert.equal(intentAuthorizeUrl.searchParams.get("redirect_uri"), "https://app.orkestr.de/oauth/gmail/callback");
    assert.equal(intentAuthorizeUrl.searchParams.get("login_hint"), null);
    assert.doesNotMatch(intentStartPayload.state, /^tenant:/);
    assert.equal(intentSavedState.state, intentStartPayload.state);
    assert.equal(intentSavedState.tenantVmId, "");
    assert.equal(intentSavedState.brokerTenantVmId, "firat-jobs-vm");
    assert.equal(intentScopes.includes("https://www.googleapis.com/auth/gmail.readonly"), false);
    assert.equal(intentScopes.includes("https://www.googleapis.com/auth/gmail.modify"), false);
    assert.ok(intentScopes.includes("https://www.googleapis.com/auth/gmail.send"));
    assert.equal(intentScopes.includes("https://www.googleapis.com/auth/gmail.compose"), false);
    assert.equal(intentDisconnectResponse.status, 200);
    assert.equal(intentDisconnectPayload.provider, "gmail");
    assert.equal(intentThreadsResponse.status, 403);
    assert.equal(intentThreadsPayload.error, "auth_intent_session_scope_denied");
    assert.equal(parentAppResponse.status, 403);
    assert.equal(parentAppPayload.error, "auth_intent_session_scope_denied");
    assert.equal(upstreamRequests.some((item) => item.url === "/api/version"), true);
    assert.equal(
      upstreamRequests.some((item) => item.headers["x-orkestr-broker-instance-id"] === brokerRegistration.instanceId),
      true,
    );
    assert.equal(
      upstreamRequests.some((item) => typeof item.headers["x-orkestr-broker-auth"] === "string" && item.headers["x-orkestr-broker-auth"]),
      true,
    );
    assert.equal(
      upstreamRequests.some((item) => String(item.url || "").startsWith("/api/connectors/gmail/oauth/start")),
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    restoreEnv(prior);
  }
});

test("ops page exposes release broker inventory", async () => {
  const root = process.cwd();
  const template = await fs.readFile(path.join(root, "apps/web/src/app/ops-page.component.html"), "utf8");
  const component = await fs.readFile(path.join(root, "apps/web/src/app/ops-page.component.ts"), "utf8");
  const api = await fs.readFile(path.join(root, "apps/web/src/app/api.service.ts"), "utf8");
  const styles = await fs.readFile(path.join(root, "apps/web/src/styles.css"), "utf8");

  assert.match(api, /releaseInstances\(probe = true\)/);
  assert.match(api, /releaseRollout\(body:/);
  assert.match(api, /tenantVms\(\)/);
  assert.match(api, /updateTenantVmTrust\(tenantVmId: string, body: Record<string, unknown>\)/);
  assert.match(api, /watcherAlerts\(limit = 20\)/);
  assert.match(api, /interface WhatsAppDoctorResponse/);
  assert.match(api, /whatsappDoctor\(\)/);
  assert.match(api, /updateWhatsAppBinding\(bindingId: string, body: Record<string, unknown>\)/);
  assert.match(component, /opsReleaseInstances: ReleaseInstance\[\]/);
  assert.match(component, /opsTenantVms: TenantVm\[\]/);
  assert.match(component, /opsThreads: ThreadSummary\[\]/);
  assert.match(component, /opsWatcherAlerts: WatcherAlert\[\]/);
  assert.match(component, /opsWhatsAppDoctor: WhatsAppDoctorResponse \| null = null/);
  assert.match(component, /opsWhatsAppOutboxJobs: WhatsAppOutboxJob\[\] = \[\]/);
  assert.match(component, /releaseInstanceVersion\(instance: ReleaseInstance\)/);
  assert.match(component, /releaseInstanceTargetVersion\(instance: ReleaseInstance\)/);
  assert.match(component, /releaseInstanceHealthLabel\(instance: ReleaseInstance\)/);
  assert.match(component, /releaseInstanceDowntimeLabel\(instance: ReleaseInstance\)/);
  assert.match(component, /releaseAvailabilityPercent\(\): string/);
  assert.match(component, /releaseDowntimeTotalLabel\(\): string/);
  assert.match(component, /brokerUserCount\(\): number/);
  assert.match(component, /brokerThreadCount\(\): number/);
  assert.match(component, /brokerUnansweredThreadCount\(\): number/);
  assert.match(component, /brokerRuntimeSplitLabel\(\): string/);
  assert.match(component, /brokerSearchText = ""/);
  assert.match(component, /readonly brokerSavedViews: BrokerSavedView\[\]/);
  assert.match(component, /brokerVisibleInstances\(\): ReleaseInstance\[\]/);
  assert.match(component, /brokerVisibleThreads\(instance: ReleaseInstance\): BrokerThreadRow\[\]/);
  assert.match(component, /brokerVisibleAlerts\(\): WatcherAlert\[\]/);
  assert.match(component, /setBrokerSavedView\(viewId: BrokerSavedViewId\)/);
  assert.match(component, /saveBrokerViewState\(\): void/);
  assert.match(component, /brokerRemediationRow: BrokerThreadRow \| null = null/);
  assert.match(component, /requestBrokerRemediation\(row: BrokerThreadRow, action: "wake" \| "recover" \| "retry-outbox"\): void/);
  assert.match(component, /confirmBrokerRemediation\(\): Promise<void>/);
  assert.match(component, /brokerAclRow: BrokerThreadRow \| null = null/);
  assert.match(component, /whatsappBindingAclLabel\(binding: Record<string, unknown> = \{\}\): string/);
  assert.match(component, /requestBrokerAclChange\(row: BrokerThreadRow, mode: string\): void/);
  assert.match(component, /confirmBrokerAclChange\(\): Promise<void>/);
  assert.match(component, /brokerTrustInstance: ReleaseInstance \| null = null/);
  assert.match(component, /brokerInstanceTrustLabel\(instance: ReleaseInstance\): string/);
  assert.match(component, /requestBrokerTrust\(instance: ReleaseInstance, action: "trust" \| "revoke"\): void/);
  assert.match(component, /confirmBrokerTrust\(\): Promise<void>/);
  assert.match(component, /threadLooksUnanswered\(thread: ThreadSummary\): boolean/);
  assert.match(component, /releaseInstanceInfraLabel\(instance: ReleaseInstance\): string/);
  assert.match(component, /planReleaseRollout\(\): Promise<void>/);
  assert.match(component, /this\.api\.releaseRollout\(/);
  assert.match(component, /releaseRolloutResultLine\(\): string/);
  assert.match(component, /watcherAlertTitle\(alert: WatcherAlert\)/);
  assert.match(component, /whatsappAccountIdentity\(account: WhatsAppDoctorAccount\)/);
  assert.match(component, /visibleWhatsAppBindings\(\): WhatsAppDoctorBinding\[\]/);
  assert.match(component, /brokerThreads\(instance: ReleaseInstance\): BrokerThreadRow\[\]/);
  assert.match(component, /brokerAccountHistory\(\)/);
  assert.match(template, /visibleToolTabs\(\)/);
  assert.match(component, /kind: "managed"/);
  assert.match(component, /managedOpsEnabled\(\): boolean/);
  assert.match(component, /normalizedToolsView\(view: ToolsView\): ToolsView/);
  assert.match(template, /toolsView === "broker"/);
  assert.match(template, /releaseInstanceRolloutLabel\(instance\)/);
  assert.match(template, /releaseInstanceHealthLabel\(instance\)/);
  assert.match(template, /releaseInstanceDowntimeLabel\(instance\)/);
  assert.match(template, /releaseInstanceTargetVersion\(instance\)/);
  assert.match(template, /Availability/);
  assert.match(template, /releaseAvailabilityPercent\(\)/);
  assert.match(template, /releaseDowntimeTotalLabel\(\)/);
  assert.match(template, /brokerThreadCount\(\)/);
  assert.match(template, /brokerUserCount\(\)/);
  assert.match(template, /brokerUnansweredThreadCount\(\)/);
  assert.match(template, /brokerRuntimeSplitLabel\(\)/);
  assert.match(template, /name="broker-global-search"/);
  assert.match(template, /Saved broker views/);
  assert.match(template, /brokerSavedViews/);
  assert.match(template, /brokerSearchSummary\(\)/);
  assert.match(template, /brokerVisibleInstances\(\)/);
  assert.match(template, /brokerVisibleThreads\(instance\)/);
  assert.match(template, /brokerVisibleAlerts\(\)/);
  assert.match(template, /brokerRemediationRow/);
  assert.match(template, /confirmBrokerRemediation\(\)/);
  assert.match(template, /cancelBrokerRemediation\(\)/);
  assert.match(template, /brokerAclRow/);
  assert.match(template, /confirmBrokerAclChange\(\)/);
  assert.match(template, /requestBrokerAclChange\(row, 'owner-only'\)/);
  assert.match(template, /requestBrokerAclChange\(row, 'all-users'\)/);
  assert.match(template, /row\.aclLabel/);
  assert.match(template, /brokerTrustInstance/);
  assert.match(template, /brokerInstanceTrustLabel\(instance\)/);
  assert.match(template, /requestBrokerTrust\(instance, 'trust'\)/);
  assert.match(template, /requestBrokerTrust\(instance, 'revoke'\)/);
  assert.match(template, /confirmBrokerTrust\(\)/);
  assert.match(template, /row\.runtimeLabel/);
  assert.match(template, /row\.unansweredLabel/);
  assert.match(template, /releaseInstanceInfraLabel\(instance\)/);
  assert.match(template, /name="broker-rollout-ref"/);
  assert.match(template, /planReleaseRollout\(\)/);
  assert.match(template, /Rollout plan/);
  assert.match(template, /WhatsApp identities/);
  assert.match(template, /Instance Threads/);
  assert.match(template, /WA identities/);
  assert.match(template, /brokerVisibleThreads\(instance\)/);
  assert.match(template, /brokerWake\(row\)/);
  assert.match(template, /brokerRecover\(row\)/);
  assert.match(template, /brokerRetryOutbox\(row\)/);
  assert.match(template, /Recent Alerts/);
  assert.match(styles, /\.broker-search-panel/);
  assert.match(styles, /\.broker-saved-views/);
  assert.match(styles, /\.broker-remediation-confirm/);
  assert.match(styles, /\.broker-acl-confirm/);
  assert.match(styles, /\.broker-trust-confirm/);
  assert.doesNotMatch(template, /responder account/i);
});

test("server keeps public pages on the configured public site host only", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-static-ui-public-host-"));
  const prior = {
    home: process.env.ORKESTR_HOME,
    overlay: process.env.ORKESTR_OVERLAY_DIR,
    publicSiteUrl: process.env.ORKESTR_PUBLIC_SITE_URL,
    primaryDomain: process.env.ORKESTR_PRIMARY_DOMAIN,
    publicUrl: process.env.ORKESTR_PUBLIC_URL,
    publicAppUrl: process.env.ORKESTR_PUBLIC_APP_URL,
    publicAuthUrl: process.env.ORKESTR_PUBLIC_AUTH_URL,
    publicHttpsUrl: process.env.ORKESTR_PUBLIC_HTTPS_URL,
    connectPublicUrl: process.env.ORKESTR_CONNECT_PUBLIC_URL,
    pairingUrl: process.env.ORKESTR_PAIRING_URL,
    authRequired: process.env.ORKESTR_AUTH_REQUIRED,
  };
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_PUBLIC_SITE_URL = "https://orkestr.example.test";
  process.env.ORKESTR_PRIMARY_DOMAIN = "orkestr.example.test";
  process.env.ORKESTR_PUBLIC_URL = "https://app.orkestr.example.test";
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  delete process.env.ORKESTR_OVERLAY_DIR;
  delete process.env.ORKESTR_PUBLIC_APP_URL;
  delete process.env.ORKESTR_PUBLIC_AUTH_URL;
  delete process.env.ORKESTR_PUBLIC_HTTPS_URL;
  delete process.env.ORKESTR_CONNECT_PUBLIC_URL;
  delete process.env.ORKESTR_PAIRING_URL;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  try {
    const publicResponse = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { "x-forwarded-host": "orkestr.example.test", "x-forwarded-proto": "https" },
    });
    const publicHtml = await publicResponse.text();
    const privateRootResponse = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: "manual",
      headers: { "x-forwarded-host": "app.orkestr.example.test", "x-forwarded-proto": "https" },
    });
    const privateTermsResponse = await fetch(`http://127.0.0.1:${port}/terms`, {
      redirect: "manual",
      headers: { "x-forwarded-host": "private.example.test", "x-forwarded-proto": "https" },
    });
    const privateThreadResponse = await fetch(`http://127.0.0.1:${port}/thread/demo`, {
      headers: { "x-forwarded-host": "app.orkestr.example.test", "x-forwarded-proto": "https" },
    });
    const challengeResponse = await fetch(`http://127.0.0.1:${port}/api/setup/security/challenges`, { method: "POST" });
    const challenge = await challengeResponse.json();
    await approvePairingChallenge(challenge.challengeId, { approvedBy: "node:test", env: process.env });
    const pairResponse = await fetch(`http://127.0.0.1:${port}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId }),
    });
    const pairedCookie = pairResponse.headers.get("set-cookie") || "";
    assert.equal(pairResponse.status, 200);
    assert.match(pairedCookie, /orkestr_session=/);
    const pairedStatusResponse = await fetch(`http://127.0.0.1:${port}/api/setup/status`, {
      headers: { cookie: pairedCookie },
    });
    assert.equal(pairedStatusResponse.status, 200);
    const pairedPrivateRootResponse = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: "manual",
      headers: {
        "x-forwarded-host": "app.orkestr.example.test",
        "x-forwarded-proto": "https",
        cookie: pairedCookie,
      },
    });
    const pairedPrivateRootHtml = await pairedPrivateRootResponse.text();
    const privateThreadHtml = await privateThreadResponse.text();

    assert.equal(publicResponse.status, 200);
    assertPublicShell(publicHtml);
    assert.equal(privateRootResponse.status, 302);
    assert.equal(
      privateRootResponse.headers.get("location"),
      "https://orkestr.example.test/setup/pairing?return=https%3A%2F%2Fapp.orkestr.example.test%2F",
    );
    assert.equal(privateTermsResponse.status, 302);
    assert.equal(
      privateTermsResponse.headers.get("location"),
      "https://orkestr.example.test/setup/pairing?return=https%3A%2F%2Fprivate.example.test%2Fterms",
    );
    assert.equal(privateThreadResponse.status, 200);
    assertAngularShell(privateThreadHtml);
    assert.doesNotMatch(privateThreadHtml, /Invite-only private beta/);
    assert.equal(pairedPrivateRootResponse.status, 200);
    assertAngularShell(pairedPrivateRootHtml);
    assert.doesNotMatch(pairedPrivateRootHtml, /Invite-only private beta/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (prior.home === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = prior.home;
    if (prior.overlay === undefined) delete process.env.ORKESTR_OVERLAY_DIR;
    else process.env.ORKESTR_OVERLAY_DIR = prior.overlay;
    if (prior.publicSiteUrl === undefined) delete process.env.ORKESTR_PUBLIC_SITE_URL;
    else process.env.ORKESTR_PUBLIC_SITE_URL = prior.publicSiteUrl;
    if (prior.primaryDomain === undefined) delete process.env.ORKESTR_PRIMARY_DOMAIN;
    else process.env.ORKESTR_PRIMARY_DOMAIN = prior.primaryDomain;
    if (prior.publicUrl === undefined) delete process.env.ORKESTR_PUBLIC_URL;
    else process.env.ORKESTR_PUBLIC_URL = prior.publicUrl;
    if (prior.publicAppUrl === undefined) delete process.env.ORKESTR_PUBLIC_APP_URL;
    else process.env.ORKESTR_PUBLIC_APP_URL = prior.publicAppUrl;
    if (prior.publicAuthUrl === undefined) delete process.env.ORKESTR_PUBLIC_AUTH_URL;
    else process.env.ORKESTR_PUBLIC_AUTH_URL = prior.publicAuthUrl;
    if (prior.publicHttpsUrl === undefined) delete process.env.ORKESTR_PUBLIC_HTTPS_URL;
    else process.env.ORKESTR_PUBLIC_HTTPS_URL = prior.publicHttpsUrl;
    if (prior.connectPublicUrl === undefined) delete process.env.ORKESTR_CONNECT_PUBLIC_URL;
    else process.env.ORKESTR_CONNECT_PUBLIC_URL = prior.connectPublicUrl;
    if (prior.pairingUrl === undefined) delete process.env.ORKESTR_PAIRING_URL;
    else process.env.ORKESTR_PAIRING_URL = prior.pairingUrl;
    if (prior.authRequired === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = prior.authRequired;
  }
});

test("pairing-required flow stays on the Orkestr app host", async () => {
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");

  assert.match(component, /private enterPairingRequired/);
  assert.match(component, /this\.replacePairingPath\(\)/);
  assert.match(component, /params\.set\("instanceId", instanceId\)/);
  assert.doesNotMatch(component, /globalThis\.location\.href\s*=\s*authPairingUrl/);
  assert.doesNotMatch(component, /new URL\("\/setup\/pairing", authUrl\)/);
});

test("pairing return stays same-origin and Codex warnings stay non-blocking", async () => {
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");

  assert.match(component, /private authContextIssue\(\)/);
  assert.match(component, /setupStatusRedacted\(\)/);
  assert.match(component, /private codexStatusAuthoritative\(\)/);
  assert.match(component, /shouldShowCodexRequiredShell\(\): boolean\s*\{\s*return false;/);
  assert.match(component, /shouldShowCodexNotice\(\): boolean/);
  assert.match(component, /reason === "codex_auth_invalid"/);
  assert.match(component, /Codex sign-in expired/);
  assert.match(component, /Connect Codex Agent before starting coding agents or sending coding-agent tasks\./);
  assert.match(component, /sameOriginPairingReturnUrl/);
  assert.match(component, /target\.origin === current\.origin/);
  assert.doesNotMatch(component, /allowedOrigins\.includes\(target\.origin\)/);
  assert.doesNotMatch(template, /codex-required-shell/);
  assert.doesNotMatch(template, /Codex Agent broken/);
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
  assert.match(component, /!thread\.lastMessageRecovered/);
  assert.match(component, /Codex conversation was interrupted\./);
});

test("thread reload signature tracks final message identity", async () => {
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");

  assert.match(component, /thread\.lastMessageAt \|\| ""/);
  assert.match(component, /thread\.lastMessageCursor \?\? ""/);
  assert.match(component, /thread\.lastMessageId \|\| ""/);
  assert.match(component, /thread\.lastMessageRole \|\| ""/);
  assert.match(component, /thread\.lastMessagePhase \|\| ""/);
  assert.match(api, /lastMessageRecovered\?: boolean/);
  assert.match(api, /lastMessageCursor\?: number \| null/);
  assert.match(api, /lastMessageId\?: string \| null/);
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

test("thread STOP control is contextual to the runtime panel", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const headerStart = template.indexOf('<header class="chat-head">');
  const headerEnd = template.indexOf("</header>", headerStart);
  const header = template.slice(headerStart, headerEnd);
  const runtimeStart = template.indexOf('@if (activePanel === "runtime"');
  const runtimeEnd = template.indexOf('@if (activePanel === "raw"', runtimeStart);
  const runtimePanel = template.slice(runtimeStart, runtimeEnd);

  assert.match(template, /openPanel\('runtime'\)/);
  assert.doesNotMatch(header, />STOP<\/button>/);
  assert.match(runtimePanel, />STOP<\/button>/);
  assert.match(runtimePanel, /stopSelected\(\)/);
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
  assert.match(appComponent, /"connectors", "users", "waitlist", "audit"/);
  assert.match(template, /visibleToolTabs\(\)/);
  assert.match(template, /\[class\.active\]="toolsView === tab\.id"/);
  assert.match(component, /id: "audit", label: "Audit", kind: "oss-core"/);
  assert.match(template, /@if \(toolsView === "audit"\)/);
  assert.match(template, /Event storage/);
  assert.match(template, /\(click\)="rotateEventLog\(\)"/);
  assert.match(template, /\[href\]="eventArchiveUrl\(archive\)"/);
  assert.match(template, /name="audit-user-filter"/);
  assert.match(template, /name="audit-resource-filter"/);
  assert.match(template, /name="audit-connector-filter"/);
  assert.match(template, /name="audit-outcome-filter"/);
  assert.match(component, /filteredAuditEvents\(\): EventRecord\[\]/);
  assert.match(component, /rotateEventLog\(\): Promise<void>/);
  assert.match(component, /opsEventArchives: EventArchive\[\] = \[\]/);
  assert.match(component, /auditEventMeta\(event: EventRecord\): string/);
  assert.match(api, /events\(limit = 50, filters: Record<string, string> = \{\}\)/);
  assert.match(api, /eventArchives\(\): Observable<EventArchivesResponse>/);
  assert.match(api, /rotateEvents\(\): Observable/);
  assert.match(api, /eventArchiveDownloadUrl\(name: string\): string/);
  assert.match(systemController, /@Query\("connector"\) connector = ""/);
  assert.match(systemController, /@Get\("events\/archives"\)/);
  assert.match(systemController, /@Post\("events\/rotate"\)/);
  assert.match(auditEvents, /normalizeAuditEvent\(event = \{\}/);
  assert.match(auditEvents, /sensitiveAuditKey/);
  assert.match(sanitizer, /type: "policy_sanitizer_decision"/);
  assert.match(styles, /\.audit-filters/);
  assert.match(styles, /\.event-storage-actions/);
  assert.match(styles, /\.audit-row small/);
});

test("ops broker alert lifecycle controls are wired", async () => {
  const template = await fs.readFile("apps/web/src/app/ops-page.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/ops-page.component.ts", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const controller = await fs.readFile("apps/server/src/modules/system/system.controller.ts", "utf8");
  const watcherAlerts = await fs.readFile("packages/core/src/watcher-alerts.js", "utf8");
  const styles = await fs.readFile("apps/web/src/styles.css", "utf8");

  assert.match(api, /WatcherAlertActionResponse/);
  assert.match(api, /watcherAlertAction\(alertId: string, action: string/);
  assert.match(controller, /@Post\("system\/alerts\/:id\/action"\)/);
  assert.match(controller, /updateWatcherAlertLifecycle/);
  assert.match(watcherAlerts, /updateWatcherAlertLifecycle\(alertId, action/);
  assert.match(watcherAlerts, /watcher_alert_lifecycle_updated/);
  assert.match(component, /activeWatcherAlertActionId = ""/);
  assert.match(component, /watcherAlertActions\(alert: WatcherAlert\): string\[\]/);
  assert.match(component, /applyWatcherAlertAction\(alert: WatcherAlert, action: string\): Promise<void>/);
  assert.match(template, /watcherAlertActions\(alert\)/);
  assert.match(template, /applyWatcherAlertAction\(alert, action\)/);
  assert.match(template, /watcherAlertActionLabel\(action\)/);
  assert.match(styles, /\.alert-actions/);
});

test("thread delivery panel exposes admin WhatsApp outbox operator controls", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const controller = await fs.readFile("apps/server/src/modules/connectors/whatsapp-diagnostics.controller.ts", "utf8");
  const styles = await fs.readFile("apps/web/src/styles.css", "utf8");

  assert.match(api, /interface WhatsAppOutboxJob/);
  assert.match(api, /whatsappOutbox\(options: \{ threadId\?: string; state\?: string; accountId\?: string; chatId\?: string; deliveryType\?: string; limit\?: number \} = \{\}\)/);
  assert.match(api, /whatsappOutboxAction\(jobId: string, action: string/);
  assert.match(component, /deliveryOutboxJobs: WhatsAppOutboxJob\[\] = \[\]/);
  assert.match(component, /this\.api\.whatsappOutbox\(\{ threadId: thread\.id, limit: 50 \}\)/);
  assert.match(component, /applyOutboxAction\(job: WhatsAppOutboxJob, action: string\)/);
  assert.match(template, /WhatsApp Outbox/);
  assert.match(template, /@for \(action of outboxJobActions\(job\); track action\)/);
  assert.match(template, /\(click\)="applyOutboxAction\(job, action\)"/);
  assert.match(controller, /function assertAdminRequest\(request: any\)/);
  assert.match(controller, /whatsapp_outbox_admin_required/);
  assert.match(styles, /\.outbox-list/);
  assert.match(styles, /\.outbox-actions/);
});

test("thread WhatsApp settings use neutral connector account labels", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const controller = await fs.readFile("apps/server/src/modules/threads/thread-binding.controller.ts", "utf8");
  const schemas = await fs.readFile("packages/shared/src/api-schemas.js", "utf8");

  assert.match(template, /Receiving account/);
  assert.match(template, /Reply account/);
  assert.match(template, /Receive with/);
  assert.match(template, /Reply with/);
  assert.doesNotMatch(template, />Sender</);
  assert.doesNotMatch(template, />Responder</);
  assert.match(component, /selectedWhatsAppReplyAccountId\(\)/);
  assert.match(component, /selectedWhatsAppInboundAccountId\(\)/);
  assert.match(component, /replyAccountId,\n\s+bridgeAccountId: replyAccountId/);
  assert.match(component, /receivingAccountId,\n\s+inboundAccountId: receivingAccountId/);
  assert.match(controller, /replyAccountId/);
  assert.match(controller, /receivingAccountId/);
  assert.match(controller, /responderConnectorAccountId/);
  assert.match(schemas, /replyAccountId/);
  assert.match(schemas, /receivingAccountId/);
  assert.match(schemas, /responderConnectorAccountId/);
});

test("ops waitlist view exposes secure approval workflow", async () => {
  const opsTemplate = await fs.readFile("apps/web/src/app/ops-page.component.html", "utf8");
  const opsComponent = await fs.readFile("apps/web/src/app/ops-page.component.ts", "utf8");
  const waitlistTemplate = await fs.readFile("apps/web/src/app/ops-waitlist.component.html", "utf8");
  const waitlistComponent = await fs.readFile("apps/web/src/app/ops-waitlist.component.ts", "utf8");
  const appComponent = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const userWaitlist = await fs.readFile("packages/core/src/user-waitlist.js", "utf8");
  const waitlistNotifications = await fs.readFile("packages/core/src/waitlist-notifications.js", "utf8");
  const emailNotifications = await fs.readFile("packages/core/src/email-notifications.js", "utf8");
  const styles = await fs.readFile("apps/web/src/styles.css", "utf8");

  assert.match(opsComponent, /export type ToolsView = .*"waitlist"/);
  assert.match(opsComponent, /OpsWaitlistComponent/);
  assert.match(appComponent, /"connectors", "users", "waitlist", "audit"/);
  assert.match(opsComponent, /id: "waitlist", label: "Waitlist", kind: "managed"/);
  assert.match(opsTemplate, /visibleToolTabs\(\)/);
  assert.match(opsTemplate, /<ork-ops-waitlist><\/ork-ops-waitlist>/);
  assert.match(waitlistComponent, /this\.api\.waitlist\("", 500\)/);
  assert.match(waitlistComponent, /this\.api\.updateWaitlistEntry\(entry\.id/);
  assert.match(waitlistComponent, /this\.api\.approveWaitlistEntry\(entry\.id/);
  assert.match(waitlistTemplate, /High risk: approval creates or connects a user/);
  assert.match(waitlistTemplate, /I confirm this applicant should be onboarded/);
  assert.match(waitlistComponent, /Admin email not configured/);
  assert.match(waitlistTemplate, /Default WhatsApp account/);
  assert.match(waitlistTemplate, /Inbound account/);
  assert.match(waitlistTemplate, /Reply account/);
  assert.match(waitlistTemplate, /Delivery account/);
  assert.match(api, /export interface WaitlistEntry/);
  assert.match(api, /waitlist\(status = "", limit = 200\)/);
  assert.match(api, /approveWaitlistEntry\(id: string, body: Record<string, unknown>\)/);
  assert.match(userWaitlist, /notifyWaitlistEntrySubmitted/);
  assert.match(waitlistNotifications, /sendWaitlistNotification/);
  assert.match(waitlistNotifications, /waitlist_notification_sent/);
  assert.match(waitlistNotifications, /waitlist_notification_failed/);
  assert.match(emailNotifications, /ORKESTR_WAITLIST_NOTIFY_EMAIL/);
  assert.match(emailNotifications, /ORKESTR_SMTP_HOST/);
  assert.match(styles, /\.waitlist-warning/);
});

test("secure input routes are marked no-capture and metadata-only", async () => {
  const controller = await fs.readFile("apps/server/src/modules/secure-input/secure-input.controller.ts", "utf8");
  const core = await fs.readFile("packages/core/src/secure-secrets.js", "utf8");
  const cli = await fs.readFile("apps/cli/src/commands.js", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const opsComponent = await fs.readFile("apps/web/src/app/ops-page.component.ts", "utf8");
  const opsTemplate = await fs.readFile("apps/web/src/app/ops-page.component.html", "utf8");

  assert.match(controller, /X-Orkestr-Secure-Input/);
  assert.match(controller, /noMirror,noCapture,noCodexContext,noScreenshot/);
  assert.match(controller, /return setSecureSecret/);
  assert.match(core, /encryptedValue/);
  assert.match(core, /createCipheriv\("aes-256-gcm"/);
  assert.match(cli, /\/dev\/tty/);
  assert.match(cli, /stty \$\{enabled \? "echo" : "-echo"\}/);
  assert.match(api, /secureSecrets\(options: \{ scope\?: "user" \| "global"; userId\?: string \} = \{\}\)/);
  assert.match(opsComponent, /opsSecureSecrets: SecureSecretMetadata\[\] = \[\]/);
  assert.match(opsComponent, /loadOpsSecrets\(\): Promise<void>/);
  assert.match(opsTemplate, /Secret Manager/);
  assert.match(opsTemplate, /href="\/setup\/secrets"/);
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
  assert.match(template, /WhatsApp identity ID/);
  assert.match(template, /wa-identity-sender-/);
  assert.match(template, /wa-identity-chat-/);
  assert.match(template, /\(submit\)="linkWhatsAppIdentity\(user\); \$event\.preventDefault\(\)"/);
  assert.match(template, /\(click\)="unlinkWhatsAppIdentity\(user, identity\)"/);
});

test("WhatsApp binding mutation routes enforce principal-scoped account ownership", async () => {
  const controller = await fs.readFile("apps/server/src/modules/connectors/whatsapp-diagnostics.controller.ts", "utf8");

  assert.match(controller, /filterBindingsForPrincipal/);
  assert.match(controller, /bindingVisibleToPrincipal/);
  assert.match(controller, /assertResponderAccountBodyForPrincipal/);
  assert.match(controller, /assertBindingManageForPrincipal/);
  assert.match(controller, /wa_binding_read_forbidden/);
  assert.match(controller, /wa_binding_manage_forbidden/);
  assert.match(controller, /async createBinding\(@Req\(\) request: any/);
  assert.match(controller, /async updateBinding\(@Req\(\) request: any/);
  assert.match(controller, /async deleteBinding\(@Req\(\) request: any/);
  assert.match(controller, /async codexConnect\(@Req\(\) request: any/);
  assert.match(controller, /bindingBodyForPrincipal\(body, principal\)/);
  assert.match(controller, /whatsappBindingAclAllows as any\)\(binding, "manage"/);
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

test("runtime approval controls require an actionable pending request", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");

  assert.match(template, /@if \(hasActionablePendingApproval\(thread\)\)/);
  assert.match(component, /hasActionablePendingApproval\(thread: ThreadSummary \| null = this\.selectedThread\(\)\): boolean/);
  assert.match(component, /No Codex approval request is pending for this thread\./);
  assert.match(component, /flags\.includes\("waitingOnApproval"\)/);
});

test("web shell exposes runtime surface and Codex mode shortcuts", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const styles = await fs.readFile("apps/web/src/styles.css", "utf8");

  assert.match(template, /class="runtime-surface-toggle"/);
  assert.match(template, /switchRuntimeSurface\('api'\)/);
  assert.match(template, /switchRuntimeSurface\('terminal'\)/);
  assert.doesNotMatch(template, /switchRuntimeSurface\('agent'\)/);
  assert.match(template, /\/switch api/);
  assert.match(template, /\/switch term/);
  assert.doesNotMatch(template, /\/switch agent/);
  assert.match(template, /codexModeShortcutTitle\(thread\)/);
  assert.match(template, /Switch to Code mode with \/code/);
  assert.match(template, /Switch to Plan mode with \/plan/);
  assert.match(template, /class="version-pill"/);
  assert.match(template, /deploymentVersionLabel\(\)/);
  assert.match(template, /deploymentTrackLabel\(\)/);
  assert.match(template, /deploymentVersionTitle\(\)/);
  assert.match(component, /codexModeShortcutTitle\(thread: ThreadSummary \| null\): string/);
  assert.match(component, /versionInfo: VersionResponse \| null = null/);
  assert.match(component, /firstValueFrom\(this\.api\.version\(\)\)/);
  assert.match(component, /deploymentVersionLabel\(\): string/);
  assert.match(component, /version\.releaseLabel/);
  assert.match(component, /version\.buildId \|\| version\.releaseId/);
  assert.match(component, /deploymentTrackLabel\(\): string/);
  assert.match(component, /deploymentVersionTitle\(\): string/);
  assert.match(component, /switchRuntimeSurface\(runtime: "api" \| "terminal"\): Promise<void>/);
  assert.match(component, /runtimeSurfaceSwitchDisabled\(runtime: "api" \| "terminal"\): boolean/);
  assert.match(component, /runtimeSurfaceShortcutTitle\(thread: ThreadSummary \| null\): string/);
  assert.match(component, /Shortcuts: \/code, \/plan/);
  assert.match(component, /Switch: \/switch api, \/switch terminal/);
  assert.doesNotMatch(component, /Switch: \/switch api, \/switch terminal, \/switch agent/);
  assert.match(styles, /\.runtime-surface-pill/);
  assert.match(styles, /\.runtime-surface-toggle/);
  assert.match(styles, /\.runtime-surface-pill\.codex-api/);
  assert.match(styles, /\.runtime-surface-pill\.codex-tmux/);
  assert.match(styles, /\.runtime-surface-pill\.attached-terminal/);
  assert.match(styles, /\.runtime-surface-pill\.agent-runtime/);
  assert.match(styles, /\.version-pill/);
  assert.doesNotMatch(template, /class="runtime-surface-chip"/);
});

test("web shell switches to a constrained non-admin user mode", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const composerTemplate = await fs.readFile("apps/web/src/app/thread-composer.component.html", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");
  const usersController = await fs.readFile("apps/server/src/modules/users/users.controller.ts", "utf8");
  const styles = await fs.readFile("apps/web/src/styles.css", "utf8");

  assert.match(api, /currentUser\(\): Observable<UserResponse>/);
  assert.match(usersController, /@Get\("me"\)/);
  assert.match(component, /currentUser: OrkestrUser \| null = null/);
  assert.match(component, /firstValueFrom\(this\.api\.currentUser\(\)\)/);
  assert.match(component, /shouldShowCodexRequiredShell\(\): boolean\s*\{\s*return false;/);
  assert.match(component, /uiRuntimeReady\(\): boolean/);
  assert.match(component, /uiRuntimeReady\(\): boolean\s*\{\s*return true;/);
  assert.match(component, /panelAllowedForCurrentUser\(panel: Panel\): boolean/);
  assert.match(component, /\["chat", "history", "delivery", "timers", "files", "userTimers", "userDesk", "userConnectors"\]\.includes\(panel\)/);
  assert.match(component, /normalizeUserModeView\(\)/);
  assert.match(component, /isUserNavPanelActive\(panel: Panel\): boolean/);
  assert.match(component, /isRouteLevelUserPanel\(panel: Panel\): boolean/);
  assert.match(component, /This user account is limited to one chat\./);
  assert.match(template, /\[class\.user-mode\]="isUserMode\(\)"/);
  assert.match(template, /class="user-mode-card"/);
  assert.match(template, /class="user-mode-nav"/);
  assert.match(template, /\(click\)="openPanel\('chat'\)">Chat<\/button>/);
  assert.match(template, /\(click\)="openPanel\('files'\)">Files<\/button>/);
  assert.match(template, /\(click\)="openPanel\('userTimers'\)">Automations<\/button>/);
  assert.match(template, /\(click\)="openPanel\('userDesk'\)">Desk<\/button>/);
  assert.match(template, /\(click\)="openPanel\('userConnectors'\)">Connectors<\/button>/);
  assert.doesNotMatch(template, /\(click\)="openPanel\('userSkills'\)">Skills<\/button>/);
  assert.match(template, /\[placeholder\]="sidebarSearchPlaceholder\(\)"/);
  assert.match(template, /@if \(isAdminMode\(\) && visibleChildWorkers\(thread\)\.length > 0\)/);
  assert.match(template, /@if \(activePanel === "settings" && isAdminMode\(\)\)/);
  assert.match(template, /@if \(activePanel === "workers" && isAdminMode\(\)\)/);
  assert.match(template, /@if \(isAdminMode\(\)\) \{\s*<div class="codex-control-scroll"/s);
  assert.match(template, /\[inputReady\]="threadInputReady\(\)"/);
  assert.match(composerTemplate, /\[disabled\]="!inputReady"/);
  assert.match(styles, /\.user-mode-card/);
  assert.match(styles, /\.user-mode-nav/);
});

test("web shell exposes a user automation management page", async () => {
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
  assert.match(component, /panel === "userTimers"\) return this\.appPath\("\/timers"\)/);
  assert.match(component, /globalThis\.document\.title = "Automations · Orkestr"/);
  assert.match(template, /<ork-user-timers-page><\/ork-user-timers-page>/);
  assert.match(template, /\(click\)="openPanel\('userTimers'\)"/);
  assert.match(timersComponent, /selector: "ork-user-timers-page"/);
  assert.match(timersComponent, /this\.api\.threads\(\)/);
  assert.match(timersComponent, /this\.api\.automations\(\)/);
  assert.match(timersComponent, /this\.api\.automationDoctor\(\)/);
  assert.match(timersComponent, /this\.api\.createAutomation\(body\)/);
  assert.match(timersComponent, /this\.api\.runAutomation\(automation\.automationId\)/);
  assert.match(timersComponent, /this\.api\.pauseAutomation\(automation\.automationId\)/);
  assert.match(timersComponent, /this\.api\.resumeAutomation\(automation\.automationId\)/);
  assert.match(timersComponent, /this\.api\.deleteAutomation\(automation\.automationId\)/);
  assert.match(timersComponent, /targetType: "thread"/);
  assert.match(timersTemplate, /Automations/);
  assert.match(timersTemplate, /Doctor/);
  assert.match(timersTemplate, /automation-doctor-counts/);
  assert.match(timersTemplate, /name="user-timer-target"/);
  assert.match(timersTemplate, /Run once/);
  assert.match(timersTemplate, /Pause/);
  assert.match(timersTemplate, /Resume/);
  assert.match(api, /automations\(\): Observable<\{ automations: AutomationRecord\[\] \}>/);
  assert.match(api, /automationDoctor\(\): Observable<AutomationDoctorResponse>/);
  assert.match(api, /pauseAutomation\(id: string\)/);
  assert.match(api, /resumeAutomation\(id: string\)/);
  assert.match(api, /createTimer\(body: Record<string, string>\)/);
  assert.match(api, /deleteTimer\(id: string\)/);
  assert.match(api, /runTimer\(id: string\)/);
  assert.match(styles, /\.user-timer-editor/);
  assert.match(styles, /\.automation-doctor/);
  assert.match(styles, /\.timer-actions/);
});

test("automation doctor entry points forward owner connector principals", async () => {
  const controller = await fs.readFile("apps/server/src/modules/automations/automations.controller.ts", "utf8");
  const tenantTools = await fs.readFile("packages/core/src/tenant-api-agent-tools.js", "utf8");

  assert.match(controller, /connectorStatusProvider: \(provider: string, connectorPrincipal = principal\)/);
  assert.match(controller, /connectorAuthStatus\(provider, process\.env, \{ principal: connectorPrincipal \}\)/);
  assert.match(tenantTools, /connectorStatusProvider: \(provider, connectorPrincipal = principal\)/);
  assert.match(tenantTools, /connectorAuthStatus\(provider, env, \{ principal: connectorPrincipal \}\)/);
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
  assert.match(component, /panel === "userDesk"\) return this\.appPath\("\/desk"\)/);
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
  assert.match(component, /connectorLoginActive\(\): boolean/);
  assert.match(component, /private connectorLoginProvider\(parts: string\[\] = this\.locationPathParts\(\)\): string/);
  assert.match(component, /this\.appPath\(`\/connectors\$\{suffix\}`\)/);
  assert.match(component, /panel === "userConnectors"\) return this\.appPath\("\/connectors"\)/);
  assert.match(component, /globalThis\.document\.title = "Connectors · Orkestr"/);
  assert.match(template, /@else if \(connectorLoginActive\(\)\)/);
  assert.match(template, /class="connector-login-shell"/);
  assert.match(template, /<ork-user-connectors-page><\/ork-user-connectors-page>/);
  assert.match(template, /\(click\)="openPanel\('userConnectors'\)"/);
  assert.match(connectorsComponent, /selector: "ork-user-connectors-page"/);
  assert.match(connectorsComponent, /imports: \[FormsModule\]/);
  assert.match(connectorsComponent, /private autoStartedRoute = ""/);
  assert.match(connectorsComponent, /this\.api\.setupStatus\(\)/);
  assert.match(connectorsComponent, /this\.api\.currentUser\(\)/);
  assert.match(connectorsComponent, /Promise\.allSettled/);
  assert.match(connectorsComponent, /if \(!this\.setupStatus\) return \[\]/);
  assert.match(connectorsComponent, /scheduleRetryIfNeeded\(\): void/);
  assert.match(connectorsComponent, /maybeAutoStartRouteLogin\(\): void/);
  assert.match(connectorsComponent, /if \(!this\.setupStatus\) return/);
  assert.match(connectorsComponent, /startGmail\(options: \{ autoRedirect\?: boolean \} = \{\}\)/);
  assert.match(connectorsComponent, /disconnectGmail\(\): Promise<void>/);
  assert.match(connectorsComponent, /connectorConnected\(connector: ConnectorStatus\): boolean/);
  assert.match(connectorsComponent, /connectorNeedsReconnect\(connector: ConnectorStatus\): boolean/);
  assert.match(connectorsComponent, /connectedAccount\(connector: ConnectorStatus\): string/);
  assert.match(connectorsComponent, /connectedCapabilityLabels\(connector: ConnectorStatus\): string\[\]/);
  assert.match(connectorsComponent, /globalThis\.location\.href = this\.gmailAuth\.authorizeUrl/);
  assert.match(connectorsComponent, /this\.connectorStatus\("gmail"\)\.state/);
  assert.match(connectorsComponent, /\["connected", "degraded"\]\.includes/);
  assert.match(connectorsComponent, /connectorIntentActive\(\): boolean/);
  assert.match(connectorsComponent, /connectorIntentMethod\(\): string/);
  assert.match(connectorsComponent, /connectorIntentTool\(\): string/);
  assert.match(connectorsComponent, /connectorIntentProvider\(\): string/);
  assert.match(connectorsComponent, /connectorIntentAction\(\): string/);
  assert.match(connectorsComponent, /connectorIntentServiceLabel\(\): string/);
  assert.match(connectorsComponent, /connectorIntentAccountLabel\(\): string/);
  assert.match(connectorsComponent, /connectorIntentUserLabel\(\): string/);
  assert.match(connectorsComponent, /connectorIntentThreadLabel\(\): string/);
  assert.match(connectorsComponent, /routeQueryParam\(name: string\): string/);
  assert.match(connectorsComponent, /void this\.load\(false\)/);
  assert.match(connectorsComponent, /this\.api\.startGmailOAuth\(\)/);
  assert.match(connectorsComponent, /this\.api\.disconnectGmailAuth\(\)/);
  assert.match(connectorsComponent, /this\.api\.startOutlookOAuth\(this\.outlookAccount\)/);
  assert.match(connectorsComponent, /private readonly connectorOrder = \["whatsapp", "gmail", "outlook", "jira", "shopify", "linkedin", "browsers"\]/);
  assert.match(connectorsComponent, /private appBasePath\(\): string/);
  assert.match(connectorsComponent, /private locationPathParts\(\): string\[\]/);
  assert.match(connectorsComponent, /deskPath\(\): string/);
  assert.match(connectorsTemplate, /\[class\.login-only\]="loginOnly\(\)"/);
  assert.match(connectorsTemplate, /\[attr\.data-mcp\]="connectorIntentActive\(\) \? connectorIntentMethod\(\) : null"/);
  assert.match(connectorsTemplate, /\[attr\.data-service\]="connectorIntentActive\(\) \? 'gmail' : null"/);
  assert.match(connectorsTemplate, /\[attr\.data-provider\]="connectorIntentActive\(\) \? connectorIntentProvider\(\) : null"/);
  assert.match(connectorsTemplate, /\[attr\.data-action\]="connectorIntentActive\(\) \? connectorIntentAction\(\) : null"/);
  assert.match(connectorsTemplate, /Connection context/);
  assert.match(connectorsTemplate, /connectorIntentTool\(\)/);
  assert.match(connectorsTemplate, /Service/);
  assert.match(connectorsTemplate, /Provider/);
  assert.match(connectorsTemplate, /Action/);
  assert.match(connectorsTemplate, /User/);
  assert.match(connectorsTemplate, /Thread/);
  assert.match(connectorsTemplate, /connector\.id === "gmail" && !connectorConnected\(connector\)/);
  assert.match(connectorsTemplate, /connectorIntentTargetInstanceId\(\)/);
  assert.match(connectorsTemplate, /loginOnly\(\) \? "Secure sign-in" : "Connectors"/);
  assert.match(connectorsTemplate, /Google account/);
  assert.match(connectorsTemplate, /connectedAccount\(connector\)/);
  assert.match(connectorsTemplate, /Delete Gmail auth/);
  assert.match(connectorsTemplate, /disconnectGmail\(\)/);
  assert.match(connectorsTemplate, /class="connector-details"/);
  assert.doesNotMatch(connectorsTemplate, /name="user-gmail-account"/);
  assert.match(connectorsTemplate, /Reconnect Gmail/);
  assert.match(connectorsTemplate, /name="user-outlook-account"/);
  assert.match(connectorsTemplate, /Open Gmail sign-in/);
  assert.match(connectorsTemplate, /Open Microsoft sign-in/);
  assert.match(connectorsTemplate, /\[href\]="deskPath\(\)"/);
  assert.match(api, /startGmailOAuth\(account = ""\)/);
  assert.match(api, /disconnectGmailAuth\(\)/);
  assert.match(api, /startOutlookOAuth\(account = ""\)/);
  assert.match(styles, /\.user-connector-grid/);
  assert.match(styles, /\.connector-login-shell/);
  assert.match(styles, /\.user-connectors-page\.login-only \.user-connector-grid/);
  assert.match(styles, /\.connector-intent/);
  assert.match(styles, /\.connector-details/);
  assert.match(styles, /\.connector-action/);
  assert.match(styles, /\.connector-device-code/);
});

test("web shell keeps user skills chat and API only", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");
  const usersController = await fs.readFile("apps/server/src/modules/users/users.controller.ts", "utf8");
  const agentTools = await fs.readFile("packages/core/src/tenant-api-agent-tools.js", "utf8");
  const agent = await fs.readFile("packages/core/src/tenant-api-agent.js", "utf8");
  const opsTemplate = await fs.readFile("apps/web/src/app/ops-page.component.html", "utf8");
  const api = await fs.readFile("apps/web/src/app/api.service.ts", "utf8");

  assert.doesNotMatch(component, /UserSkillsPageComponent/);
  assert.doesNotMatch(component, /"userSkills"/);
  assert.match(component, /parts\[0\] === "skills"/);
  assert.match(component, /parts\[0\] === "ng" && parts\[1\] === "skills"/);
  assert.doesNotMatch(template, /<ork-user-skills-page><\/ork-user-skills-page>/);
  assert.doesNotMatch(template, /\(click\)="openPanel\('userSkills'\)"/);
  assert.doesNotMatch(opsTemplate, /<h4>Skills<\/h4>/);
  assert.match(api, /interface UserSkill/);
  assert.match(api, /currentUserSkills\(\)/);
  assert.match(api, /userSkills\(id: string\)/);
  assert.match(api, /createCurrentUserSkill\(body: Record<string, unknown>\)/);
  assert.match(api, /searchCurrentUserSkills\(query: string\)/);
  assert.match(api, /deleteCurrentUserSkill\(skillId: string\)/);
  assert.match(api, /updateUserSkill\(id: string, skillId: string, enabled: boolean\)/);
  assert.match(usersController, /@Post\("me\/skills"\)/);
  assert.match(usersController, /@Get\("me\/skills\/search"\)/);
  assert.match(usersController, /@Delete\("me\/skills\/:skillId"\)/);
  assert.match(agentTools, /name: "orkestr_create_skill"/);
  assert.match(agentTools, /name: "orkestr_search_skills"/);
  assert.match(agentTools, /name: "orkestr_delete_skill"/);
  assert.match(agent, /Users manage skills through chat/);
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
  assert.match(component, /panel === "files"\) return this\.appPath\("\/files"\)/);
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

test("web shell keeps broker-mounted tenant routes under base href", async () => {
  const component = await fs.readFile("apps/web/src/app/app.component.ts", "utf8");

  assert.match(component, /private appBasePath\(\): string/);
  assert.match(component, /private locationPathParts\(\): string\[\]/);
  assert.match(component, /private appPath\(path: string\): string/);
  assert.match(component, /const parts = this\.locationPathParts\(\)/);
  assert.match(component, /if \(panel === "userConnectors"\) return this\.appPath\("\/connectors"\)/);
  assert.match(component, /return this\.appPath\(`\/thread\/\$\{encodeURIComponent\(id\)\}\$\{suffix\}`\)/);
  assert.match(component, /return this\.appPath\(view === "system" \? "\/ops" : `\/ops\/\$\{view\}`\)/);
});

test("mobile desktop shell wraps noVNC with phone-first controls", async () => {
  const proxy = await fs.readFile("apps/server/src/desktop-proxy.ts", "utf8");
  const shell = await fs.readFile("apps/server/src/mobile-desktop-shell.ts", "utf8");
  const sharePage = await fs.readFile("apps/server/src/static-fallback.ts", "utf8");

  assert.match(proxy, /isMobileDesktopRoute/);
  assert.match(proxy, /serveMobileDesktopShell/);
  assert.match(proxy, /ensureVirtualBrowserReady/);
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
  assert.match(sharePage, /const shareIndex = parts\.indexOf\('desktop-share'\)/);
  assert.match(sharePage, /const shareParts = shareIndex >= 0 \? parts\.slice\(shareIndex\) : parts/);
  assert.match(sharePage, /const tenantShare = shareParts\[0\] === 'desktop-share' && shareParts\[1\] === 'tvm'/);
  assert.match(sharePage, /const subdomain = tenantShare \? decodeURIComponent\(shareParts\[3\]/);
  assert.match(sharePage, /\/api\/tenant-vms\//);
  assert.match(sharePage, /subdomain \? '&subdomain='/);
  assert.match(sharePage, /desktop\/.*\/mobile/);
});
