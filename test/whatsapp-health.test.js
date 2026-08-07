import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getWhatsAppStatus } from "../packages/connectors/src/whatsapp.js";
import { resetLocalWhatsAppBridgeForTest, setLocalWhatsAppRuntimeForTest } from "../packages/connectors/src/whatsapp-local-bridge.js";

test("whatsapp status uses passive local health unless diagnostics are explicit", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-passive-health-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_STATUS_CHAT_OPS_PROBE: "1",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_INTERVAL_MS: "1000",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChats() {
        calls.push("getChats");
        return [];
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);

    const passive = await getWhatsAppStatus(env);
    const diagnostic = await getWhatsAppStatus(env, fetch, { probeChatOps: true, force: true });

    assert.equal(passive.state, "paired");
    assert.deepEqual(calls, ["getChats"]);
    assert.equal(diagnostic.state, "paired");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});
