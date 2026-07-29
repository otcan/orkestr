import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { createGoogleWorkspaceReviewEnvironmentLink } from "../packages/connectors/src/google-workspace-review-environment.js";

const envKeys = [
  "ORKESTR_HOME",
  "ORKESTR_OVERLAY_DIR",
  "ORKESTR_AUTH_REQUIRED",
  "ORKESTR_CONNECT_PUBLIC_URL",
  "ORKESTR_GOOGLE_WORKSPACE_REVIEW_PUBLIC_URL",
  "ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_ENABLED",
  "ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET",
  "ORKESTR_GOOGLE_WORKSPACE_REVIEW_ENV_TTL_MINUTES",
  "ORKESTR_GOOGLE_WORKSPACE_REVIEW_PASSWORD",
  "ORKESTR_GOOGLE_WORKSPACE_REVIEW_USER_ID",
  "ORKESTR_GOOGLE_WORKSPACE_REVIEW_THREAD_ID",
];

function snapshotEnv() {
  return Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("reviewer environment is pairing-free but ticket-scoped and can create its OAuth link", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-review-http-"));
  const prior = snapshotEnv();
  process.env.ORKESTR_HOME = home;
  delete process.env.ORKESTR_OVERLAY_DIR;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_PUBLIC_URL = "https://review.example.test";
  process.env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_ENABLED = "1";
  process.env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET = "review-access-secret-for-isolated-google-verification";
  process.env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ENV_TTL_MINUTES = "30";
  process.env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_PASSWORD = "a-long-review-password-for-isolated-oauth";
  process.env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_USER_ID = "reviewer";
  process.env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_THREAD_ID = "review-thread";
  const review = createGoogleWorkspaceReviewEnvironmentLink({ userId: "reviewer", threadId: "review-thread" }, process.env);
  const entryPath = new URL(review.link).pathname;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const root = `http://127.0.0.1:${port}`;

  try {
    const entry = await fetch(`${root}${entryPath}`, { redirect: "manual" });
    const entryHtml = await entry.text();
    assert.equal(entry.status, 200);
    assert.match(entryHtml, /Review password/);

    const rejected = await fetch(`${root}${entryPath}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
      redirect: "manual",
    });
    assert.equal(rejected.status, 403);

    const signedIn = await fetch(`${root}${entryPath}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "a-long-review-password-for-isolated-oauth" }),
      redirect: "manual",
    });
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.get("location"), "/review/google/session");
    const sessionCookie = (signedIn.headers.get("set-cookie") || "").split(";")[0];
    assert.match(sessionCookie, /^orkestr_google_workspace_review=/);

    const freshSession = await fetch(`${root}/review/google/session`, { headers: { cookie: sessionCookie }, redirect: "manual" });
    assert.equal(freshSession.status, 302);
    const pathName = freshSession.headers.get("location") || "";
    assert.match(pathName, /^\/review\/google\/[^/]+$/);

    const page = await fetch(`${root}${pathName}`, { redirect: "manual" });
    const pageHtml = await page.text();
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(pageHtml, /Google Workspace review/);
    assert.match(pageHtml, /Connect Google/);
    assert.match(pageHtml, /Send Gmail message/);
    assert.match(pageHtml, /Review tasks/);
    assert.match(pageHtml, /Action log/);
    assert.doesNotMatch(pageHtml, /<ork-root(?:\s|>)/);

    const status = await fetch(`${root}${pathName}/status`);
    const statusPayload = await status.json();
    assert.equal(status.status, 200);
    assert.equal(statusPayload.ok, true);
    assert.deepEqual(statusPayload.connections, []);

    const connect = await fetch(`${root}${pathName}/connect`, { method: "POST" });
    const connectPayload = await connect.json();
    assert.equal(connect.status, 200);
    assert.equal(connectPayload.ok, true);
    const connectUrl = new URL(connectPayload.connectUrl, root);
    assert.match(connectUrl.pathname, /^\/connect\/google\/review\/[^/]+\/[^/]+$/);
    assert.ok(connectUrl.searchParams.get("review_environment"));

    const loggedStatus = await fetch(`${root}${pathName}/status`);
    const loggedStatusPayload = await loggedStatus.json();
    assert.equal(loggedStatusPayload.actions[0].action, "google_connect_requested");

    const connectPage = await fetch(`${root}${connectUrl.pathname}${connectUrl.search}`);
    const connectHtml = await connectPage.text();
    assert.equal(connectPage.status, 200);
    assert.match(connectHtml, /name="review_environment"/);

    const operation = await fetch(`${root}${pathName}/gmail/messages`);
    const operationPayload = await operation.json();
    assert.equal(operation.status, 403);
    assert.equal(operationPayload.error, "google_workspace_not_connected");

    const unconfirmedSend = await fetch(`${root}${pathName}/gmail/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "reviewer@example.test", subject: "test", body: "test" }),
    });
    const unconfirmedSendPayload = await unconfirmedSend.json();
    assert.equal(unconfirmedSend.status, 400);
    assert.equal(unconfirmedSendPayload.error, "google_workspace_review_send_confirmation_required");

    const invalid = await fetch(`${root}/review/google/invalid-ticket`, { redirect: "manual" });
    assert.equal(invalid.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});
