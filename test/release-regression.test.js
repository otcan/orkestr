import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseReleaseRegressionArgs,
  runReleaseRegression,
} from "../scripts/release-regression.mjs";

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function routeFromUrl(url) {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function fakeFetch(routes, calls = []) {
  return async (url, options = {}) => {
    const route = routeFromUrl(url);
    calls.push({ route, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    const handler = routes[`${options.method || "GET"} ${route}`] || routes[route];
    if (!handler) return jsonResponse(404, { error: `missing test route ${route}` });
    const result = typeof handler === "function" ? await handler({ url, options, route }) : handler;
    return jsonResponse(result.status || 200, result.payload ?? result);
  };
}

function healthyRoutes(extra = {}) {
  return {
    "/api/version": { name: "orkestr-oss", version: "0.1.0-test", releaseId: "test-release" },
    "/api/ready": { ok: true },
    "/api/setup/status": {
      setupState: "ready",
      connectors: [
        { id: "codex", state: "connected" },
        { id: "whatsapp", state: "connected" },
        { id: "browsers", state: "connected" },
        { id: "timers", state: "connected" },
      ],
    },
    "/api/threads?scope=all": { threads: [{ id: "test-thread", state: "ready" }] },
    "/api/connectors/whatsapp/status": { state: "paired", health: { ready: true }, accounts: [{ accountId: "test", ready: true }] },
    "/api/browser-sessions": { ok: true, sessions: [{ slug: "linkedin", status: "active" }] },
    ...extra,
  };
}

test("release regression args parse named targets and default artifact root", () => {
  const options = parseReleaseRegressionArgs([
    "--target",
    "local=http://127.0.0.1:19812",
    "--target",
    "remote=https://example.invalid/",
    "--desktop-slug",
    "linkedin",
  ], {
    ORKESTR_HOME: "/tmp/orkestr-home",
    ORKESTR_RELEASE_ID: "release-1",
  });

  assert.deepEqual(options.targets, [
    { name: "local", baseUrl: "http://127.0.0.1:19812" },
    { name: "remote", baseUrl: "https://example.invalid" },
  ]);
  assert.equal(options.desktopSlug, "linkedin");
  assert.equal(options.artifactDir, "/tmp/orkestr-home/release-checks/release-1");
});

test("release regression runner records passing target artifacts without real chat sends", async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-release-regression-"));
  const calls = [];
  const summary = await runReleaseRegression({
    releaseId: "release-1",
    artifactDir,
    targets: [{ name: "local", baseUrl: "http://127.0.0.1:19812" }],
    timeoutMs: 100,
    pollMs: 100,
    headers: {},
    execute: false,
    desktopSlug: "linkedin",
  }, {
    fetch: fakeFetch(healthyRoutes(), calls),
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.targets[0].scenarios.find((item) => item.name === "chat-injection").reason, "requires_--execute");
  assert.equal(calls.some((call) => call.method === "POST"), false);
  const summaryArtifact = JSON.parse(await fs.readFile(path.join(artifactDir, "summary.json"), "utf8"));
  assert.equal(summaryArtifact.ok, true);
  await fs.access(path.join(artifactDir, "local", "whatsapp-readiness.json"));
});

test("release regression runner fails when WhatsApp is not ready", async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-release-regression-"));
  const summary = await runReleaseRegression({
    releaseId: "release-1",
    artifactDir,
    targets: [{ name: "local", baseUrl: "http://127.0.0.1:19812" }],
    timeoutMs: 100,
    pollMs: 100,
    headers: {},
    execute: false,
  }, {
    fetch: fakeFetch(healthyRoutes({
      "/api/connectors/whatsapp/status": { state: "not_connected", health: { ready: false }, accounts: [] },
    })),
  });

  assert.equal(summary.ok, false);
  const whatsapp = summary.targets[0].scenarios.find((item) => item.name === "whatsapp-readiness");
  assert.equal(whatsapp.ok, false);
  assert.match(whatsapp.error, /not ready/);
});

test("release regression execute mode verifies submitted chat input is visible", async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-release-regression-"));
  const calls = [];
  const message = "ORK RELEASE REGRESSION CHECK: reply exactly OK";
  const expect = "OK";
  const routes = healthyRoutes({
    "POST /api/threads/test-thread/input": ({ options }) => ({
      ok: true,
      message: { id: "message-1", text: JSON.parse(options.body).text },
    }),
    "/api/threads/test-thread/messages?limit=20": {
      messages: [
        { role: "user", text: message },
        { role: "assistant", text: expect },
      ],
    },
  });

  const summary = await runReleaseRegression({
    releaseId: "release-1",
    artifactDir,
    targets: [{ name: "local", baseUrl: "http://127.0.0.1:19812" }],
    timeoutMs: 100,
    pollMs: 100,
    headers: {},
    execute: true,
    threadId: "test-thread",
    message,
    expect,
  }, {
    fetch: fakeFetch(routes, calls),
  });

  assert.equal(summary.ok, true);
  assert.ok(calls.some((call) => call.method === "POST" && call.route === "/api/threads/test-thread/input"));
  assert.equal(calls.find((call) => call.method === "POST")?.body.text, message);
  assert.equal(summary.targets[0].scenarios.find((item) => item.name === "chat-injection").status, "pass");
});

test("release regression can record protected APIs as skipped for public targets", async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-release-regression-"));
  const routes = healthyRoutes({
    "/api/threads?scope=all": { status: 403, payload: { error: "pairing_required" } },
    "/api/connectors/whatsapp/status": { status: 403, payload: { error: "pairing_required" } },
    "/api/browser-sessions": { status: 403, payload: { error: "pairing_required" } },
  });

  const summary = await runReleaseRegression({
    releaseId: "release-1",
    artifactDir,
    targets: [{ name: "remote", baseUrl: "https://example.invalid" }],
    timeoutMs: 100,
    pollMs: 100,
    headers: {},
    execute: false,
    allowAuthBlocked: true,
  }, {
    fetch: fakeFetch(routes),
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.targets[0].scenarios.find((item) => item.name === "thread-summary").reason, "auth_required");
  assert.equal(summary.targets[0].scenarios.find((item) => item.name === "whatsapp-readiness").status, "skip");
});
