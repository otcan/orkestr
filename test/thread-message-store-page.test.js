import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { threadMessagePage } from "../dist/server/apps/server/src/modules/threads/thread-message-page.js";
import { storedThreadMessagePage } from "../dist/server/apps/server/src/modules/threads/thread-message-store-page.js";
import {
  appendThreadMessageRecord,
  closeThreadMessageRegistryCache,
  listThreadMessageRows,
  replaceThreadMessageRecords,
} from "../dist/server/packages/storage/src/thread-message-registry.js";

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

// Out-of-order timestamps, ties, missing cursors and every visibility rule the page applies.
function randomMessage(random, index) {
  const base = Date.UTC(2026, 0, 1);
  const turn = pick(random, ["", "turn-a", "turn-b", " turn-c ", "turn-c", "turn-ab"]);
  const role = pick(random, ["user", "assistant", "assistant", "assistant", ""]);
  const message = {
    id: `m-${index}`,
    role,
    text: pick(random, ["hello", "done", "", "  ", "NO_REPLY", "Which option?"]),
    phase: pick(random, ["", "final_answer", "commentary", "need_input", "question", "runtime_interrupted"]),
    source: pick(random, ["thread", "orkestr_runtime", "codex-app-server", "whatsapp_inbound"]),
    state: pick(random, ["", "completed", "queued"]),
  };
  if (!role) message.kind = pick(random, ["user", "assistant"]);
  if (random() < 0.8) message.cursor = index + 1;
  const offset = Math.floor(random() * 400) * 1000;
  const stamp = pick(random, ["iso", "iso", "seconds", "none", "created"]);
  if (stamp === "iso") message.timestamp = new Date(base + offset).toISOString();
  if (stamp === "seconds") message.timestamp = (base + offset) / 1000;
  if (stamp === "created") message.createdAt = new Date(base + offset).toISOString();
  if (turn) message[random() < 0.5 ? "codexTurnId" : "executorTurnId"] = turn;
  if (random() < 0.05) message.visibility = "internal";
  if (random() < 0.05) message.supersededBy = `m-${index + 1}`;
  return message;
}

async function withSqliteHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-store-page-"));
  const previous = {
    ORKESTR_HOME: process.env.ORKESTR_HOME,
    ORKESTR_THREAD_MESSAGE_STORE: process.env.ORKESTR_THREAD_MESSAGE_STORE,
  };
  Object.assign(process.env, { ORKESTR_HOME: home, ORKESTR_THREAD_MESSAGE_STORE: "sqlite" });
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 5, 1) });
  t.after(async () => {
    await closeThreadMessageRegistryCache();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  });
}

async function assertSamePages(thread, queries) {
  for (const query of queries) {
    const expected = threadMessagePage(thread, await listThreadMessageRows(thread.id), query, null);
    assert.deepEqual(await storedThreadMessagePage(thread, query, null), expected, JSON.stringify(query));
  }
}

test("sqlite thread message page matches the full-list page", async (t) => {
  await withSqliteHome(t);
  const random = rng(7);
  const thread = { id: "thread-store-page", state: "sleeping" };
  const messages = Array.from({ length: 900 }, (_, index) => randomMessage(random, index));
  await replaceThreadMessageRecords(thread.id, messages);
  const queries = [
    {}, { limit: 1 }, { limit: 7 }, { limit: 250 }, { since: 850 }, { since: 899 }, { before: 450 },
    { before: 450, limit: 20 }, { since: 100, before: 140 }, { before: 2 }, { since: 5000 },
  ];
  await assertSamePages(thread, queries);
  // Appending changes the store revision, so the cached summary must not be reused.
  await appendThreadMessageRecord(thread.id, { id: "m-new", role: "user", text: "late", cursor: 901, timestamp: "2026-01-01T00:00:00.000Z" });
  await appendThreadMessageRecord(thread.id, { id: "m-question", role: "assistant", phase: "need_input", text: "Ready?", cursor: 902, timestamp: "2026-01-02T00:00:00.000Z" });
  await assertSamePages(thread, queries);
});

test("sqlite thread message page finds an old pending question and superseded interruptions", async (t) => {
  await withSqliteHome(t);
  const thread = { id: "thread-store-page-deep", state: "sleeping" };
  const at = (index) => new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
  const messages = [
    { id: "q", role: "assistant", phase: "need_input", text: "Pick one", cursor: 1, timestamp: at(1) },
    { id: "i", role: "assistant", source: "orkestr_runtime", phase: "runtime_interrupted", text: "Interrupted", codexTurnId: "turn-x", cursor: 2, timestamp: at(2) },
    ...Array.from({ length: 700 }, (_, index) => ({ id: `a-${index}`, role: "assistant", text: "", cursor: index + 3, timestamp: at(index + 3) })),
    { id: "f", role: "assistant", phase: "final_answer", text: "Finished", codexTurnId: " turn-x ", cursor: 703, timestamp: at(1) },
  ];
  await replaceThreadMessageRecords(thread.id, messages);
  await assertSamePages(thread, [{}, { limit: 1 }, { before: 3 }]);
  const page = await storedThreadMessagePage(thread, {}, null);
  assert.equal(page.pendingQuestion?.messageId, "q");
  assert.deepEqual(page.messages.map((message) => message.id), ["q", "f"]);
});

test("stored thread message page defers to the full list for the JSON store", async (t) => {
  await withSqliteHome(t);
  process.env.ORKESTR_THREAD_MESSAGE_STORE = "json";
  assert.equal(await storedThreadMessagePage({ id: "thread-json" }, {}, null), null);
});
