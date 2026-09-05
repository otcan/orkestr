import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import {
  createOpenAIRealtimeCall,
  hangupOpenAIRealtimeCall,
  mobileRealtimeActivationUpdate,
  mobileRealtimeCapability,
  mobileRealtimeOwnerAllowed,
  mobileRealtimeSafetyIdentifier,
} from "../packages/core/src/mobile-realtime-provider.js";
import {
  enqueueMobileRealtimePush,
  mobilePushCapability,
  processMobilePushOutbox,
  removeMobilePushTokensForDevice,
  upsertMobileLiveActivityToken,
  upsertMobilePushToken,
} from "../packages/core/src/mobile-push.js";
import {
  activateMobileRealtimeCall,
  getMobileRealtimeCallInternal,
  listMobileRealtimeCallEvents,
  recordMobileRealtimeProgress,
  recordMobileRealtimeTranscript,
  reserveMobileRealtimeCall,
  setMobileRealtimeProviderCall,
} from "../packages/core/src/mobile-realtime-store.js";
import { executeMobileRealtimeTool } from "../packages/core/src/mobile-realtime-tools.js";
import { submitMobileRealtimeTurn } from "../packages/core/src/mobile-realtime-turns.js";
import {
  mobileLiveActivityTokenSchema,
  mobilePushTokenSchema,
  mobileRealtimeCallSchema,
  mobileRealtimeTurnSchema,
} from "../packages/shared/src/api-schemas.js";

async function envFor(label, extra = {}) {
  return {
    ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-mobile-realtime-${label}-`)),
    ORKESTR_MOBILE_REALTIME_ENABLED: "1",
    ORKESTR_OPENAI_API_KEY: "test-openai-key",
    ORKESTR_MOBILE_REALTIME_MODEL: "realtime-test-model",
    ORKESTR_MOBILE_REALTIME_VOICE: "test-voice",
    ORKESTR_MOBILE_REALTIME_SAFETY_HMAC_KEY: "test-safety-hmac-key",
    ORKESTR_MOBILE_REALTIME_OWNER_ALLOWLIST: "admin",
    ...extra,
  };
}

function device(extra = {}) {
  return {
    deviceId: "md_test",
    sessionId: "ms_test",
    profileId: "hush-test",
    ownerUserId: "admin",
    threadId: "hush-realtime-thread",
    ...extra,
  };
}

function reserveDependencies() {
  return {
    deviceActive: async () => true,
    getThreadForPrincipal: async (threadId) => ({ id: threadId, ownerUserId: "admin" }),
  };
}

const offerSdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";

test("mobile realtime schemas are closed and never accept routing fields", () => {
  assert.deepEqual(mobileRealtimeCallSchema.body.required, ["clientCallId", "offerSdp"]);
  assert.equal(mobileRealtimeCallSchema.body.additionalProperties, false);
  assert.equal("threadId" in mobileRealtimeCallSchema.body.properties, false);
  assert.deepEqual(mobileRealtimeTurnSchema.body.required, ["clientTurnId", "text", "locale"]);
  assert.equal(mobileRealtimeTurnSchema.body.additionalProperties, false);
  assert.equal("threadId" in mobileRealtimeTurnSchema.body.properties, false);
  assert.deepEqual(Object.keys(mobilePushTokenSchema.body.properties).sort(), ["environment", "operation", "token"]);
  assert.deepEqual(Object.keys(mobileLiveActivityTokenSchema.body.properties).sort(), ["activityId", "environment", "operation", "token"]);
});

test("realtime capability fails closed until every server-owned setting exists", () => {
  assert.deepEqual(mobileRealtimeCapability({ ORKESTR_MOBILE_REALTIME_ENABLED: "0" }), {
    enabled: false,
    reason: "disabled",
  });
  assert.equal(mobileRealtimeCapability({ ORKESTR_MOBILE_REALTIME_ENABLED: "1" }).reason, "configuration_incomplete");
  assert.equal(mobileRealtimeOwnerAllowed("admin", { ORKESTR_MOBILE_REALTIME_OWNER_ALLOWLIST: "admin,owner-two" }), true);
  assert.equal(mobileRealtimeOwnerAllowed("other", { ORKESTR_MOBILE_REALTIME_OWNER_ALLOWLIST: "admin,owner-two" }), false);
  assert.equal(mobileRealtimeOwnerAllowed("other", { ORKESTR_MOBILE_REALTIME_OWNER_ALLOWLIST: "*" }), true);
  assert.equal(mobileRealtimeCapability({
    ORKESTR_MOBILE_REALTIME_ENABLED: "1",
    ORKESTR_OPENAI_API_KEY: "key",
    ORKESTR_MOBILE_REALTIME_MODEL: "model",
    ORKESTR_MOBILE_REALTIME_VOICE: "voice",
    ORKESTR_MOBILE_REALTIME_SAFETY_HMAC_KEY: "safety",
  }).features.authoritativeTurns, true);
});

test("provider negotiation is multipart, fail-closed, and uses a pseudonymous safety identifier", async () => {
  const env = await envFor("provider");
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response("v=0\r\ns=answer\r\n", {
      status: 200,
      headers: { location: "/v1/realtime/calls/rtc_fixture" },
    });
  };
  const created = await createOpenAIRealtimeCall({ offerSdp, ownerUserId: "admin" }, { env, fetchImpl });
  assert.equal(created.providerCallId, "rtc_fixture");
  assert.equal(request.url, "https://api.openai.com/v1/realtime/calls");
  assert.equal(request.options.body.get("sdp"), offerSdp);
  const session = JSON.parse(request.options.body.get("session"));
  assert.equal(session.model, "realtime-test-model");
  assert.equal(session.audio.input.turn_detection.create_response, false);
  assert.deepEqual(session.tools, []);
  assert.equal(session.tool_choice, "none");
  assert.equal(request.options.headers["OpenAI-Safety-Identifier"], mobileRealtimeSafetyIdentifier("admin", env));
  assert.equal(mobileRealtimeSafetyIdentifier("admin", env).length, 64);
  assert.equal(mobileRealtimeActivationUpdate(env).session.audio.input.turn_detection.create_response, false);
});

test("authoritative typed turns enter the bound thread exactly once and retain safe call correlation", async () => {
  const env = await envFor("authoritative-typed");
  await createThread({ id: "hush-realtime-thread", name: "Realtime", ownerUserId: "admin" }, env);
  const reserved = await reserveMobileRealtimeCall({
    device: device(),
    principal: adminPrincipal(),
    clientCallId: "12121212-1212-4212-8212-121212121212",
    offerSdp,
  }, { env, dependencies: reserveDependencies() });
  await setMobileRealtimeProviderCall(reserved.call.id, { providerCallId: "rtc_typed", answerSdp: "v=0\r\n" }, env);
  await activateMobileRealtimeCall(reserved.call.id, env);
  const dependencies = {
    appendEvent: async (event) => event,
    deviceActive: async () => true,
    requestThreadInputDelivery: () => {},
    runtimeStatus: async () => ({}),
    threadUsesApiAgent: () => false,
  };
  const input = {
    callId: reserved.call.id,
    sourceKind: "typed",
    sourceId: "34343434-3434-4434-8434-343434343434",
    text: "Run the authoritative checks.",
    locale: "en-US",
    device: device(),
    principal: adminPrincipal(),
  };
  const first = await submitMobileRealtimeTurn(input, { env, dependencies });
  const retry = await submitMobileRealtimeTurn(input, { env, dependencies });
  assert.deepEqual(retry, first);
  assert.equal(first.accepted, true);
  assert.equal(first.callId, reserved.call.id);
  assert.equal(first.turnId, first.taskId);
  assert.equal(first.state, "queued");
  const messages = await listThreadMessages("hush-realtime-thread", env);
  assert.equal(messages.filter((message) => message.text === input.text).length, 1);
  const stored = await getMobileRealtimeCallInternal(reserved.call.id, env);
  assert.equal(stored.turns.length, 1);
  assert.equal(stored.turns[0].sourceKind, "typed");
  assert.equal(stored.turns[0].sourceId, input.sourceId);
  assert.equal(stored.turns[0].turnId, first.turnId);
  assert.equal("text" in stored.turns[0], false);
  await assert.rejects(
    submitMobileRealtimeTurn({
      ...input,
      sourceId: "78787878-7878-4787-8787-787878787878",
      text: "A second task cannot overlap the active one.",
    }, { env, dependencies }),
    /mobile_realtime_task_already_active/,
  );
  await assert.rejects(
    submitMobileRealtimeTurn({
      ...input,
      device: device({ sessionId: "ms_other" }),
    }, { env, dependencies }),
    /mobile_realtime_call_not_found/,
  );
  await assert.rejects(
    submitMobileRealtimeTurn({ ...input, text: "Changed retry content." }, { env, dependencies }),
    /mobile_realtime_turn_id_conflict/,
  );
});

test("final provider transcripts are mandatory idempotent Orkestr turns", async () => {
  const env = await envFor("authoritative-spoken");
  await createThread({ id: "hush-realtime-thread", name: "Realtime", ownerUserId: "admin" }, env);
  const reserved = await reserveMobileRealtimeCall({
    device: device(),
    principal: adminPrincipal(),
    clientCallId: "56565656-5656-4656-8656-565656565656",
    offerSdp,
  }, { env, dependencies: reserveDependencies() });
  await setMobileRealtimeProviderCall(reserved.call.id, { providerCallId: "rtc_spoken", answerSdp: "v=0\r\n" }, env);
  await activateMobileRealtimeCall(reserved.call.id, env);
  const dependencies = {
    appendEvent: async (event) => event,
    deviceActive: async () => true,
    requestThreadInputDelivery: () => {},
    runtimeStatus: async () => ({}),
    threadUsesApiAgent: () => false,
  };
  const input = {
    callId: reserved.call.id,
    sourceKind: "provider_audio",
    sourceId: "item_final_transcript",
    text: "Inspect the deployment status.",
    locale: "en-US",
  };
  const first = await submitMobileRealtimeTurn(input, { env, dependencies });
  assert.deepEqual(await submitMobileRealtimeTurn(input, { env, dependencies }), first);
  const messages = await listThreadMessages("hush-realtime-thread", env);
  assert.equal(messages.filter((message) => message.text === input.text).length, 1);
  const stored = await getMobileRealtimeCallInternal(reserved.call.id, env);
  assert.equal(stored.turns[0].sourceKind, "provider_audio");
  assert.equal(stored.turns[0].sourceId, input.sourceId);
  assert.equal(stored.events.some((event) => event.taskId === first.taskId && event.stage === "accepted"), true);
});

test("provider hangup uses the explicit Realtime call endpoint", async () => {
  const env = await envFor("hangup");
  let request;
  const result = await hangupOpenAIRealtimeCall("rtc_fixture", {
    env,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response("", { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, "https://api.openai.com/v1/realtime/calls/rtc_fixture/hangup");
  assert.equal(request.options.method, "POST");
});

test("call creation is session-bound and idempotent without storing the SDP offer", async () => {
  const env = await envFor("idempotency");
  const input = {
    device: device(),
    principal: adminPrincipal(),
    clientCallId: "11111111-1111-4111-8111-111111111111",
    offerSdp,
  };
  const first = await reserveMobileRealtimeCall(input, { env, dependencies: reserveDependencies() });
  assert.equal(first.created, true);
  await setMobileRealtimeProviderCall(first.call.id, { providerCallId: "rtc_one", answerSdp: "v=0\r\ns=answer\r\n" }, env);
  await activateMobileRealtimeCall(first.call.id, env);
  const retry = await reserveMobileRealtimeCall(input, { env, dependencies: reserveDependencies() });
  assert.equal(retry.created, false);
  assert.equal(retry.call.id, first.call.id);
  assert.equal(retry.response.answerSdp, "v=0\r\ns=answer\r\n");
  assert.equal("providerCallId" in retry.response, false);
  assert.equal("threadId" in retry.response, false);
  assert.equal("sessionId" in retry.response, false);
  await assert.rejects(
    reserveMobileRealtimeCall({ ...input, offerSdp: `${offerSdp}a=changed\r\n` }, { env, dependencies: reserveDependencies() }),
    /mobile_realtime_client_call_id_conflict/,
  );
  const stored = await fs.readFile(path.join(env.ORKESTR_HOME, "mobile-realtime-calls.json"), "utf8");
  assert.equal(stored.includes(offerSdp), false);
  assert.equal(stored.includes("offerHash"), true);
  assert.equal(stored.includes("ms_test"), true);
});

test("a bound thread has only one live call and event replay is scoped to the exact session", async () => {
  const env = await envFor("scope");
  const first = await reserveMobileRealtimeCall({
    device: device(),
    principal: adminPrincipal(),
    clientCallId: "22222222-2222-4222-8222-222222222222",
    offerSdp,
  }, { env, dependencies: reserveDependencies() });
  await setMobileRealtimeProviderCall(first.call.id, { providerCallId: "rtc_scope", answerSdp: "v=0\r\n" }, env);
  await activateMobileRealtimeCall(first.call.id, env);
  await assert.rejects(
    reserveMobileRealtimeCall({
      device: device({ deviceId: "md_other", sessionId: "ms_other" }),
      principal: adminPrincipal(),
      clientCallId: "33333333-3333-4333-8333-333333333333",
      offerSdp,
    }, { env, dependencies: reserveDependencies() }),
    /mobile_realtime_thread_busy/,
  );
  const added = await recordMobileRealtimeProgress(first.call.id, {
    dedupeKey: "fixture-progress",
    type: "task",
    taskId: "task_fixture",
    stage: "working",
    detail: "Running tests.",
  }, env);
  const replay = await listMobileRealtimeCallEvents(first.call.id, added.eventId - 1, {
    device: device(),
    principal: adminPrincipal(),
  }, { env });
  assert.equal(replay.length, 1);
  assert.equal(replay[0].callId, first.call.id);
  assert.equal(replay[0].eventId, added.eventId);
  await assert.rejects(
    listMobileRealtimeCallEvents(first.call.id, 0, {
      device: device({ sessionId: "ms_wrong" }),
      principal: adminPrincipal(),
    }, { env }),
    /mobile_realtime_call_not_found/,
  );
});

test("tool idempotency is provider-call-derived and task IDs cannot cross calls", async () => {
  const env = await envFor("tools");
  await createThread({
    id: "hush-realtime-thread",
    name: "Realtime",
    ownerUserId: "admin",
    binding: {
      id: "wa-binding",
      connector: "whatsapp",
      chatId: "wa-chat",
      responderAccountId: "wa-account",
    },
  }, env);
  const reserved = await reserveMobileRealtimeCall({
    device: device({ mirrorRepliesToWhatsApp: true }),
    principal: adminPrincipal(),
    clientCallId: "44444444-4444-4444-8444-444444444444",
    offerSdp,
  }, { env, dependencies: reserveDependencies() });
  await setMobileRealtimeProviderCall(reserved.call.id, { providerCallId: "rtc_tools", answerSdp: "v=0\r\n" }, env);
  await activateMobileRealtimeCall(reserved.call.id, env);
  const dependencies = {
    appendEvent: async (event) => event,
    deviceActive: async () => true,
    requestThreadInputDelivery: () => {},
    runtimeStatus: async () => ({}),
    threadUsesApiAgent: () => false,
  };
  const invalid = await executeMobileRealtimeTool({
    callId: reserved.call.id,
    toolCallId: "tool_invalid",
    name: "orkestr_start_task",
    arguments: JSON.stringify({ request: "Do the work", threadId: "attacker-thread" }),
  }, { env, dependencies });
  assert.equal(invalid.ok, false);
  const first = await executeMobileRealtimeTool({
    callId: reserved.call.id,
    toolCallId: "tool_start",
    name: "orkestr_start_task",
    arguments: JSON.stringify({ request: "Do the work" }),
  }, { env, dependencies });
  const retry = await executeMobileRealtimeTool({
    callId: reserved.call.id,
    toolCallId: "tool_start",
    name: "orkestr_start_task",
    arguments: JSON.stringify({ request: "Do the work" }),
  }, { env, dependencies });
  assert.equal(first.accepted, true);
  assert.deepEqual(retry, first);
  const messages = await listThreadMessages("hush-realtime-thread", env);
  const input = messages.find((message) => message.text === "Do the work");
  assert.equal(input.replyDeliveryIntent.serverAuthored, true);
  assert.equal(input.replyDeliveryIntent.status, "pending_reply");
  assert.equal(input.replyDeliveryIntent.target.chatId, "wa-chat");
  const unknown = await executeMobileRealtimeTool({
    callId: reserved.call.id,
    toolCallId: "tool_status",
    name: "orkestr_get_task_status",
    arguments: JSON.stringify({ taskId: "another-call-task" }),
  }, { env, dependencies });
  assert.equal(unknown.error.code, "mobile_realtime_task_not_found");
});

test("tool execution rejects inactive or revoked calls", async () => {
  const env = await envFor("tool-liveness");
  const reserved = await reserveMobileRealtimeCall({
    device: device(),
    principal: adminPrincipal(),
    clientCallId: "55555555-5555-4555-8555-555555555555",
    offerSdp,
  }, { env, dependencies: reserveDependencies() });
  await setMobileRealtimeProviderCall(reserved.call.id, { providerCallId: "rtc_liveness", answerSdp: "v=0\r\n" }, env);
  await activateMobileRealtimeCall(reserved.call.id, env);
  const revoked = await executeMobileRealtimeTool({
    callId: reserved.call.id,
    toolCallId: "tool-revoked",
    name: "orkestr_start_task",
    arguments: JSON.stringify({ request: "Do not run" }),
  }, { env, dependencies: { deviceActive: async () => false } });
  assert.equal(revoked.error.code, "mobile_device_revoked");
});

test("tool execution is rate limited per call", async () => {
  const env = await envFor("tool-rate", { ORKESTR_MOBILE_REALTIME_TOOL_LIMIT_PER_MINUTE: "1" });
  const reserved = await reserveMobileRealtimeCall({
    device: device(),
    principal: adminPrincipal(),
    clientCallId: "77777777-7777-4777-8777-777777777777",
    offerSdp,
  }, { env, dependencies: reserveDependencies() });
  await setMobileRealtimeProviderCall(reserved.call.id, { providerCallId: "rtc_rate", answerSdp: "v=0\r\n" }, env);
  await activateMobileRealtimeCall(reserved.call.id, env);
  const dependencies = { deviceActive: async () => true };
  await executeMobileRealtimeTool({
    callId: reserved.call.id,
    toolCallId: "status-one",
    name: "orkestr_get_task_status",
    arguments: JSON.stringify({ taskId: "not-mapped" }),
  }, { env, dependencies });
  const limited = await executeMobileRealtimeTool({
    callId: reserved.call.id,
    toolCallId: "status-two",
    name: "orkestr_get_task_status",
    arguments: JSON.stringify({ taskId: "also-not-mapped" }),
  }, { env, dependencies });
  assert.equal(limited.error.code, "mobile_realtime_tool_rate_limited");
  assert.equal(limited.error.retryable, true);
});

test("completed provider transcripts are retained without entering the public call projection", async () => {
  const env = await envFor("transcript");
  const reserved = await reserveMobileRealtimeCall({
    device: device(),
    principal: adminPrincipal(),
    clientCallId: "66666666-6666-4666-8666-666666666666",
    offerSdp,
  }, { env, dependencies: reserveDependencies() });
  const first = await recordMobileRealtimeTranscript(reserved.call.id, {
    role: "user",
    providerItemId: "item_one",
    text: "Please run the checks.",
  }, env);
  const duplicate = await recordMobileRealtimeTranscript(reserved.call.id, {
    role: "user",
    providerItemId: "item_one",
    text: "Please run the checks.",
  }, env);
  assert.equal(first.text, "Please run the checks.");
  assert.equal(duplicate, null);
  const stored = await getMobileRealtimeCallInternal(reserved.call.id, env);
  assert.equal(stored.transcripts.length, 1);
  assert.equal("transcripts" in reserved.call, false);
});

test("push token rotation is exact, private on disk, and removed with the device", async () => {
  const env = await envFor("push");
  const options = { env, dependencies: { deviceActive: async () => true } };
  const common = { device: device(), principal: adminPrincipal(), environment: "sandbox", operation: "upsert" };
  await upsertMobilePushToken({ ...common, token: "a".repeat(64) }, options);
  await upsertMobilePushToken({ ...common, token: "b".repeat(64) }, options);
  await upsertMobileLiveActivityToken({
    ...common,
    activityId: "activity-one",
    token: "c".repeat(64),
  }, options);
  await upsertMobileLiveActivityToken({
    ...common,
    activityId: "activity-one",
    token: "d".repeat(64),
  }, options);

  const tokenPath = path.join(env.ORKESTR_HOME, "secrets", "mobile-push-tokens.json");
  const stored = JSON.parse(await fs.readFile(tokenPath, "utf8"));
  assert.equal(stored.pushTokens.length, 1);
  assert.equal(stored.pushTokens[0].token, "b".repeat(64));
  assert.equal(stored.liveActivities.length, 1);
  assert.equal(stored.liveActivities[0].token, "d".repeat(64));
  assert.equal((await fs.stat(tokenPath)).mode & 0o777, 0o600);

  await removeMobilePushTokensForDevice("md_test", env);
  const removed = JSON.parse(await fs.readFile(tokenPath, "utf8"));
  assert.deepEqual(removed.pushTokens, []);
  assert.deepEqual(removed.liveActivities, []);
});

test("APNs delivery uses a token-free durable outbox and records successful delivery", async () => {
  const env = await envFor("push-outbox", {
    ORKESTR_MOBILE_PUSH_ENABLED: "1",
    ORKESTR_APNS_TEAM_ID: "TEAMID1234",
    ORKESTR_APNS_KEY_ID: "KEYID12345",
    ORKESTR_APNS_PRIVATE_KEY: "injected-sender-does-not-read-this",
  });
  assert.deepEqual(mobilePushCapability(env), { enabled: true, reason: null });
  const options = { env, dependencies: { deviceActive: async () => true } };
  const token = "e".repeat(64);
  await upsertMobilePushToken({
    device: device(),
    principal: adminPrincipal(),
    token,
    environment: "sandbox",
    operation: "upsert",
  }, options);
  const count = await enqueueMobileRealtimePush(device({ id: "mrc_push" }), {
    taskId: "task_push",
    stage: "completed",
    detail: "Orkestr completed the request.",
  }, { env });
  assert.equal(count, 1);
  const outboxPath = path.join(env.ORKESTR_HOME, "mobile-push-outbox.json");
  assert.equal((await fs.readFile(outboxPath, "utf8")).includes(token), false);
  let deliveredTarget;
  const result = await processMobilePushOutbox({
    env,
    send: async (target, payload) => {
      deliveredTarget = target;
      assert.equal(payload.callId, "mrc_push");
      assert.equal(payload.stage, "completed");
      return { ok: true, retryable: false, statusCode: 200 };
    },
  });
  assert.equal(result.processed, 1);
  assert.equal(deliveredTarget.token, token);
  const outbox = JSON.parse(await fs.readFile(outboxPath, "utf8"));
  assert.equal(outbox.jobs[0].status, "delivered");
  const tokens = JSON.parse(await fs.readFile(path.join(env.ORKESTR_HOME, "secrets", "mobile-push-tokens.json"), "utf8"));
  assert.ok(tokens.pushTokens[0].lastSuccessAt);
});
