import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleInboundMessage } from "../packages/connectors/src/whatsapp-local-bridge.js";
import { listEvents } from "../packages/storage/src/store.js";

test("local whatsapp bridge skips group system messages before routing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-system-message-skip-"));
  const env = {
    ...process.env,
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_AUTOSTART: "0",
    WHATSAPP_LOCAL_AUTOSTART: "0",
    ORKESTR_WA_WORKER_EVENT_SINK_URL: "http://connector-gateway.test/internal/whatsapp/inbound",
    ORKESTR_WA_WORKER_EVENT_TOKEN: "worker-event-token",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("system WhatsApp events must not be forwarded");
  };

  let result;
  try {
    result = await handleInboundMessage("sender", {
      id: { _serialized: "false_wa-system-group@g.us_12345_wa-owner@lid", remote: "wa-system-group@g.us" },
      from: "wa-system-group@g.us",
      author: "wa-owner@lid",
      fromMe: false,
      body: "set",
      type: "gp2",
      timestamp: 1_780_000_000,
    }, env);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const events = await listEvents(env, 20);
  assert.equal(result.skipped, "system_message");
  assert.equal(result.chatId, "wa-system-group@g.us");
  assert.equal(events.some((event) =>
    event.type === "whatsapp_local_inbound_system_message_skipped" &&
    event.chatId === "wa-system-group@g.us" &&
    event.messageType === "gp2"
  ), true);
});
