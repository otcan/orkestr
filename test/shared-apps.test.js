import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { startServer } from "../apps/server/src/server.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";
import { createAppShare } from "../packages/core/src/shared-apps.js";
import { adminPrincipal } from "../packages/core/src/principal.js";

async function readJson(response) {
  return response.json();
}

function saveEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function rejectedWebSocket(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("websocket_rejection_timeout"));
    }, 5000);
    ws.on("open", () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("websocket_unexpectedly_opened"));
    });
    ws.on("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      resolve({ statusCode: response.statusCode, statusMessage: response.statusMessage || "" });
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      resolve({ statusCode: 0, error: String(error?.message || error) });
    });
  });
}

test("shared app URL creates scoped pairing and limits the approved session", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-shared-apps-"));
  const prior = saveEnv(["ORKESTR_HOME", "ORKESTR_AUTH_REQUIRED", "ORKESTR_RECOVER_RUNNING_ON_START"]);
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const principal = adminPrincipal({ id: "admin", displayName: "Admin" });
  const first = await createAppShare("main", "outreach-review", {
    shareToken: "share-one",
    title: "Outreach Review",
    filtersJson: {
      people: [{
        id: "betul",
        name: "Betul Y.",
        profileUrl: "https://example.test/in/betul",
        messageHistory: [{ id: "m1", from: "assistant", text: "Hello Betul" }],
      }],
    },
  }, { principal: principal, env: process.env });
  const second = await createAppShare("main", "outreach-review", {
    shareToken: "share-two",
    filtersJson: { people: [{ id: "hilal", name: "Hilal O." }] },
  }, { principal, env: process.env });
  const expired = await createAppShare("main", "outreach-review", {
    shareToken: "expired-share",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  }, { principal, env: process.env });
  assert.equal(first.share.shareToken, "share-one");
  assert.equal(second.share.shareToken, "share-two");
  assert.equal(expired.share.shareToken, "expired-share");

  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const invalid = await fetch(`${baseUrl}/i/main/a/outreach-review/s/not-real`, { redirect: "manual" });
    assert.equal(invalid.status, 404);
    assert.match(await invalid.text(), /Share unavailable/);

    const expiredResponse = await fetch(`${baseUrl}/i/main/a/outreach-review/s/expired-share`, { redirect: "manual" });
    assert.equal(expiredResponse.status, 403);
    assert.match(await expiredResponse.text(), /expired/);

    const open = await fetch(`${baseUrl}/i/main/a/outreach-review/s/share-one`, { redirect: "manual" });
    assert.equal(open.status, 200);
    assert.equal(open.headers.get("location"), null);
    assert.match(await open.text(), /<ork-root/);

    const unauthData = await fetch(`${baseUrl}/api/shared-apps/i/main/a/outreach-review/s/share-one`);
    assert.equal(unauthData.status, 401);
    assert.equal((await readJson(unauthData)).error, "browser_pairing_required");

    const createdChallenge = await readJson(await fetch(`${baseUrl}/api/shared-apps/i/main/a/outreach-review/s/share-one/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestedPath: "/i/main/a/outreach-review/s/share-one" }),
    }));
    assert.equal(createdChallenge.ok, true);
    const challengeId = createdChallenge.challengeId;
    assert.ok(challengeId);
    assert.equal(createdChallenge.challenge.instanceId, "main");
    assert.equal(createdChallenge.challenge.appSlug, "outreach-review");
    assert.equal(createdChallenge.challenge.shareId, first.share.id);
    assert.equal(createdChallenge.challenge.requestedPath, "/i/main/a/outreach-review/s/share-one");

    const repeatedChallenge = await readJson(await fetch(`${baseUrl}/api/shared-apps/i/main/a/outreach-review/s/share-one/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestedPath: "/i/main/a/outreach-review/s/share-one" }),
    }));
    assert.equal(repeatedChallenge.challengeId, challengeId);
    assert.equal(repeatedChallenge.reused, true);

    await approvePairingChallenge(challengeId, { approvedBy: "node:test", env: process.env });
    const approvedChallenge = await readJson(await fetch(`${baseUrl}/api/shared-apps/i/main/a/outreach-review/s/share-one/challenges/${encodeURIComponent(challengeId)}`));
    assert.equal(approvedChallenge.challenge.status, "approved");

    const pair = await fetch(`${baseUrl}/api/shared-apps/i/main/a/outreach-review/s/share-one/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId }),
    });
    assert.equal(pair.status, 200);
    const cookie = pair.headers.get("set-cookie") || "";
    const paired = await readJson(pair.clone());
    assert.equal(paired.session.instanceId, "main");
    assert.equal(paired.session.appSlug, "outreach-review");
    assert.equal(paired.session.shareId, first.share.id);
    assert.deepEqual(paired.session.allowedActions, ["setClassification"]);
    assert.equal(paired.redirectPath, "/i/main/a/outreach-review/s/share-one");

    const html = await fetch(`${baseUrl}/i/main/a/outreach-review/s/share-one`, { headers: { cookie } });
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<ork-root/);

    const data = await readJson(await fetch(`${baseUrl}/api/shared-apps/i/main/a/outreach-review/s/share-one`, { headers: { cookie } }));
    assert.equal(data.app.appType, "people-message-labeling");
    assert.equal(data.data.people[0].id, "betul");
    assert.equal(data.data.people[0].currentClassification, "not_evaluated");

    const update = await readJson(await fetch(`${baseUrl}/api/shared-apps/i/main/a/outreach-review/s/share-one/actions/setClassification`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ personId: "betul", classification: "to_contact" }),
    }));
    assert.equal(update.personId, "betul");
    assert.equal(update.classification, "to_contact");
    assert.equal(update.data.people[0].currentClassification, "to_contact");

    const after = await readJson(await fetch(`${baseUrl}/api/shared-apps/i/main/a/outreach-review/s/share-one`, { headers: { cookie } }));
    assert.equal(after.data.people[0].currentClassification, "to_contact");

    const otherShare = await fetch(`${baseUrl}/api/shared-apps/i/main/a/outreach-review/s/share-two`, { headers: { cookie } });
    assert.equal(otherShare.status, 403);
    assert.equal((await readJson(otherShare)).error, "shared_app_session_scope_denied");

    const normalApi = await fetch(`${baseUrl}/api/threads`, { headers: { cookie } });
    assert.equal(normalApi.status, 403);
    assert.equal((await readJson(normalApi)).error, "shared_app_session_scope_denied");

    const summaryStream = await rejectedWebSocket(`ws://127.0.0.1:${port}/api/threads/summary/stream`, { cookie });
    assert.equal(summaryStream.statusCode, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(prior);
  }
});
