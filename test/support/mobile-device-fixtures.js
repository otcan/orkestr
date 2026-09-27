import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  approveMobileDevicePairing,
  completeMobileDevicePairing,
  pollMobileDevicePairing,
  startMobileDevicePairing,
} from "../../packages/core/src/mobile-devices.js";
import { adminPrincipal } from "../../packages/core/src/principal.js";
import { createThread } from "../../packages/core/src/threads.js";

// Shared real-pairing/real-env fixtures for the mobile device auth and Hush
// voice-turn test suites (test/mobile-devices.test.js,
// test/mobile-voice-live-hardening.test.js). Keeping these in one place
// avoids duplicating the ES256 pairing flow across files.

function saveEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export function keyPair() {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { ...pair, publicJwk: pair.publicKey.export({ format: "jwk" }) };
}

export function signJwt(privateKey, claims) {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.sign(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key: privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export function timedClaims(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iat: now, exp: now + 120, ...extra };
}

export async function setupMobileEnv(t, extra = {}, options = {}) {
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

export async function pairApprovedDevice(t) {
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
