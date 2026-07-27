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
  const review = createGoogleWorkspaceReviewEnvironmentLink({ userId: "reviewer", threadId: "review-thread" }, process.env);
  const pathName = new URL(review.link).pathname;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const root = `http://127.0.0.1:${port}`;

  try {
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
    assert.equal(connectUrl.searchParams.get("review_environment"), review.ticket);

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
