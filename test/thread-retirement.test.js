import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { resetThreadSummaryCachesForTest, threadSummaryPayload } from "../apps/server/src/thread-summary.ts";
import { runNextThreadMessage } from "../packages/core/src/executors.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { wakeThread } from "../packages/core/src/runtime-leases.js";
import { retireThread, restoreRetiredThread } from "../packages/core/src/thread-retirement.js";
import { readThreadResourcePolicy, registerThreadResource, setThreadResourceGrants } from "../packages/core/src/thread-resource-grants.js";
import { authorizeIssuedConnectorResourceToken, issueConnectorMcpResourceToken } from "../packages/core/src/thread-resource-sessions.js";
import { createTimer, listTimers } from "../packages/core/src/timers.js";
import { createThread, enqueueThreadInput, getThread, listThreadMessages } from "../packages/core/src/threads.js";

const envKeys = ["ORKESTR_HOME", "ORKESTR_AUTH_REQUIRED", "ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED", "ORKESTR_WHATSAPP_AUTOSTART", "WHATSAPP_LOCAL_AUTOSTART"];

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function rejectsRetired(operation) {
  await assert.rejects(operation, (error) => error?.statusCode === 410 && error?.code === "thread_retired");
}

test("thread retirement hides by default, cancels queued work, and fences replay", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-retirement-"));
  const prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "0";
  process.env.ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED = "1";
  process.env.ORKESTR_WHATSAPP_AUTOSTART = "0";
  process.env.WHATSAPP_LOCAL_AUTOSTART = "0";
  resetThreadSummaryCachesForTest();
  try {
    await createThread({
      id: "retire-worker",
      name: "ORK-399 worker",
      state: "sleeping",
      binding: { connector: "whatsapp", chatId: "group-retire@g.us", enabled: true, routeEligible: true },
      resourceGrants: [{ resourceType: "desktop", resourceId: "desktop-retire" }],
      desktopGrants: [{ slug: "desktop-retire" }],
    });
    await enqueueThreadInput("retire-worker", { text: "do not run", source: "test", clientMessageId: "retire-input" });
    const principal = adminPrincipal("admin");
    const resource = await registerThreadResource({ resourceType: "oxrm", resourceId: "retire-crm", ownerUserId: "admin", status: "active" }, { principal });
    await setThreadResourceGrants("retire-worker", "oxrm", [{ resourceId: "retire-crm", permissions: ["read"] }], { principal });
    const issuedResourceToken = await issueConnectorMcpResourceToken({
      resourceType: "oxrm",
      resourceId: resource.resource.id,
      resourceAction: "read",
      threadId: "retire-worker",
      principal,
      service: "test-connector",
      connectorMcpTool: "test-tool",
      connectorMcpAction: "read",
    });
    const timer = await createTimer({
      label: "Retire timer",
      targetType: "thread",
      target: "retire-worker",
      cadence: "daily",
      time: "09:00",
      prompt: "do not run",
      enabled: true,
    });

    const retired = await retireThread("retire-worker", { actorUserId: "admin", reason: "completed_work" });
    assert.equal(retired.ok, true);
    assert.equal(retired.cancelledMessages, 1);
    assert.equal(retired.disabledTimers, 1);
    const stored = await getThread("retire-worker");
    assert.equal(stored.state, "retired");
    assert.equal(stored.wakePolicy, "manual");
    assert.equal(stored.binding.enabled, false);
    assert.equal(stored.binding.routeEligible, false);
    assert.equal(stored.binding.retired, true);
    assert.deepEqual(stored.resourceGrants, []);
    assert.deepEqual(stored.desktopGrants, []);
    const policy = await readThreadResourcePolicy();
    assert.equal(policy.policies.find((item) => item.threadId === "retire-worker" && item.resourceType === "oxrm")?.explicitEmpty, true);
    assert.equal(policy.resourceSessions.find((item) => item.threadId === "retire-worker")?.state, "invalidated");
    assert.equal(await authorizeIssuedConnectorResourceToken(issuedResourceToken.token), null);
    assert.equal((await listTimers()).find((entry) => entry.id === timer.id).enabled, false);
    assert.equal((await listThreadMessages("retire-worker"))[0].state, "cancelled");

    const defaultSummary = await threadSummaryPayload({ cacheTtlMs: 0, payloadCacheTtlMs: 0 });
    assert.equal(defaultSummary.threads.some((thread) => thread.id === "retire-worker"), false);
    const archivedSummary = await threadSummaryPayload({ cacheTtlMs: 0, payloadCacheTtlMs: 0, includeRetired: true });
    const archived = archivedSummary.threads.find((thread) => thread.id === "retire-worker");
    assert.equal(archived.state, "retired");
    assert.equal(archived.routeEligible, false);
    assert.equal(archived.retiredBy, "admin");

    await rejectsRetired(() => enqueueThreadInput("retire-worker", { text: "replay", source: "test" }));
    await rejectsRetired(() => wakeThread("retire-worker", { reason: "replay" }));
    await rejectsRetired(() => runNextThreadMessage("retire-worker"));

    const restored = await restoreRetiredThread("retire-worker", { actorUserId: "admin" });
    assert.equal(restored.ok, true);
    assert.equal(restored.thread.state, "sleeping");
    assert.equal(restored.thread.wakePolicy, "manual");
    assert.equal(restored.thread.binding.enabled, false);
    assert.equal((await listTimers()).find((entry) => entry.id === timer.id).enabled, false);
    await assert.rejects(
      () => issueConnectorMcpResourceToken({
        resourceType: "oxrm",
        resourceId: resource.resource.id,
        resourceAction: "read",
        threadId: "retire-worker",
        principal,
        service: "test-connector",
        connectorMcpTool: "test-tool",
        connectorMcpAction: "read",
      }),
      /connector_mcp_resource_grant_required/,
    );
    await enqueueThreadInput("retire-worker", { text: "manual restore input", source: "test" });
    assert.equal((await listThreadMessages("retire-worker")).at(-1).state, "queued");
  } finally {
    resetThreadSummaryCachesForTest();
    restoreEnv(prior);
  }
});

test("thread retirement API defaults to hidden records and supports an archived restore", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-retirement-api-"));
  const prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "0";
  process.env.ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED = "1";
  process.env.ORKESTR_WHATSAPP_AUTOSTART = "0";
  process.env.WHATSAPP_LOCAL_AUTOSTART = "0";
  resetThreadSummaryCachesForTest();
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await createThread({ id: "retire-api", name: "Retire API", state: "sleeping" });
    const retireResponse = await fetch(`${baseUrl}/api/threads/retire-api/retire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "completed_work" }),
    });
    assert.equal(retireResponse.status, 200);
    assert.equal((await retireResponse.json()).thread.state, "retired");

    const activeResponse = await fetch(`${baseUrl}/api/threads`);
    assert.equal((await activeResponse.json()).threads.some((thread) => thread.id === "retire-api"), false);
    const archivedResponse = await fetch(`${baseUrl}/api/threads?includeRetired=true`);
    assert.equal((await archivedResponse.json()).threads.some((thread) => thread.id === "retire-api"), true);

    const deniedResponse = await fetch(`${baseUrl}/api/threads/retire-api/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "blocked", autoRun: false }),
    });
    assert.equal(deniedResponse.status, 410);
    assert.equal((await deniedResponse.json()).error, "thread_retired");

    const restoreResponse = await fetch(`${baseUrl}/api/threads/retire-api/restore`, { method: "POST" });
    assert.equal(restoreResponse.status, 200);
    assert.equal((await restoreResponse.json()).thread.state, "sleeping");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    resetThreadSummaryCachesForTest();
    restoreEnv(prior);
  }
});
