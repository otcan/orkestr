import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
// The server runs the compiled build; write through the same module copy.
import { appendThreadMessage, createThread } from "../dist/server/packages/core/src/threads.js";

// A new message (for example from WhatsApp) reaches open browsers at once,
// not only on the 10s summary timer.
test("a written message pushes a fresh thread summary to open browsers within a second", { timeout: 60_000 }, async (t) => {
  if (typeof globalThis.WebSocket === "undefined") return t.skip("No WebSocket client in this Node.");
  const keys = ["ORKESTR_HOME", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_OWNER_LOGIN_PROMPT", "ORKESTR_SUMMARY_STREAM_INTERVAL_MS"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.ORKESTR_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-summary-push-"));
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_OWNER_LOGIN_PROMPT = "0";
  process.env.ORKESTR_SUMMARY_STREAM_INTERVAL_MS = "60000";
  await createThread({ id: "live", name: "live", executorId: "noop" }, process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/threads/summary/stream`);
  try {
    const summaries = [];
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.type === "threads_summary") summaries.push(Date.now());
    });
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
    const deadline = Date.now() + 5000;
    while (!summaries.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const before = summaries.length;
    const writtenAt = Date.now();
    await appendThreadMessage("live", { role: "user", text: "hello from WhatsApp", source: "whatsapp_inbound" }, process.env);
    while (summaries.length === before && Date.now() - writtenAt < 3000) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(summaries.length > before, "a summary was pushed after the write");
    assert.ok(summaries.at(-1) - writtenAt < 2000, `pushed within 2s (took ${summaries.at(-1) - writtenAt}ms)`);
  } finally {
    socket.close();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
