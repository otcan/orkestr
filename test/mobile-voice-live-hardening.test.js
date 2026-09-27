import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import {
  approveMobileDevicePairing,
  completeMobileDevicePairing,
  pollMobileDevicePairing,
  startMobileDevicePairing,
} from "../packages/core/src/mobile-devices.js";
import { sha256 } from "../packages/core/src/mobile-device-crypto.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { appendThreadMessage, createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { createHushVoiceTurn } from "../packages/core/src/hush-voice.js";
import {
  keyPair,
  pairApprovedDevice,
  setupMobileEnv,
  signJwt,
  timedClaims,
} from "./support/mobile-device-fixtures.js";
import { SseDecoder } from "./support/mobile-voice-test-helpers.js";

// Focused, real-HTTP ORK-472 test-gap fill-ins identified by a completion
// audit against the contract in test/support/mobile-voice-contract.js:
// true request concurrency, a device credential's owner-route boundary, an
// unpaired (never-issued) token distinct from expired/revoked, a genuinely
// single-use pairing challenge nonce, and a disconnect that provably
// happens while dispatch is still in flight (not after it already
// finished). Each test here exercises real production code paths; none of
// it stubs out the behavior under test.

async function startFixtureServer(t, env) {
  const server = await startServer({ port: 0, host: "127.0.0.1", env });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  return baseUrl;
}

function deviceRequestProof(keys, completed, method, url, bodyText = "") {
  return signJwt(keys.privateKey, timedClaims({
    aud: "orkestr.mobile.request",
    sid: completed.session.id,
    did: completed.device.id,
    ath: sha256(completed.accessToken),
    method,
    path: url,
    bodySha256: sha256(bodyText),
    jti: crypto.randomUUID(),
  }));
}

test("two simultaneous POST voice-turn requests over real HTTP complete without cross-delivering answers", async (t) => {
  const { env, keys, completed } = await pairApprovedDevice(t);
  const baseUrl = await startFixtureServer(t, env);

  const requestFor = async (clientTurnId, transcript) => {
    const body = JSON.stringify({ clientTurnId, transcript, locale: "en-US" });
    return fetch(`${baseUrl}/api/mobile/voice-turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${completed.accessToken}`,
        "content-type": "application/json",
        "x-orkestr-content-sha256": sha256(body),
        "x-orkestr-device-proof": deviceRequestProof(keys, completed, "POST", "/api/mobile/voice-turns", body),
      },
      body,
    });
  };

  // A real Promise.all, not sequential awaits: both requests are in flight
  // on the server at the same time.
  const [firstResponse, secondResponse] = await Promise.all([
    requestFor("11111111-1111-4111-8111-111111111111", "Concurrent request A"),
    requestFor("22222222-2222-4222-8222-222222222222", "Concurrent request B"),
  ]);
  assert.equal(firstResponse.status, 202);
  assert.equal(secondResponse.status, 202);
  const first = await firstResponse.json();
  const second = await secondResponse.json();
  assert.notEqual(first.id, second.id);

  const messages = await listThreadMessages("hush-owner-thread", env);
  const inputA = messages.find((message) => message.text === "Concurrent request A");
  const inputB = messages.find((message) => message.text === "Concurrent request B");
  assert.ok(inputA && inputB);
  assert.notEqual(inputA.id, inputB.id);

  // Complete them out of order.
  await appendThreadMessage("hush-owner-thread", {
    role: "assistant", state: "completed", phase: "final_answer", parentMessageId: inputB.id, text: "Answer B",
  }, env);
  await appendThreadMessage("hush-owner-thread", {
    role: "assistant", state: "completed", phase: "final_answer", parentMessageId: inputA.id, text: "Answer A",
  }, env);

  const getFor = async (turnId) => {
    const url = `/api/mobile/voice-turns/${turnId}`;
    const response = await fetch(`${baseUrl}${url}`, {
      headers: {
        authorization: `Bearer ${completed.accessToken}`,
        "x-orkestr-content-sha256": sha256(""),
        "x-orkestr-device-proof": deviceRequestProof(keys, completed, "GET", url),
      },
    });
    return response.json();
  };
  // Read them back concurrently too.
  const [resolvedA, resolvedB] = await Promise.all([getFor(first.id), getFor(second.id)]);
  assert.equal(resolvedA.answer, "Answer A");
  assert.equal(resolvedB.answer, "Answer B");
});

test("a valid device bearer token and proof are rejected on owner-only mobile routes", async (t) => {
  const { env, keys, completed } = await pairApprovedDevice(t);
  const baseUrl = await startFixtureServer(t, env);

  const deviceRequest = async (method, url, body) => {
    const bodyText = body ? JSON.stringify(body) : "";
    return fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${completed.accessToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
        "x-orkestr-content-sha256": sha256(bodyText),
        "x-orkestr-device-proof": deviceRequestProof(keys, completed, method, url, bodyText),
      },
      ...(body ? { body: bodyText } : {}),
    });
  };

  const profiles = await deviceRequest("GET", "/api/mobile/profiles");
  const devices = await deviceRequest("GET", "/api/mobile/devices");
  const approve = await deviceRequest("POST", "/api/mobile/profiles/owner-phone/pairings/approve", { pairingCode: "does-not-matter" });
  const revoke = await deviceRequest("POST", `/api/mobile/devices/${completed.device.id}/revoke`, {});
  for (const response of [profiles, devices, approve, revoke]) {
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(JSON.stringify(body).includes("hush-owner-thread"), false);
  }
});

test("a syntactically valid but never-issued bearer token is denied, distinctly from an expired or revoked one", async (t) => {
  const { env } = await setupMobileEnv(t);
  await createThread({ id: "hush-owner-thread", name: "Hush owner", ownerUserId: "admin" }, env);
  const baseUrl = await startFixtureServer(t, env);

  const keys = keyPair();
  const fakeAccessToken = crypto.randomBytes(32).toString("base64url");
  const body = JSON.stringify({ clientTurnId: "33333333-3333-4333-8333-333333333333", transcript: "Never paired", locale: "en-US" });
  const fakeCompleted = { session: { id: "unissued-session" }, device: { id: "unissued-device" }, accessToken: fakeAccessToken };
  const response = await fetch(`${baseUrl}/api/mobile/voice-turns`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${fakeAccessToken}`,
      "content-type": "application/json",
      "x-orkestr-content-sha256": sha256(body),
      "x-orkestr-device-proof": deviceRequestProof(keys, fakeCompleted, "POST", "/api/mobile/voice-turns", body),
    },
    body,
  });
  assert.equal(response.status, 401);
  assert.equal((await listThreadMessages("hush-owner-thread", env)).length, 0);
});

test("a consumed pairing challenge cannot be replayed even while the pairing is still approved", async (t) => {
  const { env } = await setupMobileEnv(t);
  await createThread({ id: "hush-owner-thread", name: "Hush owner", ownerUserId: "admin" }, env);
  const keys = keyPair();
  const started = await startMobileDevicePairing({
    env,
    request: { headers: { "user-agent": "replay-test" }, ip: "203.0.113.20" },
    body: { deviceName: "Replay phone", publicKeyJwk: keys.publicJwk },
  });
  await approveMobileDevicePairing(started.pairing.id, { env, profileId: "owner-phone", principal: adminPrincipal({ id: "admin" }) });
  const polled = await pollMobileDevicePairing(started.pairing.id, { env, pollToken: started.pollToken });
  const proofClaims = {
    aud: "orkestr.mobile.pairing",
    pairingId: started.pairing.id,
    challengeId: polled.challenge.id,
    challenge: polled.challenge.nonce,
    publicKeyThumbprint: polled.challenge.publicKeyThumbprint,
    machineContextHash: polled.challenge.machineContextHash,
  };
  await completeMobileDevicePairing(started.pairing.id, {
    env,
    pollToken: started.pollToken,
    challengeId: polled.challenge.id,
    proof: signJwt(keys.privateKey, timedClaims({ ...proofClaims, jti: "replay-first-use" })),
  });

  // Isolate the challenge's own single-use guard (challengeConsumedAt) from
  // the separate, already-tested pairing-status guard: roll back only the
  // status field so a replay of the same already-consumed challenge is the
  // one and only thing under test.
  const statePath = path.join(env.ORKESTR_HOME, "secrets", "mobile-devices.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const pairing = state.pairings.find((item) => item.id === started.pairing.id);
  assert.equal(Boolean(pairing.challengeConsumedAt), true, "sanity: the real completion must have marked the challenge consumed");
  pairing.status = "approved";
  await fs.writeFile(statePath, `${JSON.stringify(state)}\n`);

  await assert.rejects(
    completeMobileDevicePairing(started.pairing.id, {
      env,
      pollToken: started.pollToken,
      challengeId: polled.challenge.id,
      proof: signJwt(keys.privateKey, timedClaims({ ...proofClaims, jti: "replay-second-use" })),
    }),
    /mobile_pairing_challenge_invalid/,
  );
});

test("a real authenticated SSE disconnect while dispatch is still genuinely in flight does not cancel the turn", async (t) => {
  const { env, keys, completed } = await pairApprovedDevice(t);
  const baseUrl = await startFixtureServer(t, env);

  // A deferred promise standing in for "work is still running": it only
  // resolves when this test explicitly releases it below, so "disconnect
  // happens while dispatch is still in flight" is a controlled fact, not a
  // timing guess. createHushVoiceTurn's own dependency-injection point
  // (already used by test/support/mobile-voice-http-stream.js for the same
  // reason) is the only place this can be observed deterministically -- the
  // real HTTP surface never exposes an in-flight/not-yet-delivered signal.
  let releaseDispatch;
  const dispatchGate = new Promise((resolve) => { releaseDispatch = resolve; });
  let dispatchStarted = false;
  let dispatchFinished = false;

  const clientTurnId = crypto.randomUUID();
  const transcript = "Delayed dispatch fixture";
  const turn = await createHushVoiceTurn({
    device: { deviceId: completed.device.id, profileId: "owner-phone", threadId: "hush-owner-thread", ownerUserId: "admin" },
    principal: adminPrincipal({ id: "admin" }),
    clientTurnId,
    transcript,
    locale: "en-US",
  }, {
    env,
    dependencies: {
      requestThreadInputDelivery: () => {
        dispatchStarted = true;
        void dispatchGate.then(() => { dispatchFinished = true; });
      },
      threadUsesApiAgent: () => false,
      runtimeStatus: async () => ({}),
    },
  });

  for (let i = 0; i < 200 && !dispatchStarted; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(dispatchStarted, true, "dispatch must have started before we open/close the stream");
  assert.equal(dispatchFinished, false, "dispatch must still be in flight when we disconnect");

  const url = `/api/mobile/voice-turns/${turn.id}/events`;
  const eventsResponse = await fetch(`${baseUrl}${url}`, {
    signal: AbortSignal.timeout(5000),
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "x-orkestr-content-sha256": sha256(""),
      "x-orkestr-device-proof": deviceRequestProof(keys, completed, "GET", url),
    },
  });
  assert.equal(eventsResponse.status, 200);
  const reader = eventsResponse.body.getReader();
  const decoder = new SseDecoder();
  let queued;
  while (!queued) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    queued = decoder.push(Buffer.from(chunk.value)).find((event) => JSON.parse(event.data).turn.status === "queued");
  }
  await reader.cancel();

  // The disconnect above is real; dispatch is still provably unresolved.
  assert.equal(dispatchFinished, false, "disconnecting the stream must not itself resolve/cancel the still-running dispatch");

  releaseDispatch();
  for (let i = 0; i < 200 && !dispatchFinished; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(dispatchFinished, true);

  const messages = await listThreadMessages("hush-owner-thread", env);
  const input = messages.find((message) => message.text === transcript);
  assert.ok(input);
  await appendThreadMessage("hush-owner-thread", {
    role: "assistant", state: "completed", phase: "final_answer", parentMessageId: input.id, text: "Completed after delayed dispatch",
  }, env);

  const finalResponse = await fetch(`${baseUrl}/api/mobile/voice-turns/${turn.id}`, {
    headers: {
      authorization: `Bearer ${completed.accessToken}`,
      "x-orkestr-content-sha256": sha256(""),
      "x-orkestr-device-proof": deviceRequestProof(keys, completed, "GET", `/api/mobile/voice-turns/${turn.id}`),
    },
  });
  assert.equal(finalResponse.status, 200);
  const finalTurn = await finalResponse.json();
  assert.equal(finalTurn.status, "final");
  assert.equal(finalTurn.answer, "Completed after delayed dispatch");
});
