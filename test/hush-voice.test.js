import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createHushVoiceTurn,
  getHushVoiceTurn,
  HUSH_MOBILE_MACHINE_AUTH,
  HUSH_MOBILE_ROUTE_KIND,
  hushMobileDeviceContext,
  hushSpeech,
  listHushVoiceTurnEvents,
} from "../packages/core/src/hush-voice.js";
import { appendThreadMessage, createThread, listThreadMessages, updateThreadMessage } from "../packages/core/src/threads.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { parseThreadInputCommand } from "../packages/core/src/thread-commands.js";
import { mobileVoiceTurnSchema } from "../packages/shared/src/api-schemas.js";

async function testEnv(label) {
  return { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-hush-${label}-`)) };
}

function device(id, threadId, profileId = "hush-default") {
  return { deviceId: id, profileId, threadId, ownerUserId: "admin" };
}

function dependencies(deliveries = []) {
  return {
    appendEvent: async (event) => event,
    requestThreadInputDelivery: (threadId) => deliveries.push(threadId),
    runtimeStatus: async () => ({}),
    threadUsesApiAgent: () => false,
  };
}

async function createHushThread(id, env) {
  await createThread({ id, name: id, ownerUserId: "admin" }, env);
}

async function createTurn({ env, deviceContext, clientTurnId, transcript, locale = "en-US", dependencies: dependencyOverrides = {} }) {
  return createHushVoiceTurn({
    device: deviceContext,
    principal: adminPrincipal(),
    clientTurnId,
    transcript,
    locale,
  }, { env, dependencies: dependencyOverrides });
}

test("Hush request schema is closed and excludes raw audio, thread selection, and control flags", () => {
  const body = mobileVoiceTurnSchema.body;
  assert.deepEqual(body.required, ["clientTurnId", "transcript", "locale"]);
  assert.equal(body.additionalProperties, false);
  assert.equal("threadId" in body.properties, false);
  assert.equal("audio" in body.properties, false);
  assert.equal("commandProcessing" in body.properties, false);
});

test("Hush accepts normal disabled-command input, persists only turn metadata, and schedules normal delivery", async () => {
  const env = await testEnv("enqueue");
  await createHushThread("hush-thread", env);
  const deliveries = [];
  const context = device("phone-a", "hush-thread");
  const turn = await createTurn({
    env,
    deviceContext: context,
    clientTurnId: "11111111-1111-4111-8111-111111111111",
    transcript: "/stop after you summarize this",
    dependencies: dependencies(deliveries),
  });
  const messages = await listThreadMessages("hush-thread", env);
  const stored = JSON.parse(await fs.readFile(path.join(env.ORKESTR_HOME, "mobile-voice-turns.json"), "utf8"));

  assert.equal(turn.status, "queued");
  assert.deepEqual(deliveries, ["hush-thread"]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].source, "hush");
  assert.equal(messages[0].commandProcessing, "disabled");
  assert.equal(messages[0].clientMessageId, "hush:phone-a:11111111-1111-4111-8111-111111111111");
  assert.equal(parseThreadInputCommand(messages[0]).command, null);
  assert.equal(stored.turns[0].contentHash.length, 64);
  assert.equal(JSON.stringify(stored).includes("/stop after you summarize this"), false);
  assert.equal(JSON.stringify(stored).includes("audio"), false);
});

test("Hush clientTurnId is device-scoped, durable, and cannot be reused with different content", async () => {
  const env = await testEnv("idempotency");
  await createHushThread("hush-thread", env);
  const deliveries = [];
  const context = device("phone-a", "hush-thread");
  const options = dependencies(deliveries);
  const input = {
    env,
    deviceContext: context,
    clientTurnId: "22222222-2222-4222-8222-222222222222",
    transcript: "Check the deployment.",
    dependencies: options,
  };
  const first = await createTurn(input);
  const second = await createTurn(input);

  assert.equal(first.id, second.id);
  assert.deepEqual(deliveries, ["hush-thread"]);
  await assert.rejects(
    createTurn({ ...input, transcript: "Check a different deployment." }),
    (error) => error?.statusCode === 409 && error?.code === "mobile_voice_turn_id_conflict",
  );

  const secondDevice = await createTurn({
    ...input,
    deviceContext: device("phone-b", "hush-thread", "hush-second"),
  });
  assert.notEqual(first.id, secondDevice.id);
  assert.deepEqual(deliveries, ["hush-thread", "hush-thread"]);
});

test("Hush finals are correlated to their exact parent even when concurrent turns complete out of order", async () => {
  const env = await testEnv("concurrency");
  await createHushThread("hush-thread", env);
  const context = device("phone-a", "hush-thread");
  const options = { env, dependencies: dependencies() };
  const first = await createTurn({
    env,
    deviceContext: context,
    clientTurnId: "33333333-3333-4333-8333-333333333333",
    transcript: "First request",
    dependencies: options.dependencies,
  });
  const second = await createTurn({
    env,
    deviceContext: context,
    clientTurnId: "44444444-4444-4444-8444-444444444444",
    transcript: "Second request",
    dependencies: options.dependencies,
  });
  const messages = await listThreadMessages("hush-thread", env);
  const firstInput = messages.find((message) => message.text === "First request");
  const secondInput = messages.find((message) => message.text === "Second request");

  await appendThreadMessage("hush-thread", {
    role: "assistant",
    state: "completed",
    phase: "final_answer",
    parentMessageId: firstInput.id,
    text: "First answer",
  }, env);
  await appendThreadMessage("hush-thread", {
    role: "assistant",
    state: "completed",
    phase: "final_answer",
    parentMessageId: secondInput.id,
    text: "Second answer",
  }, env);

  const secondFinal = await getHushVoiceTurn(second.id, { device: context, principal: adminPrincipal() }, options);
  const firstFinal = await getHushVoiceTurn(first.id, { device: context, principal: adminPrincipal() }, options);

  assert.equal(secondFinal.answer, "Second answer");
  assert.equal(firstFinal.answer, "First answer");
  assert.equal(secondFinal.speech, "Second answer");
  assert.equal(firstFinal.speech, "First answer");
});

test("Hush recovers a parentless final from the same canonical Codex turn", async () => {
  const env = await testEnv("same-codex-turn");
  await createHushThread("hush-thread", env);
  const context = device("phone-a", "hush-thread");
  const options = { env, dependencies: dependencies() };
  const turn = await createTurn({
    env,
    deviceContext: context,
    clientTurnId: "40000000-0000-4000-8000-000000000001",
    transcript: "Recover my completed answer",
    dependencies: options.dependencies,
  });
  const input = (await listThreadMessages("hush-thread", env)).find((message) => message.source === "hush");
  await updateThreadMessage("hush-thread", input.id, {
    state: "completed",
    deliveryState: "delivered",
    codexThreadId: "codex-thread-a",
    codexTurnId: "codex-turn-a",
  }, env);
  const assistant = await appendThreadMessage("hush-thread", {
    role: "assistant",
    state: "completed",
    phase: "final_answer",
    text: "Recovered answer",
    codexThreadId: "codex-thread-a",
    executorTurnId: "codex-turn-a",
  }, env);

  const recovered = await getHushVoiceTurn(turn.id, { device: context, principal: adminPrincipal() }, options);

  assert.equal(recovered.status, "final");
  assert.equal(recovered.answer, "Recovered answer");
  const stored = JSON.parse(await fs.readFile(path.join(env.ORKESTR_HOME, "mobile-voice-turns.json"), "utf8"));
  assert.equal(stored.turns[0].finalMessageId, assistant.id);
});

test("Hush rejects parentless finals from a different canonical Codex turn", async () => {
  const env = await testEnv("different-codex-turn");
  await createHushThread("hush-thread", env);
  const context = device("phone-a", "hush-thread");
  const options = { env, dependencies: dependencies() };
  const turn = await createTurn({
    env,
    deviceContext: context,
    clientTurnId: "40000000-0000-4000-8000-000000000002",
    transcript: "Do not cross turns",
    dependencies: options.dependencies,
  });
  const input = (await listThreadMessages("hush-thread", env)).find((message) => message.source === "hush");
  await updateThreadMessage("hush-thread", input.id, { state: "completed", codexTurnId: "codex-turn-input" }, env);
  await appendThreadMessage("hush-thread", {
    role: "assistant",
    state: "completed",
    phase: "final_answer",
    text: "Wrong turn answer",
    codexTurnId: "codex-turn-final",
  }, env);

  const unresolved = await getHushVoiceTurn(turn.id, { device: context, principal: adminPrincipal() }, options);

  assert.equal(unresolved.status, "queued");
  assert.equal("answer" in unresolved, false);
});

test("Hush rejects parentless finals when either canonical Codex turn ID is missing", async (t) => {
  for (const scenario of [
    { label: "input", inputTurnId: "", finalTurnId: "codex-turn-final" },
    { label: "final", inputTurnId: "codex-turn-input", finalTurnId: "" },
  ]) {
    await t.test(`missing ${scenario.label} turn ID`, async () => {
      const env = await testEnv(`missing-${scenario.label}-turn`);
      await createHushThread("hush-thread", env);
      const context = device("phone-a", "hush-thread");
      const options = { env, dependencies: dependencies() };
      const turn = await createTurn({
        env,
        deviceContext: context,
        clientTurnId: scenario.label === "input"
          ? "40000000-0000-4000-8000-000000000003"
          : "40000000-0000-4000-8000-000000000004",
        transcript: `Missing ${scenario.label} turn ID`,
        dependencies: options.dependencies,
      });
      const input = (await listThreadMessages("hush-thread", env)).find((message) => message.source === "hush");
      await updateThreadMessage("hush-thread", input.id, {
        state: "completed",
        ...(scenario.inputTurnId ? { codexTurnId: scenario.inputTurnId } : {}),
      }, env);
      await appendThreadMessage("hush-thread", {
        role: "assistant",
        state: "completed",
        phase: "final_answer",
        text: "Uncorrelated answer",
        ...(scenario.finalTurnId ? { executorTurnId: scenario.finalTurnId } : {}),
      }, env);

      const unresolved = await getHushVoiceTurn(turn.id, { device: context, principal: adminPrincipal() }, options);
      assert.equal(unresolved.status, "queued");
      assert.equal("answer" in unresolved, false);
    });
  }
});

test("Hush same-turn fallback rejects the wrong assistant role, phase, and state", async (t) => {
  for (const scenario of [
    { label: "role", role: "user", state: "completed", phase: "final_answer" },
    { label: "phase", role: "assistant", state: "completed", phase: "commentary" },
    { label: "state", role: "assistant", state: "running", phase: "final_answer" },
  ]) {
    await t.test(`wrong ${scenario.label}`, async () => {
      const env = await testEnv(`wrong-${scenario.label}`);
      await createHushThread("hush-thread", env);
      const context = device("phone-a", "hush-thread");
      const options = { env, dependencies: dependencies() };
      const turn = await createTurn({
        env,
        deviceContext: context,
        clientTurnId: scenario.label === "role"
          ? "40000000-0000-4000-8000-000000000005"
          : scenario.label === "phase"
            ? "40000000-0000-4000-8000-000000000006"
            : "40000000-0000-4000-8000-000000000007",
        transcript: `Reject wrong ${scenario.label}`,
        dependencies: options.dependencies,
      });
      const input = (await listThreadMessages("hush-thread", env)).find((message) => message.source === "hush");
      await updateThreadMessage("hush-thread", input.id, { state: "completed", codexTurnId: "shared-turn" }, env);
      await appendThreadMessage("hush-thread", {
        ...scenario,
        text: "Invalid candidate",
        codexTurnId: "shared-turn",
      }, env);

      const unresolved = await getHushVoiceTurn(turn.id, { device: context, principal: adminPrincipal() }, options);
      assert.equal(unresolved.status, "queued");
      assert.equal("answer" in unresolved, false);
    });
  }
});

test("Hush same-turn reconciliation and SSE replay are idempotent", async () => {
  const env = await testEnv("same-turn-replay");
  await createHushThread("hush-thread", env);
  const context = device("phone-a", "hush-thread");
  const appendedEvents = [];
  const replayDependencies = {
    ...dependencies(),
    appendEvent: async (event) => { appendedEvents.push(event); return event; },
  };
  const options = { env, dependencies: replayDependencies };
  const turn = await createTurn({
    env,
    deviceContext: context,
    clientTurnId: "40000000-0000-4000-8000-000000000008",
    transcript: "Replay the recovered final",
    dependencies: replayDependencies,
  });
  const input = (await listThreadMessages("hush-thread", env)).find((message) => message.source === "hush");
  await updateThreadMessage("hush-thread", input.id, { state: "completed", executorTurnId: "replay-turn" }, env);
  await appendThreadMessage("hush-thread", {
    role: "assistant",
    state: "completed",
    phase: "final_answer",
    text: "Stable replay answer",
    codexTurnId: "replay-turn",
  }, env);

  const first = await getHushVoiceTurn(turn.id, { device: context, principal: adminPrincipal() }, options);
  const second = await getHushVoiceTurn(turn.id, { device: context, principal: adminPrincipal() }, options);
  const replay = await listHushVoiceTurnEvents(turn.id, 1, { device: context, principal: adminPrincipal() }, options);
  const replayAgain = await listHushVoiceTurnEvents(turn.id, 1, { device: context, principal: adminPrincipal() }, options);

  assert.deepEqual(second, first);
  assert.deepEqual(replayAgain, replay);
  assert.deepEqual(replay.map((event) => [event.eventId, event.type]), [[2, "final"]]);
  assert.equal(appendedEvents.filter((event) => event.type === "hush_voice_turn_final").length, 1);
});

test("Hush same-turn fallback does not cross owner, profile, device, or thread boundaries", async () => {
  const env = await testEnv("same-turn-isolation");
  await createHushThread("hush-thread", env);
  await createHushThread("foreign-thread", env);
  const context = device("phone-a", "hush-thread");
  const options = { env, dependencies: dependencies() };
  const turn = await createTurn({
    env,
    deviceContext: context,
    clientTurnId: "40000000-0000-4000-8000-000000000009",
    transcript: "Keep this turn isolated",
    dependencies: options.dependencies,
  });
  const input = (await listThreadMessages("hush-thread", env)).find((message) => message.source === "hush");
  await updateThreadMessage("hush-thread", input.id, { state: "completed", codexTurnId: "shared-looking-turn" }, env);
  await appendThreadMessage("foreign-thread", {
    role: "assistant",
    state: "completed",
    phase: "final_answer",
    text: "Foreign thread answer",
    codexTurnId: "shared-looking-turn",
  }, env);

  const unresolved = await getHushVoiceTurn(turn.id, { device: context, principal: adminPrincipal() }, options);
  assert.equal(unresolved.status, "queued");
  assert.equal("answer" in unresolved, false);
  await assert.rejects(
    getHushVoiceTurn(turn.id, { device: device("phone-b", "hush-thread"), principal: adminPrincipal() }, options),
    (error) => error?.statusCode === 404 && error?.code === "mobile_voice_turn_not_found",
  );
  await assert.rejects(
    getHushVoiceTurn(turn.id, { device: device("phone-a", "hush-thread", "foreign-profile"), principal: adminPrincipal() }, options),
    (error) => error?.statusCode === 404 && error?.code === "mobile_voice_turn_not_found",
  );
  await assert.rejects(
    getHushVoiceTurn(turn.id, { device: context, principal: adminPrincipal("foreign-owner") }, options),
    (error) => error?.statusCode === 403 && error?.code === "mobile_device_profile_forbidden",
  );
});

test("Hush events replay durably from Last-Event-ID and expose only their device's turn", async () => {
  const env = await testEnv("events");
  await createHushThread("hush-thread", env);
  const firstDevice = device("phone-a", "hush-thread");
  const secondDevice = device("phone-b", "hush-thread", "hush-second");
  const options = { env, dependencies: dependencies() };
  const turn = await createTurn({
    env,
    deviceContext: firstDevice,
    clientTurnId: "55555555-5555-4555-8555-555555555555",
    transcript: "Give a status update",
    dependencies: options.dependencies,
  });
  const input = (await listThreadMessages("hush-thread", env)).find((message) => message.source === "hush");
  await updateThreadMessage("hush-thread", input.id, { state: "running", deliveredAt: new Date().toISOString() }, env);
  const working = await listHushVoiceTurnEvents(turn.id, 0, { device: firstDevice, principal: adminPrincipal() }, options);

  assert.deepEqual(working.map((event) => event.type), ["queued", "working"]);
  const replay = await listHushVoiceTurnEvents(turn.id, 1, { device: firstDevice, principal: adminPrincipal() }, options);
  assert.deepEqual(replay.map((event) => event.eventId), [2]);
  await assert.rejects(
    listHushVoiceTurnEvents(turn.id, 0, { device: secondDevice, principal: adminPrincipal() }, options),
    (error) => error?.statusCode === 404,
  );
});

test("Hush records a durable safe failed state when its parent input fails", async () => {
  const env = await testEnv("failed");
  await createHushThread("hush-thread", env);
  const context = device("phone-a", "hush-thread");
  const options = { env, dependencies: dependencies() };
  const turn = await createTurn({
    env,
    deviceContext: context,
    clientTurnId: "66666666-6666-4666-8666-666666666666",
    transcript: "Run a task",
    dependencies: options.dependencies,
  });
  const input = (await listThreadMessages("hush-thread", env)).find((message) => message.source === "hush");
  await updateThreadMessage("hush-thread", input.id, { state: "failed", error: "private runtime detail" }, env);
  const failed = await getHushVoiceTurn(turn.id, { device: context, principal: adminPrincipal() }, options);

  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "hush_runtime_failed");
  assert.equal(failed.error.message.includes("private runtime detail"), false);
});

test("Hush never reflects an arbitrary delivery error through its durable failure state", async () => {
  const env = await testEnv("dispatch-error");
  await createHushThread("hush-thread", env);
  const context = device("phone-a", "hush-thread");
  const options = {
    env,
    dependencies: dependencies(),
  };
  options.dependencies.requestThreadInputDelivery = () => {
    throw new Error("private scheduler failure: internal host detail");
  };
  const turn = await createTurn({
    env,
    deviceContext: context,
    clientTurnId: "77777777-7777-4777-8777-777777777777",
    transcript: "Run the task",
    dependencies: options.dependencies,
  });
  let failed;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    failed = await getHushVoiceTurn(turn.id, { device: context, principal: adminPrincipal() }, options);
    if (failed.status === "failed") break;
  }

  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "hush_turn_failed");
  assert.equal(JSON.stringify(failed).includes("internal host detail"), false);
});

test("Hush requires a complete verified device context and speaks markdown deterministically", () => {
  assert.throws(
    () => hushMobileDeviceContext({ orkestrMachineAuth: HUSH_MOBILE_MACHINE_AUTH, orkestrMachineAuthContext: {} }),
    /mobile_device_auth_required/,
  );
  assert.deepEqual(hushMobileDeviceContext({
    orkestrMachineAuth: HUSH_MOBILE_MACHINE_AUTH,
    orkestrMachineAuthContext: {
      principalKind: HUSH_MOBILE_MACHINE_AUTH,
      routeKind: HUSH_MOBILE_ROUTE_KIND,
      deviceId: "phone-a",
      profileId: "hush-default",
      threadId: "server-selected-thread",
      ownerUserId: "admin",
    },
  }), device("phone-a", "server-selected-thread"));
  assert.equal(hushSpeech("Use ```const x = 1;``` then visit https://example.test/a."), "Use Code is shown in the text response. then visit link");
});
