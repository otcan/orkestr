import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setWhatsAppRepairOptionsForTest } from "../dist/server/apps/server/src/modules/connectors/whatsapp-repair-handlers.js";
import { notifyLocalWhatsAppPairingRequired, resetLocalWhatsAppBridgeForTest } from "../packages/connectors/src/whatsapp-local-bridge.js";
import { eventsOfType, findFiles, pairedCookie, rawRequest, startFixtureServer } from "./support/connector-security-fixture.js";

// ORK-513: the WhatsApp repair page and action through the real HTTP server
// with a fake account, stubbed QR artifact, stubbed runtime start and stubbed
// mail transport. No runtime, QR or email leaves the fixture.

const publicHost = "connect.example.test";
const repairPath = "/api/connectors/whatsapp/bridge/repair";
const sendPath = `${repairPath}/send-email`;
const genericRejection = JSON.stringify({ ok: false, error: "repair_request_rejected" });

function repairEnv(extra = {}) {
  return {
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "wa-one,wa-two",
    ORKESTR_WHATSAPP_REPAIR_NOTIFY_EMAIL: "repair-owner@example.test",
    ORKESTR_CONNECT_PUBLIC_SETUP_URL: `https://${publicHost}/setup`,
    ORKESTR_WHATSAPP_REPAIR_SOURCE_LIMIT: "1000",
    ORKESTR_WHATSAPP_REPAIR_ACCOUNT_LIMIT: "1000",
    ...extra,
  };
}

// Stubbed runtime: records every side effect the repair workflow can cause.
function stubRuntime({ ready = false, statusFails = false, startDelay = null } = {}) {
  const calls = { starts: [], mails: [] };
  let qrReady = false;
  const options = {
    getLocalWhatsAppBridgeStatus: async () => {
      if (statusFails) throw new Error("status_offline");
      return { accounts: ["wa-one", "wa-two"].map((accountId) => ({ accountId, ready, state: ready ? "ready" : "qr_required" })) };
    },
    getQrAttachmentPath: async () => (qrReady ? "/nonexistent/fake-qr.png" : ""),
    startLocalWhatsAppAccount: async (accountId, env, startOptions) => {
      calls.starts.push({ accountId, resetRuntime: startOptions.resetRuntime });
      if (startDelay) await startDelay;
      qrReady = true;
    },
    sendGmailMessage: async (message) => {
      calls.mails.push({ to: message.to, attachments: (message.attachments || []).length });
      return { ok: true, message: { id: "fake-sent" } };
    },
  };
  setWhatsAppRepairOptionsForTest(options);
  return calls;
}

async function notificationToken(accountId = "wa-one") {
  const sent = [];
  await resetLocalWhatsAppBridgeForTest(process.env);
  await notifyLocalWhatsAppPairingRequired({ accountId, reason: "qr_required" }, process.env, {
    sendGmailMessage: async (message) => { sent.push(message); return { ok: true }; },
  });
  assert.equal(sent.length, 1);
  const link = sent[0].body.match(/Open repair page: (\S+)/)[1];
  const url = new URL(link);
  assert.equal(url.host, publicHost);
  assert.equal(url.pathname, repairPath);
  assert.equal(url.search.includes("repair="), false, "the intent never travels in the query string");
  return new URLSearchParams(url.hash.slice(1)).get("repair");
}

function send(port, body, { host = publicHost, origin = `http://${host}`, cookie = "", contentType = "application/json" } = {}) {
  return rawRequest(port, {
    method: "POST",
    pathname: sendPath,
    headers: {
      host,
      ...(origin ? { origin } : {}),
      ...(contentType ? { "content-type": contentType } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body,
  });
}

async function withRepairServer(extraEnv, run, options = {}) {
  const fixture = await startFixtureServer(repairEnv(extraEnv), options);
  try {
    return await run(fixture);
  } finally {
    setWhatsAppRepairOptionsForTest(null);
    await fixture.close(options.closeOptions);
  }
}

test("anonymous page is identical for every account and anonymous actions have no side effects", async () => {
  await withRepairServer({ ORKESTR_WHATSAPP_REPAIR_ALERT_THRESHOLD: "3" }, async (fixture) => {
    const calls = stubRuntime();
    const pageFor = async (accountId) => (await rawRequest(fixture.port, { pathname: `${repairPath}?accountId=${accountId}`, headers: { host: publicHost } })).text;
    const configured = await pageFor("wa-one");
    assert.equal(configured, await pageFor("not-a-configured-account"));
    assert.doesNotMatch(configured, /wa-one|repair-owner/);

    const forged = "wri1.wri_0123456789abcdef01234567.bm9uY2U.c2lnbmF0dXJl";
    const attempts = [
      send(fixture.port, { accountId: "wa-one" }),
      send(fixture.port, { accountId: "not-a-configured-account" }),
      send(fixture.port, { intent: forged }),
      send(fixture.port, { intent: "not-a-token" }),
      send(fixture.port, { intent: forged }, { origin: "" }),
      send(fixture.port, { intent: forged }, { origin: "https://attacker.example.test" }),
      send(fixture.port, `intent=${forged}`, { contentType: "application/x-www-form-urlencoded" }),
    ];
    for (const response of await Promise.all(attempts)) {
      assert.equal(response.status, 403);
      assert.equal(response.text, genericRejection);
    }
    assert.deepEqual(calls, { starts: [], mails: [] });
    const rejected = await eventsOfType("whatsapp_repair_request_rejected");
    assert.equal(rejected.length, attempts.length);
    assert.ok(rejected.every((event) => /^[a-f0-9]{32}$/.test(event.source)), "sources are hashed");
    assert.equal((await eventsOfType("whatsapp_repair_abuse_alert")).length, 1);
    assert.deepEqual(await eventsOfType("whatsapp_local_repair"), []);
  });
});

test("a notification intent repairs a disconnected account once and cannot be replayed", async () => {
  await withRepairServer({}, async (fixture) => {
    const calls = stubRuntime();
    const token = await notificationToken("wa-one");
    const accepted = await send(fixture.port, { intent: token });
    assert.equal(accepted.status, 200, accepted.text);
    assert.deepEqual(accepted.json, { ok: true, status: "requested" });
    assert.deepEqual(calls.starts, [{ accountId: "wa-one", resetRuntime: true }]);
    assert.deepEqual(calls.mails, [{ to: "repair-owner@example.test", attachments: 1 }]);

    const replay = await send(fixture.port, { intent: token });
    assert.equal(replay.status, 403);
    assert.equal(replay.text, genericRejection);
    assert.equal(calls.mails.length, 1);
    assert.equal((await eventsOfType("whatsapp_repair_intent_replayed")).length, 1);
    const authorized = await eventsOfType("whatsapp_repair_request_authorized");
    assert.deepEqual(authorized.map((event) => [event.accountId, event.via]), [["wa-one", "repair_intent"]]);
    assert.equal((await eventsOfType("whatsapp_local_repair_runtime_reset")).length, 1);
    assert.equal((await eventsOfType("whatsapp_local_repair_qr_email_sent")).length, 1);
  });
});

test("account substitution, wrong host and expiry fail closed; substitution burns the intent", async () => {
  await withRepairServer({}, async (fixture) => {
    const calls = stubRuntime();
    const substituted = await notificationToken("wa-two");
    const substitution = await send(fixture.port, { intent: substituted, accountId: "wa-one" });
    assert.equal(substitution.status, 403);
    assert.equal(substitution.text, genericRejection);
    assert.equal((await send(fixture.port, { intent: substituted })).status, 403, "burned after substitution");

    const hostBound = await notificationToken("wa-one");
    const wrongHost = await send(fixture.port, { intent: hostBound }, { host: "attacker.example.test" });
    assert.equal(wrongHost.status, 403);

    process.env.ORKESTR_WHATSAPP_REPAIR_INTENT_TTL_MS = "1000";
    const shortLived = await notificationToken("wa-one");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal((await send(fixture.port, { intent: shortLived })).status, 403);

    assert.deepEqual(calls, { starts: [], mails: [] });
    const reasons = (await eventsOfType("whatsapp_repair_request_rejected")).map((event) => event.reason);
    assert.deepEqual(reasons, ["account_substitution", "wrong_host", "expired"]);
    assert.equal((await eventsOfType("whatsapp_repair_intent_replayed")).length, 1);
  });
});

test("ready accounts are never reset and unknown readiness fails closed", async () => {
  await withRepairServer({}, async (fixture) => {
    const calls = stubRuntime({ ready: true });
    const admin = await pairedCookie();
    const adminResult = await send(fixture.port, { accountId: "wa-one" }, { cookie: admin });
    assert.equal(adminResult.status, 200, adminResult.text);
    assert.equal(adminResult.json.skippedReason, "already_ready");
    const holder = await send(fixture.port, { intent: await notificationToken("wa-one") });
    assert.deepEqual(holder.json, { ok: true, status: "requested" }, "intent holders do not learn runtime state");
    assert.deepEqual(calls, { starts: [], mails: [] });

    const offline = stubRuntime({ statusFails: true });
    const unknown = await send(fixture.port, { accountId: "wa-two" }, { cookie: admin });
    assert.equal(unknown.status, 503);
    assert.equal(unknown.json.error, "whatsapp_status_unavailable");
    assert.deepEqual(offline, { starts: [], mails: [] });
  });
});

test("administrators repair a chosen account; scoped or anonymous sessions cannot", async () => {
  await withRepairServer({}, async (fixture) => {
    const calls = stubRuntime();
    const admin = await pairedCookie();
    const page = await rawRequest(fixture.port, { pathname: `${repairPath}?accountId=wa-two`, headers: { host: publicHost, cookie: admin } });
    assert.match(page.text, /wa-two/);
    const user = await pairedCookie({ userId: "alice", role: "user" });
    const denied = await send(fixture.port, { accountId: "wa-two" }, { cookie: user });
    assert.equal(denied.status, 403);
    assert.equal(denied.text, genericRejection);
    const crossSite = await send(fixture.port, { accountId: "wa-two" }, { cookie: admin, origin: "https://attacker.example.test" });
    assert.equal(crossSite.status, 403);
    assert.deepEqual(calls, { starts: [], mails: [] });

    const repaired = await send(fixture.port, { accountId: "wa-two" }, { cookie: admin });
    assert.equal(repaired.status, 200, repaired.text);
    assert.equal(repaired.json.accountId, "wa-two");
    assert.deepEqual(repaired.json.recipients, ["re***@example.test"]);
    assert.deepEqual(calls.starts, [{ accountId: "wa-two", resetRuntime: true }]);
    const authorized = await eventsOfType("whatsapp_repair_request_authorized");
    assert.deepEqual(authorized.map((event) => [event.via, event.actorUserId]), [["admin_session", "admin"]]);
  });
});

test("parallel requests generate at most one QR and the global QR concurrency cap holds", async () => {
  await withRepairServer({}, async (fixture) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = stubRuntime({ startDelay: gate });
    const token = await notificationToken("wa-one");
    const other = await notificationToken("wa-two");
    const sameIntent = Array.from({ length: 3 }, () => send(fixture.port, { intent: token }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const otherAccount = await send(fixture.port, { intent: other });
    assert.equal(otherAccount.status, 503, "global QR generation cap is 1");
    release();
    const results = await Promise.all(sameIntent);
    assert.equal(results.filter((response) => response.status === 200).length, 1);
    assert.ok(results.filter((response) => response.status !== 200).every((response) => [403, 503].includes(response.status)));
    assert.equal(calls.starts.length, 1);
    assert.equal(calls.mails.length, 1);
    // The busy account request did not consume its intent.
    const retried = await send(fixture.port, { intent: other });
    assert.equal(retried.status, 200, retried.text);
  });
});

test("per-account and per-source budgets are durable across a restart", async () => {
  const first = await startFixtureServer(repairEnv({ ORKESTR_WHATSAPP_REPAIR_ACCOUNT_LIMIT: "1", ORKESTR_WHATSAPP_REPAIR_SOURCE_LIMIT: "4" }));
  const home = first.home;
  let token = "";
  try {
    stubRuntime();
    const admin = await pairedCookie();
    assert.equal((await send(first.port, { accountId: "wa-one" }, { cookie: admin })).status, 200);
    token = await notificationToken("wa-one");
  } finally {
    setWhatsAppRepairOptionsForTest(null);
    await first.close({ keepHome: true });
  }
  const second = await startFixtureServer(repairEnv({ ORKESTR_WHATSAPP_REPAIR_ACCOUNT_LIMIT: "1", ORKESTR_WHATSAPP_REPAIR_SOURCE_LIMIT: "4" }), { home });
  try {
    const calls = stubRuntime();
    const admin = await pairedCookie();
    const throttled = await send(second.port, { accountId: "wa-one" }, { cookie: admin });
    assert.equal(throttled.status, 429);
    assert.equal(throttled.json.error, "repair_rate_limited");
    const holder = await send(second.port, { intent: token });
    assert.equal(holder.status, 503, "throttled intent holders get the generic unavailable response");
    assert.deepEqual(calls, { starts: [], mails: [] });
    // Unauthenticated source budget (4): the holder above plus three probes.
    for (let index = 0; index < 3; index += 1) assert.equal((await send(second.port, { intent: "probe" })).status, 403);
    const fresh = await notificationToken("wa-two");
    const blocked = await send(second.port, { intent: fresh });
    assert.equal(blocked.status, 403, "even a valid intent is refused once the source budget is spent");
    assert.equal(blocked.text, genericRejection);
    assert.ok((await eventsOfType("whatsapp_repair_request_rejected")).some((event) => event.reason === "source_rate_limited"));
    // Administrators are not locked out by anonymous traffic, and the refused
    // intent was never consumed.
    assert.equal((await send(second.port, { accountId: "wa-two" }, { cookie: admin })).status, 200);
    assert.deepEqual(calls.starts, [{ accountId: "wa-two", resetRuntime: true }]);
    const stored = await findFiles(path.join(home, "secrets", "rate-limits"), "whatsapp-repair-account.json");
    assert.equal(stored.length, 1);
    assert.equal((await fs.readFile(stored[0], "utf8")).includes("wa-one"), false, "account keys are hashed on disk");
  } finally {
    setWhatsAppRepairOptionsForTest(null);
    await second.close();
  }
});
