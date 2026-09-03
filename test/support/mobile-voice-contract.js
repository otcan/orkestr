import assert from "node:assert/strict";
import { assertSafePublicError } from "./mobile-voice-test-helpers.js";

export const mobileVoiceContractScenarios = Object.freeze([
  "pairing_start_minimal",
  "unpaired_device_denied",
  "expired_access_denied",
  "revoked_device_denied",
  "malformed_proof_denied",
  "token_only_denied",
  "pairing_rate_limited",
  "immediate_revocation",
  "authenticated_request_context",
  "server_owned_routing",
  "profile_thread_isolation",
  "client_turn_id_idempotency",
  "last_event_id_replay",
  "concurrent_final_correlation",
  "disconnect_does_not_cancel",
  "safe_failure",
  "privileged_commands_disabled",
]);

const successfulStatuses = new Set([200, 201, 202]);
const deniedStatuses = new Set([401, 403, 404]);

function assertSuccess(result) {
  assert.ok(successfulStatuses.has(Number(result?.response?.status)), `expected success, got ${result?.response?.status}`);
  assert.ok(result?.turn?.id, "normalized turn must include an id");
  return result.turn;
}

function assertDenied(result, forbidden = []) {
  assert.ok(deniedStatuses.has(Number(result?.response?.status)), `expected authentication denial, got ${result?.response?.status}`);
  assertSafePublicError(result.response, { forbidden });
}

function assertAuthoritativeBinding(turn, binding) {
  assert.equal(turn.profileId, binding.profileId);
  assert.equal(turn.threadId, binding.threadId);
}

function last(array) {
  return array[array.length - 1];
}

function clientTurnId(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function turnBody(sequence, transcript) {
  return { clientTurnId: clientTurnId(sequence), transcript, locale: "en-US" };
}

/**
 * Register the ORK-472 black-box contract against a production HTTP adapter.
 *
 * createHarness() must return isolated fixtures and these methods:
 *   binding(label), device({ binding, state }), startPairing(),
 *   createTurn(device, body, options),
 *   getTurn(device, turnId, options), readEvents(device, turnId, options),
 *   exhaustPairingRateLimit(), revokeDevice(device), completeTurn(turnId, result),
 *   failTurn(turnId, error), controllerRequests(), inputs(), privilegedActions(),
 *   and workWasCancelled(turnId).
 *
 * createTurn/getTurn/readEvents must cross the real HTTP authentication
 * middleware. device states are paired, unpaired, expired, and malformed_proof;
 * options.authMode may be proof or token_only. Test-only methods may drive the
 * worker/store, but must not inject authenticated controller state.
 *
 * Endpoint results are normalized as { response: { status, body, headers },
 * turn }. Normalized turns expose id, state, clientTurnId, profileId, threadId,
 * inputMessageId, finalParentMessageId, text, speech, and error as applicable.
 */
export function registerMobileVoiceContractTests({ test, createHarness }) {
  if (typeof test !== "function" || typeof createHarness !== "function") {
    throw new TypeError("mobile_voice_contract_test_and_harness_required");
  }

  test("unauthenticated mobile pairing start reveals no owner, profile, or thread data", async () => {
    const harness = await createHarness();
    const response = await harness.startPairing();
    assert.ok(successfulStatuses.has(Number(response.status)), `expected pairing start success, got ${response.status}`);
    assert.doesNotMatch(JSON.stringify(response.body ?? {}), /(?:ownerUserId|userId|profileId|threadId)/i);
  });

  test("mobile voice denies unpaired devices before controller dispatch", async () => {
    const harness = await createHarness();
    const binding = harness.binding("bound");
    const device = await harness.device({ binding, state: "unpaired" });
    const before = harness.controllerRequests().length;
    const result = await harness.createTurn(device, turnBody(1, "hello"));
    assertDenied(result);
    assert.equal(harness.controllerRequests().length, before);
  });

  test("mobile voice denies expired credentials before controller dispatch", async () => {
    const harness = await createHarness();
    const device = await harness.device({ binding: harness.binding("bound"), state: "expired" });
    const before = harness.controllerRequests().length;
    const result = await harness.createTurn(device, turnBody(2, "hello"));
    assertDenied(result);
    assert.equal(harness.controllerRequests().length, before);
  });

  test("mobile voice denies revoked devices before controller dispatch", async () => {
    const harness = await createHarness();
    const device = await harness.device({ binding: harness.binding("bound"), state: "paired" });
    await harness.revokeDevice(device);
    const before = harness.controllerRequests().length;
    const result = await harness.createTurn(device, turnBody(3, "hello"));
    assertDenied(result);
    assert.equal(harness.controllerRequests().length, before);
  });

  test("mobile voice denies malformed device proof before controller dispatch", async () => {
    const harness = await createHarness();
    const device = await harness.device({ binding: harness.binding("bound"), state: "malformed_proof" });
    const before = harness.controllerRequests().length;
    const result = await harness.createTurn(device, turnBody(4, "hello"));
    assertDenied(result);
    assert.equal(harness.controllerRequests().length, before);
  });

  test("mobile voice denies bearer-token-only requests before controller dispatch", async () => {
    const harness = await createHarness();
    const device = await harness.device({ binding: harness.binding("bound"), state: "paired" });
    const before = harness.controllerRequests().length;
    const result = await harness.createTurn(
      device,
      turnBody(5, "hello"),
      { authMode: "token_only" },
    );
    assertDenied(result);
    assert.equal(harness.controllerRequests().length, before);
  });

  test("mobile pairing start is rate limited", async () => {
    const harness = await createHarness();
    const response = await harness.exhaustPairingRateLimit();
    assert.equal(response.status, 429);
    assertSafePublicError(response);
    const retryAfter = response.headers?.get?.("retry-after") ?? response.headers?.["retry-after"];
    assert.ok(Number(retryAfter) > 0, "rate-limit response must include Retry-After");
  });

  test("mobile revocation invalidates an already-issued credential immediately", async () => {
    const harness = await createHarness();
    const device = await harness.device({ binding: harness.binding("bound"), state: "paired" });
    assertSuccess(await harness.createTurn(device, turnBody(6, "before")));
    await harness.revokeDevice(device);
    const before = harness.controllerRequests().length;
    const denied = await harness.createTurn(device, turnBody(7, "after"));
    assertDenied(denied);
    assert.equal(harness.controllerRequests().length, before);
  });

  test("authenticated mobile endpoints receive only the verified mobile request context", async () => {
    const harness = await createHarness();
    const binding = harness.binding("bound");
    const device = await harness.device({ binding, state: "paired" });
    assertSuccess(await harness.createTurn(device, turnBody(8, "hello")));
    assert.deepEqual(last(harness.controllerRequests()), {
      machineAuth: "mobile_device",
      context: {
        principalKind: "mobile_device",
        routeKind: "hush_mobile",
        deviceId: device.deviceId,
        profileId: binding.profileId,
        threadId: binding.threadId,
        ownerUserId: binding.ownerUserId,
      },
    });
  });

  test("client-selected profile and thread are rejected or ignored", async () => {
    const harness = await createHarness();
    const binding = harness.binding("bound");
    const other = harness.binding("other");
    const device = await harness.device({ binding, state: "paired" });
    const forbidden = [other.profileId, other.threadId];
    const bodySpoof = await harness.createTurn(device, {
      ...turnBody(9, "hello"),
      profileId: other.profileId,
      threadId: other.threadId,
    });
    if (successfulStatuses.has(Number(bodySpoof.response.status))) {
      assertAuthoritativeBinding(bodySpoof.turn, binding);
    } else {
      assert.equal(bodySpoof.response.status, 400);
      assertSafePublicError(bodySpoof.response, { forbidden });
    }

    const valid = assertSuccess(await harness.createTurn(device, turnBody(10, "hello")));
    const querySpoof = await harness.getTurn(device, valid.id, {
      query: { profileId: other.profileId, threadId: other.threadId },
    });
    if (successfulStatuses.has(Number(querySpoof.response.status))) {
      assertAuthoritativeBinding(querySpoof.turn, binding);
    } else {
      assert.equal(querySpoof.response.status, 400);
      assertSafePublicError(querySpoof.response, { forbidden });
    }
  });

  test("mobile turns are isolated by authenticated profile and thread", async () => {
    const harness = await createHarness();
    const firstBinding = harness.binding("first");
    const secondBinding = harness.binding("second");
    const first = await harness.device({ binding: firstBinding, state: "paired" });
    const second = await harness.device({ binding: secondBinding, state: "paired" });
    const turn = assertSuccess(await harness.createTurn(first, turnBody(11, "private")));
    assertAuthoritativeBinding(turn, firstBinding);
    assertDenied(await harness.getTurn(second, turn.id), [turn.id, firstBinding.profileId, firstBinding.threadId]);
    assertDenied(await harness.readEvents(second, turn.id), [turn.id, firstBinding.profileId, firstBinding.threadId]);
  });

  test("clientTurnId is idempotent and enqueues exactly one thread input", async () => {
    const harness = await createHarness();
    const binding = harness.binding("bound");
    const device = await harness.device({ binding, state: "paired" });
    const body = turnBody(12, "only once");
    const [first, retry] = await Promise.all([
      harness.createTurn(device, body),
      harness.createTurn(device, body),
    ]);
    const firstTurn = assertSuccess(first);
    const retryTurn = assertSuccess(retry);
    assert.equal(retryTurn.id, firstTurn.id);
    assert.equal(harness.inputs().filter((input) => input.clientTurnId === body.clientTurnId).length, 1);
    const conflict = await harness.createTurn(device, { ...body, transcript: "different content" });
    assert.equal(conflict.response.status, 409);
    assertSafePublicError(conflict.response);
    assert.equal(harness.inputs().filter((input) => input.clientTurnId === body.clientTurnId).length, 1);
  });

  test("SSE reconnect replays missed events after Last-Event-ID without duplicates", async () => {
    const harness = await createHarness();
    const device = await harness.device({ binding: harness.binding("bound"), state: "paired" });
    const turn = assertSuccess(await harness.createTurn(device, turnBody(13, "stream")));
    const initial = await harness.readEvents(device, turn.id, { disconnectAfter: 1 });
    const contentType = initial.response?.headers?.get?.("content-type") ?? initial.response?.headers?.["content-type"];
    assert.match(String(contentType), /^text\/event-stream(?:;|$)/i);
    assert.ok(initial.events?.length, "first stream must return an event");
    const cursor = last(initial.events).id;
    assert.ok(cursor, "SSE events must have stable ids");
    await harness.completeTurn(turn.id, { text: "finished", speech: "finished" });
    const replay = await harness.readEvents(device, turn.id, { lastEventId: cursor, untilTerminal: true });
    assert.ok(replay.events?.length, "reconnected stream must replay missed events");
    assert.equal(replay.requestHeaders?.["Last-Event-ID"] ?? replay.requestHeaders?.["last-event-id"], cursor);
    assert.equal(replay.events.some((event) => event.id === cursor), false);
    assert.equal(last(replay.events).data?.state ?? last(replay.events).state, "final");
  });

  test("concurrent out-of-order turns keep parent-linked final answers separate", async () => {
    const harness = await createHarness();
    const device = await harness.device({ binding: harness.binding("bound"), state: "paired" });
    const first = assertSuccess(await harness.createTurn(device, turnBody(14, "A")));
    const second = assertSuccess(await harness.createTurn(device, turnBody(15, "B")));
    await harness.completeTurn(second.id, { text: "answer B", speech: "answer B" });
    await harness.completeTurn(first.id, { text: "answer A", speech: "answer A" });
    const completedA = assertSuccess(await harness.getTurn(device, first.id));
    const completedB = assertSuccess(await harness.getTurn(device, second.id));
    assert.deepEqual([completedA.text, completedB.text], ["answer A", "answer B"]);
    assert.equal(completedA.finalParentMessageId, completedA.inputMessageId);
    assert.equal(completedB.finalParentMessageId, completedB.inputMessageId);
    assert.notEqual(completedA.inputMessageId, completedB.inputMessageId);
  });

  test("disconnecting a foreground stream does not cancel a long task", async () => {
    const harness = await createHarness();
    const device = await harness.device({ binding: harness.binding("bound"), state: "paired" });
    const turn = assertSuccess(await harness.createTurn(device, turnBody(16, "long task")));
    await harness.readEvents(device, turn.id, { disconnectAfter: 1 });
    assert.equal(await harness.workWasCancelled(turn.id), false);
    await harness.completeTurn(turn.id, { text: "completed later", speech: "completed later" });
    const completed = assertSuccess(await harness.getTurn(device, turn.id));
    assert.equal(completed.state, "final");
    assert.equal(completed.text, "completed later");
  });

  test("mobile turn failures expose only safe public errors", async () => {
    const harness = await createHarness();
    const device = await harness.device({ binding: harness.binding("bound"), state: "paired" });
    const turn = assertSuccess(await harness.createTurn(device, turnBody(17, "fail safely")));
    const privateDetail = "/private/runtime/path credential=do-not-return";
    await harness.failTurn(turn.id, { code: "worker_failed", privateDetail });
    const failed = assertSuccess(await harness.getTurn(device, turn.id));
    assert.equal(failed.state, "failed");
    assert.match(String(failed.error), /^[a-z][a-z0-9_]{0,119}$/);
    assert.equal(JSON.stringify(failed).includes(privateDetail), false);
  });

  test("mobile voice text cannot execute privileged slash commands", async () => {
    const harness = await createHarness();
    const device = await harness.device({ binding: harness.binding("bound"), state: "paired" });
    const body = turnBody(18, "/stop");
    assertSuccess(await harness.createTurn(device, body));
    const input = harness.inputs().find((candidate) => candidate.clientTurnId === body.clientTurnId);
    assert.ok(input);
    assert.equal(input.text, "/stop");
    assert.equal(input.commandProcessing, "disabled");
    assert.deepEqual(harness.privilegedActions(), []);
  });
}
