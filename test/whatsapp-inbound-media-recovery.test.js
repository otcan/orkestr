import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { listEvents } from "../packages/storage/src/store.js";
import {
  handleInboundMessage,
  recoverUnreadLocalWhatsAppMessages,
  resetLocalWhatsAppBridgeForTest,
  runLocalWhatsAppInboundMediaRetries,
  setLocalWhatsAppRuntimeForTest,
} from "../packages/connectors/src/whatsapp-local-bridge.js";
import {
  inboundMediaRetryDelaysMs,
  pruneInboundMediaEntries,
  readInboundMediaState,
} from "../packages/connectors/src/whatsapp-inbound-media-state.js";
import {
  inboundMediaFailureText,
  inboundMediaRecoveredText,
} from "../packages/connectors/src/whatsapp-inbound-media-failures.js";
import {
  describeInboundMediaMessage,
  serializeInboundMediaError,
} from "../packages/connectors/src/whatsapp-inbound-media-diagnostics.js";

const MINUTE = 60_000;

async function setup(prefix, extraEnv = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
    ORKESTR_WHATSAPP_INBOUND_MEDIA_DOWNLOAD_ATTEMPTS: "1",
    ORKESTR_WHATSAPP_INBOUND_MEDIA_DOWNLOAD_RETRY_MS: "0",
    ORKESTR_WHATSAPP_INBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS: "200",
    ...extraEnv,
  };
  const chatId = `${prefix.replace(/[^a-z0-9-]/g, "")}chat@g.us`;
  const threadId = `${prefix.replace(/[^a-z0-9-]/g, "")}thread`;
  await createThread({
    id: threadId,
    name: "Media recovery",
    binding: {
      connector: "whatsapp",
      chatId,
      responderAccountId: "sender",
      outboundAccountId: "sender",
      enabled: true,
    },
  }, env);
  return { home, env, chatId, threadId };
}

function mediaMessage({ chatId, localId, type = "image", body = "", download }) {
  return {
    id: { _serialized: `false_${chatId}_${localId}`, id: localId, remote: chatId },
    from: chatId,
    author: "90000000000002:3@s.whatsapp.net",
    fromMe: false,
    body,
    hasMedia: true,
    type,
    timestamp: Math.floor(Date.now() / 1000),
    _data: { mimetype: "image/jpeg", size: 1234 },
    downloadMedia: download,
  };
}

function eventsOfType(events, type, eventId) {
  return events.filter((event) => event.type === type && (!eventId || event.eventId === eventId));
}

test("inbound media retry delays default to 1/5/15 minutes and are configurable", () => {
  assert.deepEqual(inboundMediaRetryDelaysMs({}), [MINUTE, 5 * MINUTE, 15 * MINUTE]);
  assert.deepEqual(inboundMediaRetryDelaysMs({ ORKESTR_WHATSAPP_INBOUND_MEDIA_RETRY_DELAYS_MS: "off" }), []);
  assert.deepEqual(inboundMediaRetryDelaysMs({ ORKESTR_WHATSAPP_INBOUND_MEDIA_RETRY_DELAYS_MS: "0" }), []);
  assert.deepEqual(inboundMediaRetryDelaysMs({ ORKESTR_WHATSAPP_INBOUND_MEDIA_RETRY_DELAYS_MS: "120000, 30000" }), [30_000, 120_000]);
  assert.deepEqual(inboundMediaRetryDelaysMs({ ORKESTR_WHATSAPP_INBOUND_MEDIA_RETRY_DELAYS_MS: "garbage" }), [MINUTE, 5 * MINUTE, 15 * MINUTE]);
});

test("inbound media state prunes by TTL and count", () => {
  const nowMs = Date.parse("2026-01-10T00:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  const entries = {
    "a:old-delivered": { key: "a:old-delivered", state: "delivered", updatedAt: iso(nowMs - 2 * 24 * 60 * MINUTE) },
    "a:fresh-delivered": { key: "a:fresh-delivered", state: "delivered", updatedAt: iso(nowMs - MINUTE) },
    "a:terminal": { key: "a:terminal", state: "failed_terminal", updatedAt: iso(nowMs - 2 * 24 * 60 * MINUTE) },
    "a:stale-pending": { key: "a:stale-pending", state: "pending_retry", firstFailedAt: iso(nowMs - 2 * 24 * 60 * MINUTE), updatedAt: iso(nowMs - MINUTE) },
    "a:pending": { key: "a:pending", state: "pending_retry", firstFailedAt: iso(nowMs - MINUTE), updatedAt: iso(nowMs - MINUTE) },
    "a:bogus": { key: "a:bogus", state: "unknown", updatedAt: iso(nowMs) },
  };
  assert.deepEqual(Object.keys(pruneInboundMediaEntries(entries, {}, nowMs)).sort(), ["a:fresh-delivered", "a:pending", "a:terminal"]);
  const many = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`a:${index}`, { key: `a:${index}`, state: "delivered", updatedAt: iso(nowMs - index * 1000) }]));
  const bounded = pruneInboundMediaEntries(many, { ORKESTR_WHATSAPP_INBOUND_MEDIA_STATE_LIMIT: "100" }, nowMs);
  assert.equal(Object.keys(bounded).length, 100);
  assert.ok(bounded["a:0"]);
  assert.equal(bounded["a:149"], undefined);
});

test("inbound media notices name the media type and only ask for resend at terminal failure", () => {
  const image = inboundMediaFailureText("image", { retriedForMs: 15 * MINUTE });
  assert.match(image, /WhatsApp image/);
  assert.match(image, /over about 15 minutes/);
  assert.match(image, /not sent to the assistant/);
  assert.match(image, /Please resend the image\.$/);
  assert.match(inboundMediaFailureText("document"), /Please resend the document\.$/);
  assert.match(inboundMediaFailureText("unknown-kind"), /Please resend the attachment\.$/);
  assert.match(inboundMediaFailureText("ptt"), /voice-note event/);
  assert.match(inboundMediaFailureText("ptt"), /send it as an audio file/);
  const recovered = inboundMediaRecoveredText("video");
  assert.match(recovered, /^Recovered the WhatsApp video/);
  assert.match(recovered, /no need to resend/);
  assert.doesNotMatch(recovered, /Please resend/);
});

test("inbound media diagnostics keep error name, stack head and non-secret metadata", () => {
  class r extends Error {}
  const error = new r("t");
  error.name = "MediaDownloadError";
  error.status = 410;
  const serialized = serializeInboundMediaError(error, "primary");
  assert.equal(serialized.source, "primary");
  assert.equal(serialized.name, "MediaDownloadError");
  assert.equal(serialized.constructorName, "r");
  assert.equal(serialized.message, "t");
  assert.equal(serialized.status, 410);
  assert.match(serialized.stackHead, /MediaDownloadError: t/);
  assert.ok(serialized.stackHead.split("\n").length <= 6);

  const described = describeInboundMediaMessage({
    id: { id: "3A0123456789", remote: "chat@g.us" },
    author: "90000000000002:7@s.whatsapp.net",
    type: "image",
    timestamp: 1000,
    isForwarded: true,
    _data: { mimetype: "image/jpeg", mediaKey: "secret-key", directPath: "/v/secret", size: 42 },
  }, 1_060_000);
  assert.deepEqual(described, {
    type: "image",
    mimetype: "image/jpeg",
    hasMediaKey: true,
    hasDirectPath: true,
    mediaStage: "",
    isForwarded: true,
    fromMe: false,
    senderDevice: "7",
    messageAgeSec: 60,
    idPrefix: "3A01",
    size: 42,
  });
  assert.doesNotMatch(JSON.stringify(described), /secret|90000000000002/);
});

test("failed inbound media records full diagnostics, schedules a retry, and is not reprocessed by replays", async () => {
  const { env, chatId, threadId } = await setup("orkestr-wa-media-diag-");
  let downloads = 0;
  let browserCalls = 0;
  const message = mediaMessage({
    chatId,
    localId: "3A0000DIAG0001",
    async download() {
      downloads += 1;
      throw new Error("r");
    },
  });
  const client = {
    pupPage: {
      async evaluate() {
        browserCalls += 1;
        return {
          error: { name: "TypeError", constructorName: "r", message: "t", status: 404, stackHead: "TypeError: t\n    at downloadAndMaybeDecrypt (bundle.js:1:2)" },
          media: { found: true, type: "image", hasMediaKey: false, hasDirectPath: false, mediaStage: "ERROR_MISSING", senderDevice: "3", messageAgeSec: 5 },
        };
      },
    },
  };

  try {
    const result = await handleInboundMessage("sender", message, env, { client });
    assert.equal(result.error, "whatsapp_inbound_media_download_failed");
    assert.equal(result.mediaRetry.state, "pending_retry");
    assert.equal(result.mediaFailureWarning, null);

    const events = await listEvents(env, 100);
    const failed = eventsOfType(events, "whatsapp_local_inbound_media_download_failed", message.id._serialized);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].error, "r");
    assert.equal(failed[0].errorDetail.name, "Error");
    assert.match(failed[0].errorDetail.stackHead, /Error: r/);
    assert.deepEqual(failed[0].attemptErrors.map((entry) => entry.source), ["primary", "browser_blob", "browser_store"]);
    const browserError = failed[0].attemptErrors.find((entry) => entry.source === "browser_store");
    assert.equal(browserError.name, "TypeError");
    assert.equal(browserError.constructorName, "r");
    assert.equal(browserError.status, 404);
    assert.match(browserError.stackHead, /downloadAndMaybeDecrypt/);
    assert.equal(failed[0].media.type, "image");
    assert.equal(failed[0].media.idPrefix, "3A00");
    assert.equal(failed[0].media.senderDevice, "3");
    assert.equal(failed[0].media.hasMediaKey, false);
    assert.equal(failed[0].browserMedia.mediaStage, "ERROR_MISSING");
    assert.doesNotMatch(JSON.stringify(failed[0]), /90000000000002/);
    assert.equal(eventsOfType(events, "whatsapp_local_inbound_media_retry_scheduled", message.id._serialized).length, 1);

    const state = await readInboundMediaState("sender", message.id._serialized, env);
    assert.equal(state.state, "pending_retry");
    assert.equal(state.attempt, 0);
    assert.ok(Date.parse(state.nextAt) - Date.parse(state.firstFailedAt) >= MINUTE);
    assert.equal(state.lastDiagnostics.media.idPrefix, "3A00");

    const downloadsAfterFirstCycle = downloads;
    const browserCallsAfterFirstCycle = browserCalls;
    for (let index = 0; index < 5; index += 1) {
      const replay = await handleInboundMessage("sender", message, env, { client });
      assert.equal(replay.skipped, "inbound_media_retry_pending");
    }
    assert.equal(downloads, downloadsAfterFirstCycle);
    assert.equal(browserCalls, browserCallsAfterFirstCycle);
    assert.equal((await listThreadMessages(threadId, env)).length, 0);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("delayed retry schedule runs one cycle per attempt and posts the resend notice only at terminal failure", async () => {
  const { env, chatId, threadId } = await setup("orkestr-wa-media-schedule-");
  let cycles = 0;
  const message = mediaMessage({
    chatId,
    localId: "3B0000SCHED0001",
    async download() {
      cycles += 1;
      throw new Error("t");
    },
  });
  const eventId = message.id._serialized;
  const client = { async getMessageById(id) { return id === eventId ? message : null; } };

  try {
    const t0 = Date.now();
    await handleInboundMessage("sender", message, env, { client });
    assert.equal(cycles, 1);
    setLocalWhatsAppRuntimeForTest("sender", { client }, { ready: true }, env);

    let run = await runLocalWhatsAppInboundMediaRetries(env, { nowMs: t0 + 30_000 });
    assert.equal(run.due, 0);
    assert.equal(cycles, 1);

    run = await runLocalWhatsAppInboundMediaRetries(env, { nowMs: t0 + MINUTE + 1_000 });
    assert.equal(run.due, 1);
    assert.equal(cycles, 2);
    let state = await readInboundMediaState("sender", eventId, env);
    assert.equal(state.state, "pending_retry");
    assert.equal(state.attempt, 1);
    assert.equal(Date.parse(state.nextAt) - Date.parse(state.firstFailedAt), 5 * MINUTE);

    for (const offset of [2 * MINUTE, 3 * MINUTE, 4 * MINUTE]) {
      run = await runLocalWhatsAppInboundMediaRetries(env, { nowMs: t0 + offset });
      assert.equal(run.due, 0);
    }
    assert.equal(cycles, 2);

    await runLocalWhatsAppInboundMediaRetries(env, { nowMs: t0 + 5 * MINUTE + 1_000 });
    assert.equal(cycles, 3);
    state = await readInboundMediaState("sender", eventId, env);
    assert.equal(state.attempt, 2);
    assert.equal(Date.parse(state.nextAt) - Date.parse(state.firstFailedAt), 15 * MINUTE);
    assert.equal((await listThreadMessages(threadId, env)).length, 0);

    await runLocalWhatsAppInboundMediaRetries(env, { nowMs: t0 + 15 * MINUTE + 1_000 });
    assert.equal(cycles, 4);
    state = await readInboundMediaState("sender", eventId, env);
    assert.equal(state.state, "failed_terminal");

    const messages = await listThreadMessages(threadId, env);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, "assistant");
    assert.equal(messages[0].source, "whatsapp-inbound-media-warning");
    assert.match(messages[0].text, /WhatsApp image/);
    assert.match(messages[0].text, /over about 15 minutes/);
    assert.match(messages[0].text, /Please resend the image\./);

    await runLocalWhatsAppInboundMediaRetries(env, { nowMs: t0 + 60 * MINUTE });
    const replay = await handleInboundMessage("sender", message, env, { client });
    assert.equal(replay.skipped, "inbound_media_failed_terminal");
    assert.equal(cycles, 4);
    const events = await listEvents(env, 200);
    assert.equal(eventsOfType(events, "whatsapp_local_inbound_media_download_failed", eventId).length, 4);
    assert.equal(eventsOfType(events, "whatsapp_local_inbound_media_retry_exhausted", eventId).length, 1);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("media that becomes available after a restart is delivered with a recovered note", async () => {
  const { env, chatId, threadId } = await setup("orkestr-wa-media-recover-");
  let mediaReady = false;
  let downloads = 0;
  const message = mediaMessage({
    chatId,
    localId: "4A0000RECOVER01",
    body: "site photo",
    async download() {
      downloads += 1;
      if (!mediaReady) throw new Error("r");
      return { data: Buffer.from("photo bytes").toString("base64"), mimetype: "image/jpeg", filename: "photo.jpg" };
    },
  });
  const eventId = message.id._serialized;
  let reuploadRequests = 0;
  const client = {
    async getMessageById(id) { return id === eventId ? message : null; },
    pupPage: {
      async evaluate(callback) {
        if (/isUserInitiated/.test(String(callback)) && /reupload_in_progress/.test(String(callback))) {
          reuploadRequests += 1;
          return { requested: true, stageBefore: "ERROR_MISSING", stageAfter: "REUPLOADING" };
        }
        return null;
      },
    },
  };

  try {
    const t0 = Date.now();
    const first = await handleInboundMessage("sender", message, env, { client });
    assert.equal(first.mediaRetry.state, "pending_retry");

    // Simulate a service restart: in-memory bridge state is gone, the
    // persisted schedule is not.
    await resetLocalWhatsAppBridgeForTest(env);
    const notReady = await runLocalWhatsAppInboundMediaRetries(env, { nowMs: t0 + MINUTE + 1_000 });
    assert.equal(notReady.results[0].outcome, "deferred");
    assert.equal((await readInboundMediaState("sender", eventId, env)).attempt, 0);

    setLocalWhatsAppRuntimeForTest("sender", { client }, { ready: true }, env);
    mediaReady = true;
    const run = await runLocalWhatsAppInboundMediaRetries(env, { nowMs: t0 + 3 * MINUTE });
    assert.equal(run.results[0].outcome, "recovered");
    assert.equal(run.results[0].routed, true);
    assert.ok(reuploadRequests >= 1);

    const messages = await listThreadMessages(threadId, env);
    assert.deepEqual(messages.map((entry) => entry.role), ["user", "assistant"]);
    assert.equal(messages[0].text, "site photo");
    assert.equal(messages[0].attachments[0].filename, "photo.jpg");
    assert.equal(await fs.readFile(messages[0].attachments[0].path, "utf8"), "photo bytes");
    assert.equal(messages[1].source, "whatsapp-inbound-media-recovered");
    assert.match(messages[1].text, /^Recovered the WhatsApp image/);
    assert.equal(messages.filter((entry) => entry.source === "whatsapp-inbound-media-warning").length, 0);

    const state = await readInboundMediaState("sender", eventId, env);
    assert.equal(state.state, "delivered");
    assert.equal(state.recoveredAfterRetry, true);

    const downloadsAfterRecovery = downloads;
    for (let index = 0; index < 3; index += 1) {
      const replay = await handleInboundMessage("sender", message, env, { client });
      assert.equal(replay.routed.duplicate, true);
    }
    await runLocalWhatsAppInboundMediaRetries(env, { nowMs: t0 + 20 * MINUTE });
    assert.equal(downloads, downloadsAfterRecovery);
    assert.equal((await listThreadMessages(threadId, env)).length, 2);
    const events = await listEvents(env, 200);
    assert.equal(eventsOfType(events, "whatsapp_local_inbound_media_retry_recovered", eventId).length, 1);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("successful media is downloaded once even when the recent scan replays it", async () => {
  const { env, chatId, threadId } = await setup("orkestr-wa-media-once-");
  const eventId = `false_${chatId}_3EB0ONCE0001`;
  let browserStoreDownloads = 0;
  const message = {
    id: { _serialized: eventId, id: "3EB0ONCE0001", remote: chatId },
    from: chatId,
    author: "90000000000002@lid",
    fromMe: false,
    body: "report.pdf",
    hasMedia: true,
    type: "document",
    timestamp: Math.floor(Date.now() / 1000),
  };
  const client = {
    pupPage: {
      async evaluate(callback) {
        if (!/downloadAndMaybeDecrypt/.test(String(callback))) return null;
        browserStoreDownloads += 1;
        return { data: Buffer.from("pdf bytes").toString("base64"), filename: "report.pdf", mimetype: "application/pdf" };
      },
    },
    async getChats() {
      return [{
        id: { _serialized: chatId },
        unreadCount: 0,
        async fetchMessages() {
          return [message];
        },
      }];
    },
  };
  const thread = { id: threadId, binding: { connector: "whatsapp", chatId, responderAccountId: "sender", outboundAccountId: "sender", enabled: true } };

  try {
    setLocalWhatsAppRuntimeForTest("sender", { client }, { ready: true }, env);
    for (let index = 0; index < 4; index += 1) {
      await recoverUnreadLocalWhatsAppMessages(env, {
        force: true,
        accountIds: ["sender"],
        threads: [thread],
        nowMs: Date.now(),
      });
    }
    const messages = await listThreadMessages(threadId, env);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].attachments[0].filename, "report.pdf");
    assert.equal(browserStoreDownloads, 1);
    const events = await listEvents(env, 200);
    assert.equal(eventsOfType(events, "whatsapp_local_inbound_media_download_browser_store_recovered", eventId).length, 1);
    assert.equal((await readInboundMediaState("sender", eventId, env)).state, "delivered");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("recent scan drives due media retries and never reprocesses pending media in between", async () => {
  const { env, chatId, threadId } = await setup("orkestr-wa-media-scan-");
  let cycles = 0;
  let mediaReady = false;
  const message = mediaMessage({
    chatId,
    localId: "3A0000SCAN0001",
    type: "document",
    async download() {
      cycles += 1;
      if (!mediaReady) throw new Error("r");
      return { data: Buffer.from("doc").toString("base64"), mimetype: "application/pdf", filename: "doc.pdf" };
    },
  });
  const client = {
    async getMessageById(id) { return id === message.id._serialized ? message : null; },
    async getChats() {
      return [{
        id: { _serialized: chatId },
        unreadCount: 0,
        async fetchMessages() {
          return [message];
        },
      }];
    },
  };
  const thread = { id: threadId, binding: { connector: "whatsapp", chatId, responderAccountId: "sender", outboundAccountId: "sender", enabled: true } };
  const scan = (nowMs) => recoverUnreadLocalWhatsAppMessages(env, {
    force: true,
    accountIds: ["sender"],
    threads: [thread],
    nowMs,
    recentSinceMs: 1,
  });

  try {
    setLocalWhatsAppRuntimeForTest("sender", { client }, { ready: true }, env);
    const t0 = Date.now();
    await scan(t0);
    assert.equal(cycles, 1);
    for (let index = 1; index <= 5; index += 1) await scan(t0 + index * 10_000);
    assert.equal(cycles, 1);
    mediaReady = true;
    const due = await scan(t0 + MINUTE + 1_000);
    assert.equal(due.mediaRetries.results[0].outcome, "recovered");
    assert.equal(cycles, 2);
    await scan(t0 + MINUTE + 11_000);
    assert.equal(cycles, 2);
    const messages = await listThreadMessages(threadId, env);
    assert.deepEqual(messages.map((entry) => entry.source), ["whatsapp_inbound", "whatsapp-inbound-media-recovered"]);
    assert.match(messages[1].text, /WhatsApp document/);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});
