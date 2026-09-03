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
  pollMobileDevicePairing,
  refreshMobileDeviceSession,
  startMobileDevicePairing,
} from "../packages/core/src/mobile-devices.js";
import { sha256 } from "../packages/core/src/mobile-device-crypto.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { approvePairingChallenge, authorizeHttpRequest, createPairingChallenge, pairBrowser } from "../packages/core/src/security.js";

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
  await fs.writeFile(profilesFile, JSON.stringify({
    profiles: [{
      id: "owner-phone",
      label: "Owner Phone",
      userId: "admin",
      role: "admin",
      scopes: ["threads:read", "threads:write", "desktops:open"],
    }],
  }));
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
    body: { profileId: "owner-phone", publicKeyJwk: keys.publicJwk, machineContext },
  });
  await approveMobileDevicePairing(started.pairing.id, {
    env,
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

test("mobile access uses per-request device proof and rejects replay", async (t) => {
  const { env, keys, completed } = await pairApprovedDevice(t);
  const requestClaims = timedClaims({
    aud: "orkestr.mobile.request",
    sid: completed.session.id,
    did: completed.device.id,
    ath: sha256(completed.accessToken),
    method: "GET",
    path: "/api/threads?scope=all",
    bodySha256: sha256(""),
    jti: "request-proof-1",
  });
  const request = {
    method: "GET",
    url: "/api/threads?scope=all",
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "x-orkestr-device-proof": signJwt(keys.privateKey, requestClaims),
    },
  };
  const authorized = await authorizeHttpRequest(request, env);
  assert.equal(authorized.ok, true);
  assert.equal(authorized.machineAuth, "mobile_device");
  assert.deepEqual(authorized.machineAuthContext, {
    tokenId: completed.session.accessTokenId,
    routeKind: "mobile_device",
    scopes: ["threads:read", "threads:write", "desktops:open"],
    principalKind: "mobile_device",
    principalId: completed.device.id,
    ownerUserId: "admin",
    userId: "admin",
    deviceId: completed.device.id,
    sessionId: completed.session.id,
    profileId: "owner-phone",
    proofJti: "request-proof-1",
    proofIat: requestClaims.iat,
  });
  const replay = await authorizeMobileDeviceHttpRequest(request, env);
  assert.equal(replay.ok, false);
  assert.equal(replay.error, "mobile_device_proof_replayed");
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
    url: "/api/threads",
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "x-orkestr-device-proof": signJwt(keys.privateKey, timedClaims({
        aud: "orkestr.mobile.request",
        sid: completed.session.id,
        did: completed.device.id,
        ath: sha256(completed.accessToken),
        method: "GET",
        path: "/api/threads",
        bodySha256: sha256(""),
        jti: "old-access",
      })),
    },
  }, env), null);
});

test("mobile public pairing start is client rate limited", async (t) => {
  const { env } = await setupMobileEnv(t, { ORKESTR_MOBILE_PAIRING_CLIENT_CREATE_LIMIT: "1" });
  const keys = keyPair();
  const request = { headers: { "user-agent": "same-device" }, ip: "198.51.100.10" };
  await startMobileDevicePairing({ env, request, body: { profileId: "owner-phone", publicKeyJwk: keys.publicJwk } });
  await assert.rejects(
    startMobileDevicePairing({ env, request, body: { profileId: "owner-phone", publicKeyJwk: keys.publicJwk } }),
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
    body: JSON.stringify({ profileId: "owner-phone", publicKeyJwk: keys.publicJwk }),
  });
  assert.equal(start.status, 200);
  assert.equal((await start.json()).pairing.status, "pending");

  const unauthProfiles = await fetch(`${baseUrl}/api/mobile/owner/profiles`);
  assert.equal(unauthProfiles.status, 401);

  const ownerProfiles = await fetch(`${baseUrl}/api/mobile/owner/profiles`, {
    headers: { cookie: `orkestr_session=${encodeURIComponent(ownerSession.token)}` },
  });
  assert.equal(ownerProfiles.status, 200);
  assert.deepEqual((await ownerProfiles.json()).profiles.map((profile) => profile.id), ["owner-phone"]);

  const devices = await listMobileDevices({ env });
  assert.deepEqual(devices.devices, []);
});
