import assert from "node:assert/strict";
import test from "node:test";
import {
  mobileVoiceContractScenarios,
  registerMobileVoiceContractTests,
} from "./support/mobile-voice-contract.js";
import {
  assertSafePublicError,
  decodeSseChunks,
  eventually,
  generateMobileDeviceKeyPair,
  lastEventIdHeaders,
  signEs256Proof,
  verifyEs256Proof,
} from "./support/mobile-voice-test-helpers.js";

function mobileRequest(overrides = {}) {
  return {
    orkestrMachineAuth: "mobile_device",
    orkestrMachineAuthContext: {
      principalKind: "mobile_device",
      routeKind: "hush_mobile",
      deviceId: "device-fixture",
      profileId: "profile-server-bound",
      threadId: "thread-server-bound",
      ownerUserId: "owner-fixture",
    },
    ...overrides,
  };
}

function mobileImplementationMissing(error) {
  return error?.code === "ERR_MODULE_NOT_FOUND" && /(?:hush-voice-runtime|mobile-voice\.controller)/.test(String(error?.message || ""));
}

test("Hush runtime accepts only the verified mobile context and discards client routing", async (t) => {
  let hushMobileDeviceContext;
  try {
    ({ hushMobileDeviceContext } = await import("../packages/core/src/hush-voice-runtime.js"));
  } catch (error) {
    if (mobileImplementationMissing(error)) {
      t.skip("MobileModule implementation is supplied by the ORK-472 implementation track");
      return;
    }
    throw error;
  }
  const request = mobileRequest();
  request.orkestrMachineAuthContext.untrustedExtra = "discarded";
  request.body = { profileId: "profile-client-selected", threadId: "thread-client-selected" };
  request.query = { profileId: "profile-query-selected", threadId: "thread-query-selected" };

  assert.deepEqual(hushMobileDeviceContext(request), {
    deviceId: "device-fixture",
    profileId: "profile-server-bound",
    threadId: "thread-server-bound",
    ownerUserId: "owner-fixture",
  });
  for (const request of [
    {},
    { authorization: "Bearer token-fixture" },
    mobileRequest({ orkestrMachineAuth: "vagent" }),
  ]) {
    assert.throws(
      () => hushMobileDeviceContext(request),
      (error) => error.code === "mobile_device_auth_required" && error.statusCode === 401,
    );
  }

  for (const context of [
    null,
    {},
    { ...mobileRequest().orkestrMachineAuthContext, principalKind: "browser" },
    { ...mobileRequest().orkestrMachineAuthContext, routeKind: "other_route" },
    { ...mobileRequest().orkestrMachineAuthContext, threadId: "" },
    { ...mobileRequest().orkestrMachineAuthContext, profileId: 123 },
  ]) {
    assert.throws(
      () => hushMobileDeviceContext(mobileRequest({ orkestrMachineAuthContext: context })),
      (error) => ["mobile_device_auth_required", "mobile_device_profile_unavailable"].includes(error.code) &&
        [401, 403].includes(error.statusCode),
    );
  }
});

test("authenticated mobile endpoints use machine context and reject token-only or client-selected routing", async (t) => {
  let MobileVoiceController;
  try {
    ({ MobileVoiceController } = await import("../dist/server/apps/server/src/modules/mobile-voice/mobile-voice.controller.js"));
  } catch (error) {
    if (mobileImplementationMissing(error)) {
      t.skip("MobileModule implementation is supplied by the ORK-472 implementation track");
      return;
    }
    throw error;
  }

  const calls = [];
  const service = {
    create: async (input) => { calls.push({ operation: "create", input }); return { id: "turn-fixture", status: "queued" }; },
    get: async (turnId, input) => { calls.push({ operation: "get", turnId, input }); return { id: turnId, status: "queued" }; },
  };
  const controller = new MobileVoiceController(service);
  const request = mobileRequest({ orkestrPrincipal: { role: "admin", userId: "owner-fixture" } });
  const body = {
    clientTurnId: "10000000-0000-4000-8000-000000000001",
    transcript: "hello",
    locale: "en-US",
  };

  await controller.create(request, body);
  assert.deepEqual(calls[0], {
    operation: "create",
    input: {
      device: {
        deviceId: "device-fixture",
        profileId: "profile-server-bound",
        threadId: "thread-server-bound",
        ownerUserId: "owner-fixture",
      },
      principal: { role: "admin", userId: "owner-fixture" },
      clientTurnId: body.clientTurnId,
      transcript: "hello",
      locale: "en-US",
    },
  });

  await assert.rejects(
    controller.create({
      headers: { authorization: "Bearer token-fixture" },
      orkestrPrincipal: request.orkestrPrincipal,
    }, body),
    (error) => error.code === "mobile_device_auth_required" && error.statusCode === 401,
  );
  assert.equal(calls.length, 1, "token-only request reached the service");

  await assert.rejects(
    controller.create(request, { ...body, profileId: "profile-client-selected", threadId: "thread-client-selected" }),
    (error) => error?.getStatus?.() === 400,
  );
  assert.equal(calls.length, 1, "client-selected body routing reached the service");

  await controller.get({
    ...request,
    query: { profileId: "profile-query-selected", threadId: "thread-query-selected" },
  }, "20000000-0000-4000-8000-000000000002");
  assert.deepEqual(calls[1].input.device, {
    deviceId: "device-fixture",
    profileId: "profile-server-bound",
    threadId: "thread-server-bound",
    ownerUserId: "owner-fixture",
  });
});

test("mobile device fixtures produce verifiable P-256 ES256 proofs", () => {
  const first = generateMobileDeviceKeyPair();
  const second = generateMobileDeviceKeyPair();
  const payload = "POST\n/api/mobile/voice-turns\nnonce-fixture\nbody-digest-fixture";
  const signature = signEs256Proof(first.privateKey, payload);
  assert.equal(verifyEs256Proof(first.publicKey, payload, signature), true);
  assert.equal(verifyEs256Proof(first.publicKey, `${payload}-modified`, signature), false);
  assert.equal(verifyEs256Proof(second.publicKey, payload, signature), false);
  assert.deepEqual(
    { kty: first.publicJwk.kty, crv: first.publicJwk.crv },
    { kty: "EC", crv: "P-256" },
  );
  assert.equal("d" in first.publicJwk, false);
});

test("SSE decoder handles split CRLF chunks, multiline data, ids, comments, and retry", () => {
  const unicodeFrame = Buffer.from("id: 9\ndata: {\"speech\":\"ready ✅\"}\n\n", "utf8");
  const checkmark = unicodeFrame.indexOf(Buffer.from("✅"));
  const events = decodeSseChunks([
    ": keepalive\r",
    "\nid: 7\r\nevent: turn\r\ndata: {\"state\":\"working\"}\r\ndata: detail\r\nretry: 1000\r\n\r",
    "\nid: 8\ndata: {\"state\":\"final\"}\n\n",
    unicodeFrame.subarray(0, checkmark + 1),
    unicodeFrame.subarray(checkmark + 1),
  ]);
  assert.deepEqual(events, [
    {
      id: "7",
      event: "turn",
      data: "{\"state\":\"working\"}\ndetail",
      retry: 1000,
    },
    {
      id: "8",
      event: "message",
      data: "{\"state\":\"final\"}",
    },
    {
      id: "9",
      event: "message",
      data: "{\"speech\":\"ready ✅\"}",
    },
  ]);
  assert.deepEqual(lastEventIdHeaders("7", { accept: "text/event-stream" }), {
    accept: "text/event-stream",
    "Last-Event-ID": "7",
  });
  assert.deepEqual(lastEventIdHeaders(""), {});
});

test("safe mobile error assertion rejects credential, route, and stack disclosure", () => {
  assert.equal(assertSafePublicError({ status: 401, body: { error: "mobile_device_auth_required" } }), "mobile_device_auth_required");
  assert.throws(() => assertSafePublicError({
    status: 500,
    body: { error: "worker_failed", stack: "/private/path", accessToken: "secret" },
  }, { forbidden: ["secret"] }));
  assert.throws(() => assertSafePublicError({ status: 500, body: { error: "Error: internal detail" } }));
});

test("eventually retries transient assertions and returns the successful value", async () => {
  let attempts = 0;
  const result = await eventually(() => {
    attempts += 1;
    assert.ok(attempts >= 3);
    return "ready";
  }, { timeoutMs: 250, intervalMs: 1 });
  assert.equal(result, "ready");
  assert.equal(attempts, 3);
});

test("mobile endpoint contract registers every ORK-472 security and lifecycle scenario", () => {
  const registered = [];
  registerMobileVoiceContractTests({
    test: (name, callback) => registered.push({ name, callback }),
    createHarness: async () => ({}),
  });
  assert.equal(registered.length, mobileVoiceContractScenarios.length);
  assert.ok(registered.every(({ callback }) => typeof callback === "function"));
  for (const phrase of [
    "pairing start", "unpaired", "expired", "revoked", "malformed", "token-only", "rate limited",
    "request context", "profile and thread", "idempotent", "Last-Event-ID",
    "out-of-order", "disconnecting", "safe public errors", "slash commands",
  ]) {
    assert.ok(registered.some(({ name }) => name.includes(phrase)), `missing contract test: ${phrase}`);
  }
});
