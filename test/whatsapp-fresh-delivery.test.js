import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendApiSessionMessage, bindApiSessionToThread } from "../packages/core/src/api-session-bindings.js";
import { createThread } from "../packages/core/src/threads.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { createWhatsAppOutboundMirrorWorker } from "../packages/connectors/src/whatsapp-outbound-worker.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function response(payload) {
  return { ok: true, status: 200, async json() { return payload; } };
}

test("outbound mirror worker runs one shared fresh sweep after the in-flight sweep", async () => {
  const worker = createWhatsAppOutboundMirrorWorker();
  const order = [];
  let release;
  const stale = worker.run(() => new Promise((resolve) => {
    order.push("stale");
    release = resolve;
  }));
  const fresh = () => {
    order.push("fresh");
    return "fresh-result";
  };
  const freshA = worker.runFresh(fresh);
  const freshB = worker.runFresh(fresh);
  assert.equal(freshA, freshB);
  assert.notEqual(freshA, stale);
  await Promise.resolve();
  assert.deepEqual(order, ["stale"]);
  release("stale-result");
  assert.equal(await stale, "stale-result");
  assert.equal(await freshA, "fresh-result");
  assert.deepEqual(order, ["stale", "fresh"]);
  // Idle worker: a fresh run starts immediately and later plain runs join it.
  let releaseIdle;
  const idle = worker.runFresh(() => new Promise((resolve) => { releaseIdle = resolve; }));
  assert.equal(worker.run(fresh), idle);
  await Promise.resolve();
  releaseIdle("idle-result");
  assert.equal(await idle, "idle-result");
});

test("fresh WhatsApp delivery includes a message appended while a sweep was in flight", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-fresh-delivery-"));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-fresh-delivery-repo-"));
  const runtimeEnv = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
  };
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "fresh-thread",
    name: "Fresh Thread",
    cwd: repo,
    repoPath: repo,
    binding: { connector: "whatsapp", chatId: "chat-1", responderAccountId: "responder-1", mirrorToWhatsApp: true },
  }, runtimeEnv);
  await bindApiSessionToThread({ apiSessionId: "api-session-fresh", threadId: "fresh-thread", cwd: repo }, runtimeEnv);
  const first = await appendApiSessionMessage({ apiSessionId: "api-session-fresh", role: "assistant", text: "First reply." }, runtimeEnv);

  let sending;
  const sendStarted = new Promise((resolve) => { sending = resolve; });
  let releaseSend;
  const sendReleased = new Promise((resolve) => { releaseSend = resolve; });
  const slowFetch = async (url) => {
    if (String(url).endsWith("/send-text")) {
      sending();
      await sendReleased;
    }
    return response({ ok: true, ids: ["sent-1"] });
  };
  const staleSweep = deliverWhatsAppReplies(runtimeEnv, slowFetch);
  await sendStarted;

  const second = await appendApiSessionMessage({ apiSessionId: "api-session-fresh", role: "assistant", text: "Second reply." }, runtimeEnv);
  const freshSweep = deliverWhatsAppReplies(runtimeEnv, async () => response({ ok: true, ids: ["sent-2"] }), { fresh: true });
  releaseSend();

  const stale = await staleSweep;
  const fresh = await freshSweep;
  assert.deepEqual(stale.delivered.map((item) => item.messageId), [first.message.id]);
  assert.deepEqual(fresh.delivered.map((item) => item.messageId), [second.message.id]);
});
