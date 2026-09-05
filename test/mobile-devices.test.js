import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import {
  approveMobileDevicePairing,
  authorizeMobileDeviceHttpRequest,
  completeMobileDevicePairing,
  listMobileDevices,
  listMobileProfiles,
  mobileDeviceContextIsActive,
  pollMobileDevicePairing,
  refreshMobileDeviceSession,
  startMobileDevicePairing,
} from "../packages/core/src/mobile-devices.js";
import { sha256 } from "../packages/core/src/mobile-device-crypto.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { setSecureSecret } from "../packages/core/src/secure-secrets.js";
import { approvePairingChallenge, authorizeHttpRequest, createPairingChallenge, pairBrowser } from "../packages/core/src/security.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";

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

async function setupMobileEnv(t, extra = {}, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mobile-devices-"));
  const profilesFile = path.join(home, "mobile-profiles.json");
  if (options.profileSource !== "secure-input") {
    await fs.writeFile(profilesFile, JSON.stringify({
      profiles: [{
        id: "owner-phone",
        label: "Owner Phone",
        ownerUserId: "admin",
        threadId: "hush-owner-thread",
        mirrorRepliesToWhatsApp: true,
      }],
    }));
  }
  const keys = [
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_OVERLAY_DIR",
    "ORKESTR_MOBILE_PROFILES_FILE",
    "ORKESTR_MOBILE_PROFILES_SECRET",
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
    ORKESTR_OVERLAY_DIR: "",
    ORKESTR_MOBILE_PROFILES_FILE: options.profileSource === "secure-input" ? "" : profilesFile,
    ORKESTR_MOBILE_PROFILES_SECRET: "hush-mobile-profiles",
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
  const cleanup = async () => {
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  if (options.autoCleanup !== false) t.after(cleanup);
  return { env: process.env, home, profilesFile, cleanup };
}

test("mobile profiles can come from encrypted secure input", async (t) => {
  const { env } = await setupMobileEnv(t, {}, { profileSource: "secure-input" });
  await setSecureSecret({
    scope: "global",
    name: "hush-mobile-profiles",
    value: JSON.stringify({
      profiles: [{
        id: "owner-phone",
        label: "Owner Phone",
        ownerUserId: "admin",
        threadId: "hush-owner-thread",
        mirrorRepliesToWhatsApp: true,
      }],
    }),
  }, adminPrincipal({ id: "admin" }), env);
  const configured = await listMobileProfiles({ env });
  assert.equal(configured.source, "secure-input");
  assert.deepEqual(configured.profiles, [{
    id: "owner-phone",
    label: "Owner Phone",
    ownerUserId: "admin",
    threadId: "hush-owner-thread",
    enabled: true,
    mirrorRepliesToWhatsApp: true,
  }]);
});

async function pairApprovedDevice(t) {
  const { env } = await setupMobileEnv(t);
  await createThread({ id: "hush-owner-thread", name: "Hush owner", ownerUserId: "admin" }, env);
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
    body: { deviceName: "Can Phone", publicKeyJwk: keys.publicJwk, machineContext },
  });
  await approveMobileDevicePairing(started.pairing.id, {
    env,
    profileId: "owner-phone",
    principal: adminPrincipal({ id: "admin" }),
  });
  const polled = await pollMobileDevicePairing(started.pairing.id, { env, pollToken: started.pollToken });
  const pairingClaims = timedClaims({
    aud: "orkestr.mobile.pairing",
    pairingId: started.pairing.id,
    challengeId: polled.challenge.id,
    challenge: polled.challenge.nonce,
    publicKeyThumbprint: polled.challenge.publicKeyThumbprint,
    machineContextHash: polled.challenge.machineContextHash,
    jti: "pair-proof-1",
  });
  const completed = await completeMobileDevicePairing(started.pairing.id, {
    env,
    pollToken: started.pollToken,
    challengeId: polled.challenge.id,
    proof: signJwt(keys.privateKey, pairingClaims),
  });
  return { env, keys, started, polled, completed };
}

test("mobile device pairing requires owner approval and one-time ES256 proof", async (t) => {
  const { env, keys, started } = await pairApprovedDevice(t);
  const profiles = await listMobileProfiles({ env });
  assert.deepEqual(profiles.profiles.map((profile) => profile.id), ["owner-phone"]);
  assert.equal(JSON.stringify(started).includes("\"d\""), false);
  assert.equal(JSON.stringify(started).includes("owner-phone"), false);
  assert.equal(JSON.stringify(started).includes("hush-owner-thread"), false);
  assert.equal(started.pairing.status, "pending");
  assert.match(started.pairing.approveCode, /^[A-Z0-9]+$/);

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

test("mobile access uses exact Hush context, rejects replay, and cannot authorize other APIs", async (t) => {
  const { env, keys, completed } = await pairApprovedDevice(t);
  const requestClaims = timedClaims({
    aud: "orkestr.mobile.request",
    sid: completed.session.id,
    did: completed.device.id,
    ath: sha256(completed.accessToken),
    method: "GET",
    path: "/api/mobile/voice-turns/turn-1",
    bodySha256: sha256(""),
    jti: "request-proof-1",
  });
  const request = {
    method: "GET",
    url: "/api/mobile/voice-turns/turn-1",
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "x-orkestr-device-proof": signJwt(keys.privateKey, requestClaims),
    },
  };
  const tokenOnly = await authorizeHttpRequest({ ...request, headers: { authorization: `Bearer ${completed.accessToken}` } }, env);
  assert.equal(tokenOnly.ok, false);
  assert.equal(tokenOnly.statusCode, 401);
  const malformed = await authorizeHttpRequest({
    ...request,
    headers: { ...request.headers, "x-orkestr-device-proof": "malformed-proof" },
  }, env);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.statusCode, 401);
  const authorized = await authorizeHttpRequest(request, env);
  assert.equal(authorized.ok, true);
  assert.equal(authorized.machineAuth, "mobile_device");
  assert.deepEqual(authorized.machineAuthContext, {
    principalKind: "mobile_device",
    routeKind: "hush_mobile",
    deviceId: completed.device.id,
    sessionId: completed.session.id,
    profileId: "owner-phone",
    threadId: "hush-owner-thread",
    ownerUserId: "admin",
    mirrorRepliesToWhatsApp: true,
  });
  assert.equal(await mobileDeviceContextIsActive(authorized.machineAuthContext, env), true);
  const replay = await authorizeMobileDeviceHttpRequest(request, env);
  assert.equal(replay.ok, false);
  assert.equal(replay.error, "mobile_device_proof_replayed");

  const realtimeTurnBody = JSON.stringify({
    clientTurnId: "45454545-4545-4454-8454-454545454545",
    text: "Route this through the authoritative call bridge.",
    locale: "en-US",
  });
  const realtimeTurnPath = "/api/mobile/realtime/calls/mrc_fixture/turns";
  const realtimeTurnAuthorized = await authorizeMobileDeviceHttpRequest({
    method: "POST",
    url: realtimeTurnPath,
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "x-orkestr-content-sha256": sha256(realtimeTurnBody),
      "x-orkestr-device-proof": signJwt(keys.privateKey, timedClaims({
        aud: "orkestr.mobile.request",
        sid: completed.session.id,
        did: completed.device.id,
        ath: sha256(completed.accessToken),
        method: "POST",
        path: realtimeTurnPath,
        bodySha256: sha256(realtimeTurnBody),
        jti: "request-proof-realtime-turn",
      })),
    },
  }, env);
  assert.equal(realtimeTurnAuthorized.ok, true);
  assert.equal(realtimeTurnAuthorized.machineAuthContext.threadId, "hush-owner-thread");

  const forbidden = await authorizeMobileDeviceHttpRequest({
    ...request,
    url: "/api/threads",
    headers: {
      ...request.headers,
      "x-orkestr-device-proof": signJwt(keys.privateKey, timedClaims({
        ...requestClaims,
        path: "/api/threads",
        jti: "request-proof-out-of-scope",
      })),
    },
  }, env);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.error, "mobile_device_route_forbidden");
});

test("mobile refresh rotates refresh and access tokens", async (t) => {
  const { env, keys, completed } = await pairApprovedDevice(t);
  const refreshBody = { refreshToken: completed.refreshToken };
  const refreshRequest = {
    method: "POST",
    url: "/api/mobile/session/refresh",
    headers: { "x-orkestr-content-sha256": sha256(JSON.stringify(refreshBody)) },
  };
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
    method: "GET",
    url: "/api/mobile/voice-turns/old-turn",
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "x-orkestr-device-proof": signJwt(keys.privateKey, timedClaims({
        aud: "orkestr.mobile.request",
        sid: completed.session.id,
        did: completed.device.id,
        ath: sha256(completed.accessToken),
        method: "GET",
        path: "/api/mobile/voice-turns/old-turn",
        bodySha256: sha256(""),
        jti: "old-access",
      })),
    },
  }, env), null);
});

test("expired mobile access is denied before controller authentication", async (t) => {
  const { env, keys, completed } = await pairApprovedDevice(t);
  const statePath = path.join(env.ORKESTR_HOME, "secrets", "mobile-devices.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.sessions[0].accessExpiresAt = "2000-01-01T00:00:00.000Z";
  await fs.writeFile(statePath, `${JSON.stringify(state)}\n`);
  const request = {
    method: "GET",
    url: "/api/mobile/voice-turns/expired-turn",
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "x-orkestr-device-proof": signJwt(keys.privateKey, timedClaims({
        aud: "orkestr.mobile.request",
        sid: completed.session.id,
        did: completed.device.id,
        ath: sha256(completed.accessToken),
        method: "GET",
        path: "/api/mobile/voice-turns/expired-turn",
        bodySha256: sha256(""),
        jti: "expired-access-proof",
      })),
    },
  };
  const denied = await authorizeHttpRequest(request, env);
  assert.equal(denied.ok, false);
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.error, "mobile_access_expired");
});

test("mobile public pairing start is client rate limited", async (t) => {
  const { env } = await setupMobileEnv(t, { ORKESTR_MOBILE_PAIRING_CLIENT_CREATE_LIMIT: "1" });
  const keys = keyPair();
  const request = { headers: { "user-agent": "same-device" }, ip: "198.51.100.10" };
  await startMobileDevicePairing({ env, request, body: { deviceName: "Rate limit phone", publicKeyJwk: keys.publicJwk } });
  await assert.rejects(
    startMobileDevicePairing({ env, request, body: { deviceName: "Rate limit phone", publicKeyJwk: keys.publicJwk } }),
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

test("mobile module exposes bounded public routes and owner controls", async (t) => {
  const { env, cleanup } = await setupMobileEnv(t, {}, { autoCleanup: false });
  await createThread({ id: "hush-owner-thread", name: "Hush owner", ownerUserId: "admin" }, env);
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
  const start = await fetch(`${baseUrl}/api/mobile/pairing/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceName: "HTTP phone", publicKeyJwk: keys.publicJwk }),
  });
  assert.equal(start.status, 200);
  const started = await start.json();
  assert.equal(started.pairing.status, "pending");
  assert.equal(JSON.stringify(started).includes("owner-phone"), false);
  assert.equal(JSON.stringify(started).includes("hush-owner-thread"), false);

  const unauthProfiles = await fetch(`${baseUrl}/api/mobile/profiles`);
  assert.equal(unauthProfiles.status, 401);

  const ownerProfiles = await fetch(`${baseUrl}/api/mobile/profiles`, {
    headers: { cookie: `orkestr_session=${encodeURIComponent(ownerSession.token)}` },
  });
  assert.equal(ownerProfiles.status, 200);
  const ownerProfilesBody = await ownerProfiles.json();
  assert.deepEqual(ownerProfilesBody.profiles.map((profile) => profile.id), ["owner-phone"]);
  assert.equal(JSON.stringify(ownerProfilesBody).includes("hush-owner-thread"), false);
  assert.equal(JSON.stringify(ownerProfilesBody).includes("ownerUserId"), false);
  assert.equal(JSON.stringify(ownerProfilesBody).includes("mirrorRepliesToWhatsApp"), false);

  const approvedResponse = await fetch(`${baseUrl}/api/mobile/profiles/owner-phone/pairings/approve`, {
    method: "POST",
    headers: {
      cookie: `orkestr_session=${encodeURIComponent(ownerSession.token)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ pairingCode: started.pairing.approveCode }),
  });
  assert.equal(approvedResponse.status, 200);
  assert.equal((await approvedResponse.json()).pairing.status, "approved");

  const pollUrl = `${baseUrl}/api/mobile/pairing/${encodeURIComponent(started.pairing.id)}/poll?pollToken=${encodeURIComponent(started.pollToken)}`;
  const polled = await (await fetch(pollUrl)).json();
  const repeatedPoll = await (await fetch(pollUrl)).json();
  assert.equal(repeatedPoll.challenge.id, polled.challenge.id);
  assert.equal(repeatedPoll.challenge.nonce, polled.challenge.nonce);
  assert.equal(JSON.stringify(polled).includes("owner-phone"), false);
  assert.equal(JSON.stringify(polled).includes("hush-owner-thread"), false);

  const completedResponse = await fetch(`${baseUrl}/api/mobile/pairing/${encodeURIComponent(started.pairing.id)}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pollToken: started.pollToken,
      challengeId: polled.challenge.id,
      proof: signJwt(keys.privateKey, timedClaims({
        aud: "orkestr.mobile.pairing",
        pairingId: started.pairing.id,
        challengeId: polled.challenge.id,
        challenge: polled.challenge.nonce,
        publicKeyThumbprint: polled.challenge.publicKeyThumbprint,
        machineContextHash: polled.challenge.machineContextHash,
        jti: "http-pair-proof",
      })),
    }),
  });
  assert.equal(completedResponse.status, 200);
  const completed = await completedResponse.json();
  assert.equal(completed.device.status, "paired");
  assert.equal(JSON.stringify(completed).includes("hush-owner-thread"), false);
  const deviceContext = {
    deviceId: completed.device.id,
    profileId: "owner-phone",
    threadId: "hush-owner-thread",
    ownerUserId: "admin",
  };
  assert.equal(await mobileDeviceContextIsActive(deviceContext, env), true);

  const realtimeCapabilityResponse = await fetch(`${baseUrl}/api/mobile/realtime`, {
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "x-orkestr-content-sha256": sha256(""),
      "x-orkestr-device-proof": signJwt(keys.privateKey, timedClaims({
        aud: "orkestr.mobile.request",
        sid: completed.session.id,
        did: completed.device.id,
        ath: sha256(completed.accessToken),
        method: "GET",
        path: "/api/mobile/realtime",
        bodySha256: sha256(""),
        jti: "http-realtime-capability-proof",
      })),
    },
  });
  assert.equal(realtimeCapabilityResponse.status, 200);
  assert.deepEqual(await realtimeCapabilityResponse.json(), { enabled: false, reason: "disabled" });

  const pushBody = JSON.stringify({ token: "a".repeat(64), environment: "sandbox", operation: "upsert" });
  const pushResponse = await fetch(`${baseUrl}/api/mobile/push-token`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "content-type": "application/json",
      "x-orkestr-content-sha256": sha256(pushBody),
      "x-orkestr-device-proof": signJwt(keys.privateKey, timedClaims({
        aud: "orkestr.mobile.request",
        sid: completed.session.id,
        did: completed.device.id,
        ath: sha256(completed.accessToken),
        method: "PUT",
        path: "/api/mobile/push-token",
        bodySha256: sha256(pushBody),
        jti: "http-push-token-proof",
      })),
    },
    body: pushBody,
  });
  assert.equal(pushResponse.status, 200);

  const turnBody = JSON.stringify({
    clientTurnId: "77777777-7777-4777-8777-777777777777",
    transcript: "Give me the current status",
    locale: "en-US",
  });
  const turnProof = signJwt(keys.privateKey, timedClaims({
    aud: "orkestr.mobile.request",
    sid: completed.session.id,
    did: completed.device.id,
    ath: sha256(completed.accessToken),
    method: "POST",
    path: "/api/mobile/voice-turns",
    bodySha256: sha256(turnBody),
    jti: "http-turn-proof",
  }));
  const turnResponse = await fetch(`${baseUrl}/api/mobile/voice-turns`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "content-type": "application/json",
      "x-orkestr-content-sha256": sha256(turnBody),
      "x-orkestr-device-proof": turnProof,
    },
    body: turnBody,
  });
  assert.equal(turnResponse.status, 202);
  assert.equal((await turnResponse.json()).status, "queued");

  const tamperedBody = JSON.stringify({
    clientTurnId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    transcript: "Tampered after proof creation",
    locale: "en-US",
  });
  const beforeTampered = (await listThreadMessages("hush-owner-thread", env)).length;
  const tamperedResponse = await fetch(`${baseUrl}/api/mobile/voice-turns`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "content-type": "application/json",
      "x-orkestr-content-sha256": sha256(turnBody),
      "x-orkestr-device-proof": signJwt(keys.privateKey, timedClaims({
        aud: "orkestr.mobile.request",
        sid: completed.session.id,
        did: completed.device.id,
        ath: sha256(completed.accessToken),
        method: "POST",
        path: "/api/mobile/voice-turns",
        bodySha256: sha256(turnBody),
        jti: "http-tampered-body-proof",
      })),
    },
    body: tamperedBody,
  });
  assert.equal(tamperedResponse.status, 401);
  assert.equal((await listThreadMessages("hush-owner-thread", env)).length, beforeTampered);

  const tokenOnly = await fetch(`${baseUrl}/api/mobile/voice-turns`, {
    method: "POST",
    headers: { authorization: `Bearer ${completed.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      clientTurnId: "88888888-8888-4888-8888-888888888888",
      transcript: "This must not dispatch",
      locale: "en-US",
    }),
  });
  assert.equal(tokenOnly.status, 401);

  const devicesResponse = await fetch(`${baseUrl}/api/mobile/devices`, {
    headers: { cookie: `orkestr_session=${encodeURIComponent(ownerSession.token)}` },
  });
  const devices = await devicesResponse.json();
  assert.equal(devices.devices.length, 1);
  assert.equal(devices.devices[0].status, "paired");
  assert.equal(JSON.stringify(devices).includes("hush-owner-thread"), false);

  const revoked = await fetch(`${baseUrl}/api/mobile/devices/${encodeURIComponent(completed.device.id)}/revoke`, {
    method: "POST",
    headers: { cookie: `orkestr_session=${encodeURIComponent(ownerSession.token)}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(revoked.status, 200);
  assert.equal(await mobileDeviceContextIsActive(deviceContext, env), false);
  const pushPath = path.join(env.ORKESTR_HOME, "secrets", "mobile-push-tokens.json");
  let pushState = JSON.parse(await fs.readFile(pushPath, "utf8"));
  for (let attempt = 0; attempt < 50 && pushState.pushTokens.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    pushState = JSON.parse(await fs.readFile(pushPath, "utf8"));
  }
  assert.deepEqual(pushState.pushTokens, []);

  const beforeRevokedRetry = (await listThreadMessages("hush-owner-thread", env)).length;
  const revokedBody = JSON.stringify({
    clientTurnId: "99999999-9999-4999-8999-999999999999",
    transcript: "This revoked device must not dispatch",
    locale: "en-US",
  });
  const revokedRetry = await fetch(`${baseUrl}/api/mobile/voice-turns`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "content-type": "application/json",
      "x-orkestr-content-sha256": sha256(revokedBody),
      "x-orkestr-device-proof": signJwt(keys.privateKey, timedClaims({
        aud: "orkestr.mobile.request",
        sid: completed.session.id,
        did: completed.device.id,
        ath: sha256(completed.accessToken),
        method: "POST",
        path: "/api/mobile/voice-turns",
        bodySha256: sha256(revokedBody),
        jti: "http-revoked-proof",
      })),
    },
    body: revokedBody,
  });
  assert.equal(revokedRetry.status, 401);
  assert.equal((await listThreadMessages("hush-owner-thread", env)).length, beforeRevokedRetry);

  let limitedResponse;
  for (let index = 0; index < 5; index += 1) {
    limitedResponse = await fetch(`${baseUrl}/api/mobile/pairing/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceName: `Rate phone ${index}`, publicKeyJwk: keys.publicJwk }),
    });
    if (limitedResponse.status === 429) break;
  }
  assert.equal(limitedResponse.status, 429);
  assert.ok(Number(limitedResponse.headers.get("retry-after")) > 0);
});
