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
  "ORKESTR_GOOGLE_OAUTH_ALLOWED_CAPABILITIES",
  "ORKESTR_GOOGLE_OAUTH_APPS_JSON",
  "ORKESTR_GOOGLE_OAUTH_DEFAULT_APP",
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

test("reviewer password opens the normal isolated Orkestr UI", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-google-review-http-"));
  const prior = snapshotEnv();
  process.env.ORKESTR_HOME = home;
  delete process.env.ORKESTR_OVERLAY_DIR;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_CONNECT_PUBLIC_URL = "http://127.0.0.1";
  process.env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_PUBLIC_URL = "https://review.example.test";
  process.env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_ENABLED = "1";
  process.env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET = "review-access-secret-for-isolated-google-verification";
  process.env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ENV_TTL_MINUTES = "30";
  process.env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_PASSWORD = "a-long-review-password-for-isolated-oauth";
  process.env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_USER_ID = "reviewer";
  process.env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_THREAD_ID = "review-thread";
  process.env.ORKESTR_GOOGLE_OAUTH_ALLOWED_CAPABILITIES = "gmail_read,gmail_send,gmail_drafts,calendar_read,calendar_actions";
  process.env.ORKESTR_GOOGLE_OAUTH_DEFAULT_APP = "reviewer";
  process.env.ORKESTR_GOOGLE_OAUTH_APPS_JSON = JSON.stringify({
    reviewer: {
      clientId: "reviewer-client",
      clientSecret: "reviewer-secret",
      redirectUri: "https://review.example.test/oauth/gmail/callback",
    },
  });
  const review = createGoogleWorkspaceReviewEnvironmentLink({ userId: "reviewer", threadId: "review-thread" }, process.env);
  const entryPath = new URL(review.link).pathname;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const root = `http://127.0.0.1:${port}`;

  try {
    const entry = await fetch(`${root}${entryPath}`, { redirect: "manual" });
    const entryHtml = await entry.text();
    assert.equal(entry.status, 200);
    assert.match(entryHtml, /isolated Orkestr OSS instance/);
    assert.match(entryHtml, /Access password/);
    assert.doesNotMatch(entryHtml, /Review tasks|Action log|Send Gmail message/);

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
    assert.equal(signedIn.headers.get("location"), "/connectors/gmail");
    const sessionCookie = (signedIn.headers.get("set-cookie") || "").split(";")[0];
    assert.match(sessionCookie, /^orkestr_session=/);

    const apiBeforeSignIn = await fetch(`${root}/api/threads`);
    assert.equal(apiBeforeSignIn.status, 401);
    const threads = await fetch(`${root}/api/threads`, { headers: { cookie: sessionCookie } });
    assert.equal(threads.status, 200);
    const threadPayload = await threads.json();
    assert.notEqual(threadPayload?.error, "browser_pairing_required");

    const cockpit = await fetch(`${root}/connectors/gmail`, { headers: { cookie: sessionCookie } });
    const cockpitHtml = await cockpit.text();
    assert.equal(cockpit.status, 200);
    assert.match(cockpitHtml, /<ork-root(?:\s|>)/);

    const oauth = await (await fetch(`${root}/api/connectors/gmail/oauth/start?capabilities=gmail_send`, {
      headers: { cookie: sessionCookie },
    })).json();
    assert.ok(oauth.authorizeUrl, JSON.stringify(oauth));
    const authorizeUrl = new URL(oauth.authorizeUrl);
    assert.deepEqual(oauth.capabilities, [
      "gmail_read",
      "gmail_send",
      "gmail_drafts",
      "calendar_read",
      "calendar_actions",
    ]);
    assert.match(authorizeUrl.searchParams.get("scope") || "", /https:\/\/www\.googleapis\.com\/auth\/calendar\.events/);
    assert.doesNotMatch(authorizeUrl.searchParams.get("scope") || "", /https:\/\/www\.googleapis\.com\/auth\/gmail\.modify/);
    assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "https://review.example.test/oauth/gmail/callback");

    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({
          access_token: "review-access-token",
          refresh_token: "review-refresh-token",
          expires_in: 3600,
          scope: authorizeUrl.searchParams.get("scope") || "",
        }), { headers: { "content-type": "application/json" } });
      }
      if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
        return new Response(JSON.stringify({ emailAddress: "reviewer@example.test" }), { headers: { "content-type": "application/json" } });
      }
      return nativeFetch(url, options);
    };
    try {
      const callback = await nativeFetch(
        `${root}/oauth/gmail/callback?code=review-code&state=${encodeURIComponent(authorizeUrl.searchParams.get("state") || "")}`,
        { headers: { cookie: sessionCookie } },
      );
      const callbackHtml = await callback.text();
      assert.equal(callback.status, 200);
      assert.match(callbackHtml, /Google Workspace connected/);
      assert.match(callbackHtml, /http-equiv="refresh" content="0;url=\/connectors\/gmail"/);
      assert.match(callbackHtml, /href="\/connectors\/gmail"/);
      assert.doesNotMatch(callbackHtml, /\/setup\/gmail/);
    } finally {
      globalThis.fetch = nativeFetch;
    }

    const alreadySignedIn = await fetch(`${root}${entryPath}`, { headers: { cookie: sessionCookie }, redirect: "manual" });
    assert.equal(alreadySignedIn.status, 302);
    assert.equal(alreadySignedIn.headers.get("location"), "/connectors/gmail");

    const oldTicket = await fetch(`${root}/review/google/old-ticket`, { redirect: "manual" });
    assert.equal(oldTicket.status, 302);
    assert.equal(oldTicket.headers.get("location"), "/review/google");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});
