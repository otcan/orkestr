import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { authorizeMobileDeviceHttpRequest, refreshMobileDeviceSession } from "../packages/core/src/mobile-device-auth.js";
import {
  approveMobileDevicePairing,
  completeMobileDevicePairing,
  listMobileDevices,
  listMobileProfiles,
  pollMobileDevicePairing,
  startMobileDevicePairing,
} from "../packages/core/src/mobile-devices.js";
import { sha256 } from "../packages/core/src/mobile-device-crypto.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { authorizeHttpRequest, approvePairingChallenge, createPairingChallenge, pairBrowser } from "../packages/core/src/security.js";
import { createThread } from "../packages/core/src/threads.js";

function saveEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function keyPair() {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { ...pair, publicJwk: pair.publicKey.export({ format: "jwk" }) };
}

function signJwt(privateKey, claims) {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.sign(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key: privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function timedClaims(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iat: now, exp: now + 120, ...extra };
}

function assertNoPrivateMobileFields(payload) {
  const serialized = JSON.stringify(payload);
  for (const field of ["profileId", "ownerUserId", "userId", "threadId", "scopes", "requestedIp", "requestedUserAgent", "machineContext"]) {
    assert.equal(serialized.includes(`"${field}"`), false, `${field} leaked in ${serialized}`);
  }
}

async function setupMobileEnv(t, extra = {}, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mobile-devices-"));
  const profilesFile = path.join(home, "mobile-profiles.json");
  const keys = [
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_MOBILE_PROFILES_FILE",
    "ORKESTR_MOBILE_PAIRING_CLIENT_CREATE_LIMIT",
    "ORKESTR_RECOVER_RUNNING_ON_START",
    "ORKESTR_WHATSAPP_AUTOSTART",
    "WHATSAPP_LOCAL_AUTOSTART",
    "ORKESTR_CODEX_BIN",
    "ORKESTR_WHATSAPP_BRIDGE_TOKEN",
    "ORKESTR_PRIMARY_DOMAIN",
    "ORKESTR_DOMAIN",
    "ORKESTR_HOST_BOUNDARIES",
    "ORKESTR_APP_HOST",
    "ORKESTR_AUTH_HOST",
    "ORKESTR_APP_URL",
    "ORKESTR_AUTH_URL",
    "ORKESTR_PUBLIC_APP_URL",
    "ORKESTR_PUBLIC_AUTH_URL",
    "ORKESTR_PUBLIC_URL",
    "ORKESTR_PUBLIC_HTTPS_URL",
    "ORKESTR_HTTPS_URL",
    "ORKESTR_TAILSCALE_HTTPS_NAME",
    "ORKESTR_CONNECT_PUBLIC_URL",
    "ORKESTR_CONNECT_PUBLIC_BASE_URL",
  ];
  const prior = saveEnv(keys);
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_MOBILE_PROFILES_FILE: profilesFile,
    ORKESTR_RECOVER_RUNNING_ON_START: "0",
    ORKESTR_WHATSAPP_AUTOSTART: "0",
    WHATSAPP_LOCAL_AUTOSTART: "0",
    ORKESTR_CODEX_BIN: "__orkestr_disabled_codex__",
    ORKESTR_PRIMARY_DOMAIN: "",
    ORKESTR_DOMAIN: "",
    ORKESTR_HOST_BOUNDARIES: "0",
    ORKESTR_APP_HOST: "",
    ORKESTR_AUTH_HOST: "",
    ORKESTR_APP_URL: "",
    ORKESTR_AUTH_URL: "",
    ORKESTR_PUBLIC_APP_URL: "",
    ORKESTR_PUBLIC_AUTH_URL: "",
    ORKESTR_PUBLIC_URL: "",
    ORKESTR_PUBLIC_HTTPS_URL: "",
    ORKESTR_HTTPS_URL: "",
    ORKESTR_TAILSCALE_HTTPS_NAME: "",
    ORKESTR_CONNECT_PUBLIC_URL: "",
    ORKESTR_CONNECT_PUBLIC_BASE_URL: "",
    ...extra,
  });
  await createThread({ id: "hush-thread", name: "Hush Thread", ownerUserId: "admin" }, process.env);
  await fs.writeFile(profilesFile, JSON.stringify({
    profiles: options.profiles || [{
      id: "owner-phone",
      label: "Owner Phone",
      ownerUserId: "admin",
      userId: "admin",
      threadId: "hush-thread",
      role: "admin",
      scopes: ["thread:input", "thread:read", "desktops:open"],
    }],
  }));
  const cleanup = async () => {
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  if (options.autoCleanup !== false) t.after(cleanup);
  return { env: process.env, home, profilesFile, cleanup };
}

async function pairApprovedDevice(t) {
  const { env } = await setupMobileEnv(t);
  const keys = keyPair();
  const machineContext = {
    platform: "ios",
    appVersion: "1.0.0",
    deviceName: "Can Phone",
    osVersion: "18.5",
    installationId: "install-1",
  };
  const started = await startMobileDevicePairing({
    env,
    request: { headers: { "user-agent": "mobile-test" }, ip: "203.0.113.9" },
    body: { publicKeyJwk: keys.publicJwk, machineContext },
  });
  await approveMobileDevicePairing(started.pairing.approveCode, {
    env,
    profileId: "owner-phone",
    principal: adminPrincipal({ id: "admin" }),
  });
  const firstPoll = await pollMobileDevicePairing(started.pairing.id, { env, pollToken: started.pollToken });
  const secondPoll = await pollMobileDevicePairing(started.pairing.id, { env, pollToken: started.pollToken });
  assert.deepEqual(secondPoll.challenge, firstPoll.challenge);
  const pairingClaims = timedClaims({
    aud: "orkestr.mobile.pairing",
    pairingId: started.pairing.id,
    challengeId: firstPoll.challenge.id,
    challenge: firstPoll.challenge.nonce,
    publicKeyThumbprint: firstPoll.challenge.publicKeyThumbprint,
    machineContextHash: firstPoll.challenge.machineContextHash,
    jti: "pair-proof-1",
  });
  const completed = await completeMobileDevicePairing(started.pairing.id, {
    env,
    pollToken: started.pollToken,
    challengeId: firstPoll.challenge.id,
    proof: signJwt(keys.privateKey, pairingClaims),
  });
  return { env, keys, started, polled: firstPoll, completed };
}

test("mobile device pairing binds private overlay profile only at owner approval", async (t) => {
  const { env, keys, started } = await pairApprovedDevice(t);
  const profiles = await listMobileProfiles({ env, principal: adminPrincipal({ id: "admin" }) });
  assert.deepEqual(profiles.profiles, [{ id: "owner-phone", label: "Owner Phone", status: "active" }]);
  assertNoPrivateMobileFields(started);
  assert.equal(JSON.stringify(started).includes("\"d\""), false);
  assert.equal(started.pairing.status, "pending");
  assert.match(started.pairing.approveCode, /^[A-Z0-9]+$/);

  await assert.rejects(
    startMobileDevicePairing({ env, body: { publicKeyJwk: keys.publicJwk, deviceName: "" } }),
    /mobile_device_name_required/,
  );
  await assert.rejects(
    pollMobileDevicePairing(started.pairing.id, { env, pollToken: "wrong" }),
    /mobile_pairing_not_found/,
  );
  await assert.rejects(
    completeMobileDevicePairing(started.pairing.id, {
      env,
      pollToken: started.pollToken,
      challengeId: "already-used",
      proof: signJwt(keys.privateKey, timedClaims({ aud: "orkestr.mobile.pairing", jti: "late" })),
    }),
    /mobile_pairing_completed/,
  );
});

test("mobile access activates only on exact Hush mobile routes and rejects replay", async (t) => {
  const { env, keys, completed } = await pairApprovedDevice(t);
  assertNoPrivateMobileFields(completed);
  const requestBody = { text: "hello" };
  const requestClaims = timedClaims({
    aud: "orkestr.mobile.request",
    sid: completed.session.id,
    did: completed.device.id,
    ath: sha256(completed.accessToken),
    method: "POST",
    path: "/api/mobile/hush/voice/input",
    bodySha256: sha256(JSON.stringify(requestBody)),
    jti: "request-proof-1",
  });
  const request = {
    method: "POST",
    url: "/api/mobile/hush/voice/input",
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "x-orkestr-content-sha256": sha256(JSON.stringify(requestBody)),
      "x-orkestr-device-proof": signJwt(keys.privateKey, requestClaims),
    },
  };
  const authorized = await authorizeHttpRequest(request, env);
  assert.equal(authorized.ok, true);
  assert.equal(authorized.machineAuth, "hush_mobile");
  assert.deepEqual(authorized.machineAuthContext, {
    tokenId: authorized.machineAuthContext.tokenId,
    routeKind: "hush_mobile",
    route: "/api/mobile/hush/voice/input",
    scopes: ["thread:input"],
    principalKind: "mobile_device",
    principalId: completed.device.id,
    ownerUserId: "admin",
    userId: "admin",
    threadId: "hush-thread",
    deviceId: completed.device.id,
    sessionId: completed.session.id,
    profileId: "owner-phone",
    proofJti: "request-proof-1",
    proofIat: requestClaims.iat,
  });
  const replay = await authorizeMobileDeviceHttpRequest(request, env);
  assert.equal(replay.ok, false);
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.error, "mobile_device_proof_replayed");
});

test("mobile bearer fails closed outside exact Hush routes and malformed proof returns stable 401", async (t) => {
  const { env, completed } = await pairApprovedDevice(t);
  for (const url of ["/api/threads?scope=all", "/api/desktops/leases", "/api/setup/status"]) {
    const outOfScope = await authorizeHttpRequest({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${completed.accessToken}` },
    }, env);
    assert.equal(outOfScope.ok, false, url);
    assert.equal(outOfScope.statusCode, 403, url);
    assert.equal(outOfScope.machineAuth, "hush_mobile", url);
    assert.equal(outOfScope.error, "hush_mobile_route_forbidden", url);
  }

  const missingProof = await authorizeHttpRequest({
    method: "GET",
    url: "/api/mobile/hush/voice/messages",
    headers: { authorization: `Bearer ${completed.accessToken}` },
  }, env);
  assert.equal(missingProof.ok, false);
  assert.equal(missingProof.statusCode, 401);
  assert.equal(missingProof.machineAuth, "hush_mobile");
  assert.equal(missingProof.error, "mobile_device_proof_invalid");
});

test("mobile refresh rotates refresh and access tokens without blocking refresh route", async (t) => {
  const { env, keys, completed } = await pairApprovedDevice(t);
  const refreshBody = { refreshToken: completed.refreshToken };
  const refreshRequest = {
    method: "POST",
    url: "/api/mobile/session/refresh",
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "x-orkestr-content-sha256": sha256(JSON.stringify(refreshBody)),
    },
  };
  const refreshRoute = await authorizeHttpRequest(refreshRequest, env);
  assert.equal(refreshRoute.ok, true);
  assert.equal(refreshRoute.machineAuth, undefined);

  const refreshClaims = timedClaims({
    aud: "orkestr.mobile.refresh",
    sid: completed.session.id,
    did: completed.device.id,
    rth: sha256(completed.refreshToken),
    method: "POST",
    path: "/api/mobile/session/refresh",
    bodySha256: sha256(JSON.stringify(refreshBody)),
    jti: "refresh-proof-1",
  });
  const refreshed = await refreshMobileDeviceSession({
    env,
    refreshToken: completed.refreshToken,
    request: refreshRequest,
    proof: signJwt(keys.privateKey, refreshClaims),
  });
  assert.notEqual(refreshed.refreshToken, completed.refreshToken);
  assert.notEqual(refreshed.accessToken, completed.accessToken);
  assertNoPrivateMobileFields(refreshed);
  await assert.rejects(
    refreshMobileDeviceSession({
      env,
      refreshToken: completed.refreshToken,
      request: refreshRequest,
      proof: signJwt(keys.privateKey, { ...refreshClaims, jti: "refresh-proof-old" }),
    }),
    /mobile_refresh_invalid/,
  );
  assert.equal(await authorizeMobileDeviceHttpRequest({
    method: "POST",
    url: "/api/mobile/hush/voice/input",
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "x-orkestr-device-proof": "malformed",
    },
  }, env), null);
});

test("mobile public pairing start is client rate limited", async (t) => {
  const { env } = await setupMobileEnv(t, { ORKESTR_MOBILE_PAIRING_CLIENT_CREATE_LIMIT: "1" });
  const keys = keyPair();
  const request = { headers: { "user-agent": "same-device" }, ip: "198.51.100.10" };
  await startMobileDevicePairing({ env, request, body: { publicKeyJwk: keys.publicJwk, deviceName: "Phone 1" } });
  await assert.rejects(
    startMobileDevicePairing({ env, request, body: { publicKeyJwk: keys.publicJwk, deviceName: "Phone 2" } }),
    /mobile_pairing_client_rate_limited/,
  );
});

test("mobile auth ignores unrelated bearer machine tokens without creating state", async (t) => {
  const { env, home } = await setupMobileEnv(t, { ORKESTR_WHATSAPP_BRIDGE_TOKEN: "bridge-token" });
  const authorized = await authorizeHttpRequest({
    method: "GET",
    url: "/api/connectors/whatsapp/bridge/accounts",
    headers: { authorization: "Bearer bridge-token" },
    ip: "127.0.0.1",
  }, env);
  assert.equal(authorized.ok, true);
  assert.equal(authorized.machineAuth, "whatsapp_bridge");
  await assert.rejects(
    fs.access(path.join(home, "secrets", "mobile-devices.json")),
    /ENOENT/,
  );
});

test("mobile module exposes UI contract routes and safe owner controls", async (t) => {
  const { env, cleanup } = await setupMobileEnv(t, {}, { autoCleanup: false });
  const ownerChallenge = await createPairingChallenge({
    env,
    request: { headers: { "user-agent": "owner-browser" }, ip: "127.0.0.1" },
    userId: "admin",
    role: "admin",
  });
  await approvePairingChallenge(ownerChallenge.challengeId, { env, approvedBy: "test" });
  const ownerSession = await pairBrowser({
    env,
    challengeId: ownerChallenge.challengeId,
    userAgent: "owner-browser",
    ip: "127.0.0.1",
    allowApproveCode: false,
  });

  const server = await startServer({ port: 0, host: "127.0.0.1", env });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
  });

  const keys = keyPair();
  const start = await fetch(`${baseUrl}/api/mobile/pairings/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKeyJwk: keys.publicJwk, deviceName: "Can Phone" }),
  });
  assert.equal(start.status, 200);
  const started = await start.json();
  assert.equal(started.pairing.status, "pending");
  assertNoPrivateMobileFields(started);

  const unauthProfiles = await fetch(`${baseUrl}/api/mobile/profiles`);
  assert.equal(unauthProfiles.status, 401);

  const cookie = `orkestr_session=${encodeURIComponent(ownerSession.token)}`;
  const ownerProfiles = await fetch(`${baseUrl}/api/mobile/profiles`, { headers: { cookie } });
  assert.equal(ownerProfiles.status, 200);
  assert.deepEqual((await ownerProfiles.json()).profiles, [{ id: "owner-phone", label: "Owner Phone", status: "active" }]);

  const approved = await fetch(`${baseUrl}/api/mobile/profiles/owner-phone/pairings/approve`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ pairingCode: started.pairing.approveCode }),
  });
  assert.equal(approved.status, 200);
  assertNoPrivateMobileFields(await approved.json());

  const polled = await fetch(`${baseUrl}/api/mobile/pairings/${encodeURIComponent(started.pairing.id)}/poll?pollToken=${encodeURIComponent(started.pollToken)}`);
  assert.equal(polled.status, 200);
  const challenge = (await polled.json()).challenge;
  const pairingClaims = timedClaims({
    aud: "orkestr.mobile.pairing",
    pairingId: started.pairing.id,
    challengeId: challenge.id,
    challenge: challenge.nonce,
    publicKeyThumbprint: challenge.publicKeyThumbprint,
    machineContextHash: challenge.machineContextHash,
    jti: "http-pair-proof-1",
  });
  const completed = await fetch(`${baseUrl}/api/mobile/pairings/${encodeURIComponent(started.pairing.id)}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pollToken: started.pollToken,
      challengeId: challenge.id,
      proof: signJwt(keys.privateKey, pairingClaims),
    }),
  });
  assert.equal(completed.status, 200);
  const completedJson = await completed.json();
  assertNoPrivateMobileFields(completedJson);

  const ownerDevices = await fetch(`${baseUrl}/api/mobile/devices`, { headers: { cookie } });
  assert.equal(ownerDevices.status, 200);
  assert.deepEqual((await ownerDevices.json()).devices, [{
    id: completedJson.device.id,
    label: "Can Phone",
    status: "active",
  }]);

  const revoked = await fetch(`${baseUrl}/api/mobile/devices/${encodeURIComponent(completedJson.device.id)}/revoke`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual((await revoked.json()).device, {
    id: completedJson.device.id,
    label: "Can Phone",
    status: "revoked",
  });

  const devices = await listMobileDevices({ env, principal: adminPrincipal({ id: "admin" }) });
  assert.deepEqual(devices.devices, [{
    id: completedJson.device.id,
    label: "Can Phone",
    status: "revoked",
  }]);
});
