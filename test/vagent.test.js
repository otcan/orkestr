import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processVagentRequest, vagentSpeech, waitForVagentFinal } from "../packages/core/src/vagent-runtime.js";
import { vagentWebhookSchema } from "../packages/shared/src/api-schemas.js";
import { parseThreadInputCommand } from "../packages/core/src/thread-commands.js";

async function home(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `orkestr-vagent-${label}-`));
}

function request(authorization = "") {
  return {
    method: "POST",
    url: "/api/integrations/vagent",
    originalUrl: "/api/integrations/vagent",
    headers: { authorization, host: "127.0.0.1:19812" },
    socket: { remoteAddress: "127.0.0.1" },
  };
}

function serviceEnvironment(overrides = {}) {
  return {
    ORKESTR_VAGENT_ENABLED: "1",
    ORKESTR_VAGENT_THREAD_ID: "configured-thread",
    ORKESTR_VAGENT_TIMEOUT_MS: "1000",
    ...overrides,
  };
}

function serviceDependencies(overrides = {}) {
  return {
    appendEvent: async (event) => event,
    enqueueThreadInputForPrincipal: async () => ({ id: "input" }),
    getThread: async () => ({ id: "configured-thread" }),
    getThreadForPrincipal: async () => ({ id: "configured-thread" }),
    listThreadMessages: async () => [],
    now: () => 0,
    processApiAgentThreadInput: async () => ({}),
    requestThreadInputDelivery: () => {},
    sleep: async () => {},
    threadUsesApiAgent: () => false,
    ...overrides,
  };
}

test("Vagent machine authentication is enabled only for its exact POST route and compares the raw Authorization value", async (t) => {
  let authorizeHttpRequest;
  try {
    ({ authorizeHttpRequest } = await import("../packages/core/src/security.js"));
  } catch (error) {
    // Some lightweight development worktrees omit optional runtime packages.
    // CI and production installs resolve the real security module normally.
    t.skip(`security module dependencies unavailable: ${error.code || error.message}`);
    return;
  }
  const env = {
    ORKESTR_HOME: await home("auth"),
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_VAGENT_ENABLED: "1",
    ORKESTR_VAGENT_AUTH_TOKEN: "vagent-very-secret",
  };
  assert.equal((await authorizeHttpRequest(request(), env)).error, "vagent_auth_required");
  assert.equal((await authorizeHttpRequest(request("wrong"), env)).error, "vagent_auth_invalid");

  const allowed = await authorizeHttpRequest(request("vagent-very-secret"), env);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.machineAuth, "vagent");
  assert.equal(allowed.principal.source, "vagent");
  assert.deepEqual(allowed.machineAuthContext.scopes, ["thread:input", "thread:read"]);

  const bearerConfigured = await authorizeHttpRequest(
    request("Bearer explicitly-configured-value"),
    { ...env, ORKESTR_VAGENT_AUTH_TOKEN: "Bearer explicitly-configured-value" },
  );
  assert.equal(bearerConfigured.ok, true);

  const disabled = await authorizeHttpRequest(request("vagent-very-secret"), {
    ...env,
    ORKESTR_VAGENT_ENABLED: "0",
  });
  assert.equal(disabled.error, "vagent_integration_disabled");
  assert.equal(disabled.statusCode, 404);

  const otherRoute = await authorizeHttpRequest({ ...request("vagent-very-secret"), url: "/api/threads", originalUrl: "/api/threads" }, env);
  assert.equal(otherRoute.machineAuth, undefined);
});

test("Vagent webhook schema has a closed nested payload and no client-selected routing", () => {
  const payload = vagentWebhookSchema.body;
  assert.deepEqual(payload.required, ["body"]);
  assert.equal(payload.additionalProperties, false);
  assert.deepEqual(payload.properties.body.required, ["prompt", "sessionID"]);
  assert.equal(payload.properties.body.additionalProperties, false);
  assert.equal(payload.properties.body.properties.prompt.maxLength, 50000);
  assert.equal("threadId" in payload.properties.body.properties, false);
});

test("Vagent sends normal fixed-thread input and returns only the exact parent-linked final", async () => {
  const messages = [];
  const events = [];
  const enqueued = [];
  const delivery = [];
  const result = await processVagentRequest({
    prompt: "Tell me the deployment status.",
    sessionId: "voice-session-1",
    principal: { userId: "admin", role: "admin" },
  }, {
    env: serviceEnvironment(),
    dependencies: serviceDependencies({
      appendEvent: async (event) => { events.push(event); return event; },
      getThread: async (id) => id === "configured-thread" ? { id } : null,
      getThreadForPrincipal: async () => ({ id: "configured-thread", runtimeKind: "codex-app-server" }),
      enqueueThreadInputForPrincipal: async (_threadId, input) => {
        enqueued.push(input);
        return { id: "voice-user-message" };
      },
      requestThreadInputDelivery: (threadId) => {
        delivery.push(threadId);
        messages.push({
          id: "other-final",
          role: "assistant",
          state: "completed",
          phase: "final_answer",
          parentMessageId: "another-user-message",
          text: "Wrong concurrent answer",
        }, {
          id: "voice-final",
          role: "assistant",
          state: "completed",
          phase: "final_answer",
          parentMessageId: "voice-user-message",
          text: "Deployment is healthy.\n\nDetails: `server.ts` https://example.test/status",
        });
      },
      listThreadMessages: async () => messages,
      threadUsesApiAgent: () => false,
    }),
  });

  assert.deepEqual(delivery, ["configured-thread"]);
  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0], {
    source: "vagent",
    text: "Tell me the deployment status.",
    externalId: "voice-session-1",
    attachments: [],
    commandProcessing: "disabled",
  });
  assert.equal(result.response.text, "Deployment is healthy.\n\nDetails: `server.ts` https://example.test/status");
  assert.equal(result.response.speech, "Deployment is healthy. Details: server.ts link");
  assert.ok(events.some((event) => event.type === "vagent_input_enqueued"));
  assert.ok(events.some((event) => event.type === "vagent_final_received" && event.finalMessageId === "voice-final"));
  assert.ok(events.every((event) => !("sessionId" in event)));
});

test("concurrent Vagent waiters cannot receive each other's final answer", async () => {
  const messages = [];
  const resolvers = [];
  const dependencies = {
    listThreadMessages: async () => messages,
    now: () => 0,
    sleep: async () => new Promise((resolve) => resolvers.push(resolve)),
  };
  const first = waitForVagentFinal("thread", "input-a", 1000, dependencies, {});
  const second = waitForVagentFinal("thread", "input-b", 1000, dependencies, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolvers.length, 2);

  messages.push({ id: "final-b", role: "assistant", state: "completed", phase: "final_answer", parentMessageId: "input-b", text: "B" });
  resolvers.splice(0).forEach((resolve) => resolve());
  assert.equal((await second).id, "final-b");

  messages.push({ id: "final-a", role: "assistant", state: "completed", phase: "final_answer", parentMessageId: "input-a", text: "A" });
  resolvers.splice(0).forEach((resolve) => resolve());
  assert.equal((await first).id, "final-a");
});

test("Vagent timeout keeps the asynchronous thread running and API-agent threads use the synchronous processor", async () => {
  let now = 0;
  let scheduled = 0;
  const timeout = await processVagentRequest({
    prompt: "Long running task",
    sessionId: "session-timeout",
    principal: { userId: "admin", role: "admin" },
  }, {
    env: serviceEnvironment(),
    dependencies: serviceDependencies({
      appendEvent: async () => ({}),
      getThread: async () => ({ id: "configured-thread" }),
      getThreadForPrincipal: async () => ({ id: "configured-thread" }),
      enqueueThreadInputForPrincipal: async () => ({ id: "long-input" }),
      requestThreadInputDelivery: () => { scheduled += 1; },
      listThreadMessages: async () => [],
      threadUsesApiAgent: () => false,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    }),
  });
  assert.equal(scheduled, 1);
  assert.match(timeout.response.text, /still running/);

  const messages = [];
  let apiProcessed = 0;
  const apiResult = await processVagentRequest({
    prompt: "Quick API task",
    sessionId: "session-api",
    principal: { userId: "admin", role: "admin" },
  }, {
    env: serviceEnvironment(),
    dependencies: serviceDependencies({
      appendEvent: async () => ({}),
      getThread: async () => ({ id: "configured-thread" }),
      getThreadForPrincipal: async () => ({ id: "configured-thread", runtimeKind: "api-agent" }),
      enqueueThreadInputForPrincipal: async () => ({ id: "api-input" }),
      threadUsesApiAgent: () => true,
      processApiAgentThreadInput: async () => {
        apiProcessed += 1;
        messages.push({ id: "api-final", role: "assistant", state: "completed", phase: "final_answer", parentMessageId: "api-input", text: "API reply" });
      },
      requestThreadInputDelivery: () => { throw new Error("Codex delivery must not run for API agent"); },
      listThreadMessages: async () => messages,
    }),
  });
  assert.equal(apiProcessed, 1);
  assert.equal(apiResult.response.text, "API reply");
});

test("Vagent speech formatter removes code and links without a second model call", () => {
  assert.equal(vagentSpeech("Use ```const x = 1;``` then visit https://example.test/a."), "Use Code is shown in the text response. then visit link");
  assert.equal(vagentSpeech(""), "The response is available on screen.");
});

test("Vagent disables privileged slash-command processing while retaining the spoken text", () => {
  assert.deepEqual(parseThreadInputCommand({ text: "/stop", commandProcessing: "disabled" }), {
    command: null,
    text: "/stop",
  });
  assert.equal(parseThreadInputCommand({ text: "/stop" }).command, "stop");
});
