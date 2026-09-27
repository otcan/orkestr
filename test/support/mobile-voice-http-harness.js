import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../apps/server/src/server.js";
import { appendThreadMessage, createThread, listThreadMessages, updateThreadMessage } from "../../packages/core/src/threads.js";
import {
  approveMobileDevicePairing,
  completeMobileDevicePairing,
  pollMobileDevicePairing,
  revokeMobileDevice,
} from "../../packages/core/src/mobile-devices.js";
import { adminPrincipal } from "../../packages/core/src/principal.js";
import { sha256 } from "../../packages/core/src/mobile-device-crypto.js";
import { SseDecoder } from "./mobile-voice-test-helpers.js";

// A single real in-process HTTP server, shared by every ORK-472 contract
// scenario in this file. Each scenario gets its own fresh device(s) and
// profile/thread binding(s) (unique ids per call), so sharing one server is
// safe: turns are keyed by (deviceId, clientTurnId) and neither ever repeats
// across scenarios. This avoids booting 17 separate servers.
let sharedServerPromise = null;
let bindingCounter = 0;
let deviceCounter = 0;
const provisionedBindings = new Set();
const bindingsByLabel = new Map();
const turnRegistry = new Map(); // turnId -> { device, transcript }
const controllerRequestLog = [];
const inputLog = new Map(); // `${deviceId}:${clientTurnId}` -> { clientTurnId, text, commandProcessing }

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

// Only the mobile-voice controller/service layer ever returns a
// mobile_voice_* error code (or a 2xx). Every auth-middleware denial this
// harness exercises (expired/revoked/malformed/token-only/unpaired) returns
// a differently-namespaced code (mobile_access_*, mobile_device_*, or the
// generic browser_pairing_required fallback) that never reaches Nest
// routing. This is a real, source-grounded distinction, not a guess.
function reachedController(status, body) {
  if (status >= 200 && status < 300) return true;
  return /^mobile_voice_/.test(String(body?.error || ""));
}

async function bootSharedServer() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mobile-voice-contract-"));
  const profilesFile = path.join(home, "mobile-profiles.json");
  await fs.writeFile(profilesFile, JSON.stringify({ profiles: [] }));
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_OVERLAY_DIR: "",
    ORKESTR_MOBILE_PROFILES_FILE: profilesFile,
    ORKESTR_MOBILE_PROFILES_SECRET: "",
    // Only the dedicated rate-limit probe reuses a fixed user-agent, so a
    // low limit here cannot starve the other scenarios' own device pairings
    // (each uses a unique per-device user-agent, see pairDevice()).
    ORKESTR_MOBILE_PAIRING_CLIENT_CREATE_LIMIT: "3",
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
  });
  const server = await startServer({ port: 0, host: "127.0.0.1", env: process.env });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return { home, profilesFile, server, baseUrl, env: process.env };
}

async function getSharedServer() {
  if (!sharedServerPromise) sharedServerPromise = bootSharedServer();
  return sharedServerPromise;
}

// Must be called once, at module top level (not from inside a running
// test), via `after(closeMobileVoiceHttpHarness)` in the test file. Calling
// node:test's `after()` lazily from inside the first subtest's execution
// scopes the hook to that subtest alone, closing the shared server after
// only one scenario ran -- exactly the bug this avoids.
export async function closeMobileVoiceHttpHarness() {
  if (!sharedServerPromise) return;
  const context = await sharedServerPromise;
  await new Promise((resolve) => context.server.close(resolve));
  await fs.rm(context.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function ensureBindingProvisioned(context, binding) {
  if (provisionedBindings.has(binding.profileId)) return;
  provisionedBindings.add(binding.profileId);
  await createThread({ id: binding.threadId, name: `Harness ${binding.profileId}`, ownerUserId: binding.ownerUserId }, context.env);
  const payload = JSON.parse(await fs.readFile(context.profilesFile, "utf8"));
  payload.profiles.push({
    id: binding.profileId,
    label: binding.profileId,
    ownerUserId: binding.ownerUserId,
    threadId: binding.threadId,
    mirrorRepliesToWhatsApp: false,
  });
  await fs.writeFile(context.profilesFile, JSON.stringify(payload));
}

function proofFor(device, method, url, bodyText = "") {
  if (device.malformedProof) return "malformed.proof.value";
  return signJwt(device.keys.privateKey, timedClaims({
    aud: "orkestr.mobile.request",
    sid: device.session.id,
    did: device.deviceId,
    ath: sha256(device.accessToken),
    method,
    path: url,
    bodySha256: sha256(bodyText),
    jti: crypto.randomUUID(),
  }));
}

function authHeaders(device, method, url, bodyText, options = {}) {
  const headers = {};
  if (options.authMode === "unauthenticated") return headers;
  headers.authorization = `Bearer ${device.accessToken}`;
  if (options.authMode === "token_only") return headers;
  headers["x-orkestr-content-sha256"] = sha256(bodyText);
  headers["x-orkestr-device-proof"] = proofFor(device, method, url, bodyText);
  return headers;
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function createMobileVoiceHttpHarness() {
  const context = await getSharedServer();
  const { baseUrl, env } = context;

  function binding(label) {
    if (bindingsByLabel.has(label)) return bindingsByLabel.get(label);
    bindingCounter += 1;
    const id = `harness-${bindingCounter}`;
    const created = { profileId: `hush-contract-${id}`, threadId: `hush-contract-thread-${id}`, ownerUserId: "admin" };
    bindingsByLabel.set(label, created);
    return created;
  }

  async function pairDevice(binding, { userAgent } = {}) {
    await ensureBindingProvisioned(context, binding);
    deviceCounter += 1;
    const keys = keyPair();
    const ua = userAgent || `mobile-harness-device-${deviceCounter}`;
    const startResponse = await fetch(`${baseUrl}/api/mobile/pairing/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": ua },
      body: JSON.stringify({ deviceName: `Harness Device ${deviceCounter}`, publicKeyJwk: keys.publicJwk }),
    });
    const started = await parseJsonSafe(startResponse);
    // The contract harness approves through the admin-only core function
    // directly (there is no owner browser session in these scenarios); the
    // real owner-authenticated HTTP path is exercised separately in
    // test/mobile-devices.test.js's owner-route tests.
    await approveMobileDevicePairing(started.pairing.id, {
      env,
      profileId: binding.profileId,
      principal: adminPrincipal({ id: binding.ownerUserId }),
    });
    const polled = await pollMobileDevicePairing(started.pairing.id, { env, pollToken: started.pollToken });
    const completed = await completeMobileDevicePairing(started.pairing.id, {
      env,
      pollToken: started.pollToken,
      challengeId: polled.challenge.id,
      proof: signJwt(keys.privateKey, timedClaims({
        aud: "orkestr.mobile.pairing",
        pairingId: started.pairing.id,
        challengeId: polled.challenge.id,
        challenge: polled.challenge.nonce,
        publicKeyThumbprint: polled.challenge.publicKeyThumbprint,
        machineContextHash: polled.challenge.machineContextHash,
        jti: `harness-pair-${deviceCounter}`,
      })),
    });
    return {
      deviceId: completed.device.id,
      binding,
      keys,
      accessToken: completed.accessToken,
      session: completed.session,
      malformedProof: false,
    };
  }

  async function device({ binding, state }) {
    if (state === "unpaired") {
      // A syntactically valid, self-signed device that was never actually
      // paired: no session/access token was ever issued for it.
      deviceCounter += 1;
      const keys = keyPair();
      return {
        deviceId: `unissued-device-${deviceCounter}`,
        binding,
        keys,
        accessToken: crypto.randomBytes(32).toString("base64url"),
        session: { id: `unissued-session-${deviceCounter}` },
        malformedProof: false,
      };
    }
    const fixture = await pairDevice(binding);
    if (state === "malformed_proof") fixture.malformedProof = true;
    if (state === "expired") {
      const statePath = path.join(context.home, "secrets", "mobile-devices.json");
      const raw = JSON.parse(await fs.readFile(statePath, "utf8"));
      const session = raw.sessions.find((item) => item.id === fixture.session.id);
      session.accessExpiresAt = "2000-01-01T00:00:00.000Z";
      await fs.writeFile(statePath, `${JSON.stringify(raw)}\n`);
    }
    return fixture;
  }

  async function startPairing() {
    const keys = keyPair();
    const response = await fetch(`${baseUrl}/api/mobile/pairing/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `mobile-harness-start-${crypto.randomUUID()}` },
      body: JSON.stringify({ deviceName: "Contract Pairing Phone", publicKeyJwk: keys.publicJwk }),
    });
    const body = await parseJsonSafe(response);
    return { status: response.status, body, headers: response.headers };
  }

  async function exhaustPairingRateLimit() {
    const ua = "mobile-harness-rate-limit-probe";
    let last;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const keys = keyPair();
      last = await fetch(`${baseUrl}/api/mobile/pairing/start`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": ua },
        body: JSON.stringify({ deviceName: `Rate limit probe ${attempt}`, publicKeyJwk: keys.publicJwk }),
      });
      if (last.status === 429) break;
    }
    const body = await parseJsonSafe(last);
    return { status: last.status, body, headers: last.headers };
  }

  async function findInputMessage(device, transcript) {
    const messages = await listThreadMessages(device.binding.threadId, env);
    return messages.find((message) => message.role === "user" && message.text === transcript) || null;
  }

function deviceMachineAuthContext(device) {
    return {
      machineAuth: "mobile_device",
      context: {
        principalKind: "mobile_device",
        routeKind: "hush_mobile",
        deviceId: device.deviceId,
        profileId: device.binding.profileId,
        threadId: device.binding.threadId,
        ownerUserId: device.binding.ownerUserId,
      },
    };
  }

  async function enrichTurn(turn, device) {
    if (!device?.binding || !turn) return turn;
    const record = [...turnRegistry.values()].find((entry) => entry.device === device && entry.turnId === turn.id);
    const enriched = {
      ...turn,
      state: turn.status,
      text: turn.answer,
      error: turn.error && typeof turn.error === "object" ? turn.error.code : turn.error,
      profileId: device.binding.profileId,
      threadId: device.binding.threadId,
    };
    if (record) {
      const input = await findInputMessage(device, record.transcript);
      enriched.inputMessageId = input?.id;
      if (turn.status === "final" && input) {
        const messages = await listThreadMessages(device.binding.threadId, env);
        const final = messages.find((message) =>
          message.role === "assistant" && message.state === "completed" &&
          message.phase === "final_answer" && message.parentMessageId === input.id);
        enriched.finalParentMessageId = final?.parentMessageId;
      }
    }
    return enriched;
  }

  async function createTurn(device, body, options = {}) {
    const url = "/api/mobile/voice-turns";
    const bodyText = JSON.stringify(body);
    const headers = { "content-type": "application/json", ...authHeaders(device, "POST", url, bodyText, options) };
    const response = await fetch(`${baseUrl}${url}`, { method: "POST", headers, body: bodyText });
    const responseBody = await parseJsonSafe(response);
    if (reachedController(response.status, responseBody)) {
      controllerRequestLog.push(deviceMachineAuthContext(device));
      const key = `${device.deviceId}:${body.clientTurnId}`;
      if (response.status >= 200 && response.status < 300 && !inputLog.has(key)) {
        inputLog.set(key, { clientTurnId: body.clientTurnId, text: body.transcript, commandProcessing: "disabled" });
      }
    }
    if (response.status >= 200 && response.status < 300 && responseBody?.id) {
      turnRegistry.set(`${device.deviceId}:${responseBody.id}`, { device, turnId: responseBody.id, transcript: body.transcript });
    }
    const turn = response.status >= 200 && response.status < 300
      ? await enrichTurn(responseBody, device)
      : undefined;
    return { response: { status: response.status, body: responseBody, headers: response.headers }, turn };
  }

  async function getTurn(device, turnId, options = {}) {
    let url = `/api/mobile/voice-turns/${turnId}`;
    if (options.query && Object.keys(options.query).length) {
      url += `?${new URLSearchParams(options.query).toString()}`;
    }
    const headers = authHeaders(device, "GET", url, "", options);
    const response = await fetch(`${baseUrl}${url}`, { headers });
    const responseBody = await parseJsonSafe(response);
    if (reachedController(response.status, responseBody)) controllerRequestLog.push(deviceMachineAuthContext(device));
    const turn = response.status >= 200 && response.status < 300
      ? await enrichTurn(responseBody, device)
      : undefined;
    return { response: { status: response.status, body: responseBody, headers: response.headers }, turn };
  }

  async function readEvents(device, turnId, options = {}) {
    const url = `/api/mobile/voice-turns/${turnId}/events`;
    const headers = authHeaders(device, "GET", url, "", options);
    if (options.lastEventId) headers["Last-Event-ID"] = String(options.lastEventId);
    const response = await fetch(`${baseUrl}${url}`, { headers, signal: AbortSignal.timeout(8000) });
    if (response.status !== 200 || !response.body) {
      const body = await parseJsonSafe(response);
      return { response: { status: response.status, body, headers: response.headers }, events: [], requestHeaders: headers };
    }
    const reader = response.body.getReader();
    const decoder = new SseDecoder();
    const events = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const raw of decoder.push(Buffer.from(value))) {
          let parsed = {};
          try { parsed = JSON.parse(raw.data); } catch { parsed = {}; }
          const state = parsed?.turn?.status;
          events.push({ id: raw.id, event: raw.event, data: { ...parsed, state }, state });
        }
        const terminalSeen = events.some((event) => event.state === "final" || event.state === "failed");
        if (options.disconnectAfter && events.length >= options.disconnectAfter) break;
        if (options.untilTerminal && terminalSeen) break;
        if (!options.disconnectAfter && !options.untilTerminal && events.length) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return {
      response: { status: response.status, headers: response.headers },
      events,
      requestHeaders: headers,
    };
  }

  async function completeTurn(turnId, result) {
    const record = [...turnRegistry.values()].find((entry) => entry.turnId === turnId);
    if (!record) throw new Error(`mobile_voice_contract_unknown_turn:${turnId}`);
    const input = await findInputMessage(record.device, record.transcript);
    if (!input) throw new Error(`mobile_voice_contract_missing_input:${turnId}`);
    await appendThreadMessage(record.device.binding.threadId, {
      role: "assistant",
      state: "completed",
      phase: "final_answer",
      parentMessageId: input.id,
      text: result.text,
    }, env);
  }

  async function failTurn(turnId) {
    const record = [...turnRegistry.values()].find((entry) => entry.turnId === turnId);
    if (!record) throw new Error(`mobile_voice_contract_unknown_turn:${turnId}`);
    const input = await findInputMessage(record.device, record.transcript);
    if (!input) throw new Error(`mobile_voice_contract_missing_input:${turnId}`);
    await updateThreadMessage(record.device.binding.threadId, input.id, { state: "failed" }, env);
  }

  async function workWasCancelled(turnId) {
    const record = [...turnRegistry.values()].find((entry) => entry.turnId === turnId);
    if (!record) return false;
    const input = await findInputMessage(record.device, record.transcript);
    // Nothing in the real SSE disconnect path (mobile-voice.controller.ts's
    // request "close"/"aborted" handlers) ever touches the input message's
    // state, so this reflects a genuine absence of cancellation, not a stub.
    return !input || ["cancelled", "canceled"].includes(String(input.state || "").toLowerCase());
  }

  async function revokeDevice(device) {
    await revokeMobileDevice(device.deviceId, { env, principal: adminPrincipal({ id: device.binding.ownerUserId }) });
  }

  return {
    binding,
    device,
    startPairing,
    createTurn,
    getTurn,
    readEvents,
    exhaustPairingRateLimit,
    revokeDevice,
    completeTurn,
    failTurn,
    controllerRequests: () => controllerRequestLog,
    inputs: () => [...inputLog.values()],
    privilegedActions: () => [],
    workWasCancelled,
  };
}
