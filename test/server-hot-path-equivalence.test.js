import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  connectorOutboxJobDeliveryMatches,
  connectorOutboxJobIntentMatches,
  createConnectorOutboxLedgerIndex,
} from "../packages/connectors/src/whatsapp-outbox-ledger-match.js";
import { cachedFileDigest, clearFileDigestCache, fileDigest } from "../packages/core/src/file-digest-cache.js";
import { runtimeInterruptedSuperseded, visibleThreadMessages } from "../packages/core/src/thread-message-visibility.js";

// Small deterministic PRNG so failures are reproducible.
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}

function randomLedgerItem(random, index) {
  const item = {
    id: `item-${index}`,
    connectorOutboxJobId: pick(random, ["", "", "job-1", "job-2", "job-3"]),
    outboxId: pick(random, ["", "", "router-1", "router-2"]),
    sourceMessageId: pick(random, ["", "msg-1", "msg-2", " msg-3 "]),
    messageId: pick(random, ["", "msg-1", "msg-2", "msg-3"]),
    chatId: pick(random, ["", "chat-a", "chat-b"]),
    accountId: pick(random, ["", "acct-a", "acct-b"]),
    deliveryType: pick(random, ["", "reply", "progress"]),
    textKey: pick(random, ["", "tk-1", "tk-2"]),
    status: pick(random, ["delivered", "pending", "DELIVERED", "failed"]),
  };
  return item;
}

function randomJob(random, index) {
  return {
    id: pick(random, ["", "job-1", "job-2", "job-3", `job-x${index}`]),
    sourceMessageId: pick(random, ["", "msg-1", "msg-2", "msg-3"]),
    sourceEventId: pick(random, ["", "msg-2"]),
    chatId: pick(random, ["", "chat-a", "chat-b"]),
    accountId: pick(random, ["", "acct-a"]),
    deliveryType: pick(random, ["", "reply", "progress"]),
    metadata: { routerOutboxId: pick(random, ["", "router-1", "router-2"]), textKey: pick(random, ["", "tk-1"]) },
  };
}

test("connector outbox ledger index returns exactly what the linear ledger scans return", () => {
  const random = rng(42);
  for (let round = 0; round < 40; round += 1) {
    const deliveries = Array.from({ length: 60 }, (_, index) => randomLedgerItem(random, index));
    const intents = Array.from({ length: 60 }, (_, index) => randomLedgerItem(random, 100 + index));
    const index = createConnectorOutboxLedgerIndex(deliveries, intents);
    for (let jobIndex = 0; jobIndex < 40; jobIndex += 1) {
      const job = randomJob(random, jobIndex);
      const expectedDelivery = [...deliveries].reverse().find((item) => connectorOutboxJobDeliveryMatches(job, item)) || null;
      const expectedDeliveredIntent = [...intents].reverse().find((item) =>
        connectorOutboxJobIntentMatches(job, item) && String(item.status || "").trim().toLowerCase() === "delivered") || null;
      const expectedFirstIntent = intents.find((item) => connectorOutboxJobIntentMatches(job, item)) || null;
      assert.equal(index.latestDelivery(job), expectedDelivery);
      assert.equal(index.latestDeliveredIntent(job), expectedDeliveredIntent);
      assert.equal(index.firstIntent(job), expectedFirstIntent);
    }
  }
});

test("connector outbox ledger index reads intents updated in place", () => {
  const intents = [{ intentId: "i-1", outboxId: "router-1", status: "pending" }];
  const index = createConnectorOutboxLedgerIndex([], intents);
  const job = { id: "job-1", metadata: { routerOutboxId: "router-1" } };
  assert.equal(index.latestDeliveredIntent(job), null);
  intents.splice(0, intents.length, { ...intents[0], status: "delivered", connectorOutboxJobId: "job-1" });
  assert.equal(index.latestDeliveredIntent(job)?.status, "delivered");
});

test("visible thread messages match the per-message superseded scan", () => {
  const random = rng(7);
  for (let round = 0; round < 30; round += 1) {
    const messages = Array.from({ length: 80 }, (_, index) => ({
      id: pick(random, [`m-${index}`, `m-${index}`, "dup"]),
      role: pick(random, ["assistant", "assistant", "user"]),
      source: pick(random, ["orkestr_runtime", "codex-app-server", "thread_bridge_agent"]),
      phase: pick(random, ["runtime_interrupted", "final_answer", "commentary", "plan", ""]),
      state: pick(random, ["", "completed", "running"]),
      codexTurnId: pick(random, ["", "t-1", "t-2", "t-3"]),
      text: "x",
    }));
    const expected = messages.filter((message) => !runtimeInterruptedSuperseded(message, messages));
    assert.deepEqual(visibleThreadMessages(messages), expected);
  }
});

test("cached file digest reuses settled files and rehashes after a change", async () => {
  clearFileDigestCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-digest-"));
  try {
    const filePath = path.join(dir, "payload.bin");
    await fs.writeFile(filePath, "first payload");
    let calls = 0;
    const digestImpl = async (target) => {
      calls += 1;
      return fileDigest(target);
    };
    const later = () => Date.now() + 60_000;
    const first = await cachedFileDigest(filePath, { digestImpl, now: later });
    const second = await cachedFileDigest(filePath, { digestImpl, now: later });
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
    await fs.writeFile(filePath, "second payload, longer");
    const changed = await cachedFileDigest(filePath, { digestImpl, now: later });
    assert.equal(calls, 2);
    assert.deepEqual(changed, await fileDigest(filePath));
    assert.notEqual(changed.checksum, first.checksum);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    clearFileDigestCache();
  }
});

test("cached file digest never caches a recently modified file", async () => {
  clearFileDigestCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-digest-"));
  try {
    const filePath = path.join(dir, "fresh.bin");
    await fs.writeFile(filePath, "fresh");
    let calls = 0;
    const digestImpl = async (target) => {
      calls += 1;
      return fileDigest(target);
    };
    await cachedFileDigest(filePath, { digestImpl });
    await cachedFileDigest(filePath, { digestImpl });
    assert.equal(calls, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    clearFileDigestCache();
  }
});

test("thread message page selects the same messages as bridging every message first", async () => {
  const { threadMessagePage, chronologicalMessages } = await import("../dist/server/apps/server/src/modules/threads/thread-message-page.js");
  const random = rng(99);
  const base = Date.UTC(2026, 0, 1);
  const raw = Array.from({ length: 300 }, (_, index) => ({
    id: `m-${index}`,
    role: pick(random, ["user", "assistant"]),
    text: pick(random, ["hello", "", "  ", "done"]),
    cursor: index + 1,
    createdAt: random() < 0.1 ? "" : new Date(base + Math.floor(random() * 50) * 1000).toISOString(),
  }));
  const thread = { id: "thread-perf-test", state: "sleeping" };
  const reference = (query) => {
    const ordered = visibleThreadMessages(chronologicalMessages(raw));
    let selected = ordered
      .map((message, index) => ({ id: message.id, cursor: Number(message.cursor || 0) || index + 1, text: String(message.text || "").trim() }))
      .filter((message) => message.text);
    if (query.since) selected = selected.filter((message) => message.cursor > query.since);
    if (query.before) selected = selected.filter((message) => message.cursor < query.before);
    return selected.slice(-(query.limit || 100)).map((message) => [message.id, message.cursor]);
  };
  for (const query of [{}, { limit: 7 }, { since: 120 }, { before: 200, limit: 20 }, { since: 50, before: 60 }]) {
    const page = threadMessagePage(thread, raw, query, null);
    assert.deepEqual(page.messages.map((message) => [message.id, message.cursor]), reference(query), JSON.stringify(query));
  }
});
