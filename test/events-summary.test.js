import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { eventErrorCode, resolveEventsSince, summarizeEvents } from "../packages/core/src/events-summary.js";
import { formatEventsDoctor } from "../apps/cli/src/doctor-events-command.js";

const now = Date.parse("2026-01-02T12:00:00.000Z");
const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();

async function home(t, events) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-events-summary-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return { ORKESTR_HOME: dir };
}

test("event codes keep machine codes and drop free text, ids and addresses", () => {
  assert.equal(eventErrorCode("r"), "r");
  assert.equal(eventErrorCode("reconnect_required"), "reconnect_required");
  assert.equal(eventErrorCode("whatsapp_local_bridge_not_ready (status=400, body=...)"), "whatsapp_local_bridge_not_ready");
  assert.equal(eventErrorCode("Hello there, please call me back"), "unclassified");
  assert.equal(eventErrorCode("15550001111@c.us"), "unclassified");
  assert.equal(eventErrorCode(""), "");
  assert.equal(resolveEventsSince("1h", now), now - 3_600_000);
  assert.equal(resolveEventsSince("garbage", now), now - 3_600_000);
});

test("events summary counts the window by type with top failure codes", async (t) => {
  const env = await home(t, [
    { ts: at(180), type: "gmail_notification_run_failed", error: "reconnect_required" },
    { ts: at(50), type: "whatsapp_local_typing_clear_failed", chatId: "chat-secret@g.us", error: "r" },
    { ts: at(40), type: "whatsapp_local_typing_clear_failed", chatId: "chat-secret@g.us", error: "r" },
    { ts: at(30), type: "whatsapp_outbound_failed", chatId: "chat-secret@g.us", error: "Sorry, the private message text failed" },
    { ts: at(20), type: "runtime_liveness_probe_failed", reason: "active_execution_not_found" },
    { ts: at(10), type: "thread_message_created", text: "private text" },
    { ts: at(5), type: "thread_message_created" },
  ]);
  const summary = await summarizeEvents(env, { since: "1h", now });
  const serialized = JSON.stringify(summary);

  assert.equal(summary.total, 6);
  assert.deepEqual(summary.types[0], { type: "thread_message_created", count: 2, perHour: 2 });
  const typing = summary.failures.find((row) => row.type === "whatsapp_local_typing_clear_failed");
  assert.deepEqual(typing.topCodes, [{ code: "error=r", count: 2 }]);
  assert.deepEqual(summary.failures.find((row) => row.type === "runtime_liveness_probe_failed").topCodes, [{ code: "reason=active_execution_not_found", count: 1 }]);
  assert.equal(summary.failures.some((row) => row.type === "gmail_notification_run_failed"), false);
  assert.doesNotMatch(serialized, /chat-secret|private/);

  const text = formatEventsDoctor(summary);
  assert.match(text, /Events, last 60 min: 6 total/);
  assert.match(text, /2 whatsapp_local_typing_clear_failed \(2\/h\)  error=r ×2/);
});

test("events summary reads only the tail it needs and reports a capped scan", async (t) => {
  const old = Array.from({ length: 2000 }, (_, index) => ({ ts: at(600 + index), type: "old_event" })).reverse();
  const env = await home(t, [...old, { ts: at(1), type: "fresh_event" }]);
  const summary = await summarizeEvents(env, { since: "1h", now });
  assert.equal(summary.total, 1);
  assert.equal(summary.truncated, false);
  const capped = await summarizeEvents(env, { since: "1d", now, maxBytes: 1 });
  assert.equal(capped.truncated, true);
  const missing = await summarizeEvents({ ORKESTR_HOME: path.join(os.tmpdir(), "orkestr-events-summary-missing") }, { now });
  assert.equal(missing.total, 0);
});
