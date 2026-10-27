import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The compiled messages endpoint returns silent NO_REPLY finals only to the
// scoped group relay's auth path (the local CLI machine token) and only when it
// asks; every other caller keeps the filtered page. Both message stores.
for (const store of ["sqlite", "json"]) {
  test(`messages endpoint gates includeNoReply on CLI machine auth (${store} store)`, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "thread-messages-no-reply-"));
    const env = { HOME: home, ORKESTR_HOME: home, ORKESTR_AUTO_RUN_THREAD_INPUT: "0", ORKESTR_AUTH_REQUIRED: "0",
      ORKESTR_THREAD_STORE: store, ORKESTR_THREAD_MESSAGE_STORE: store };
    const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    t.after(async () => {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });
    const { appendThreadMessage, createThread } = await import("../dist/server/packages/core/src/threads.js");
    const { ThreadMessagesController } = await import("../dist/server/apps/server/src/modules/threads/thread-messages.controller.js");
    const threadId = `example-no-reply-${store}`;
    await createThread({ id: threadId, ownerUserId: "admin" }, env);
    const user = await appendThreadMessage(threadId, { role: "user", text: "hello", source: "whatsapp_group_relay" }, env);
    await appendThreadMessage(threadId, { role: "assistant", phase: "final_answer", state: "completed", text: "NO_REPLY",
      parentMessageId: user.id, source: "remote-runtime" }, env);
    await appendThreadMessage(threadId, { role: "assistant", phase: "final_answer", state: "completed", text: "visible answer",
      parentMessageId: user.id }, env);
    const controller = new ThreadMessagesController({});
    const texts = async (request, query) => (await controller.messages(request, threadId, query)).messages.map((m) => m.text);

    const relay = await controller.messages({ orkestrMachineAuth: "cli" }, threadId, { limit: "200", includeNoReply: "1" });
    assert.deepEqual(relay.messages.map((m) => m.text), ["hello", "NO_REPLY", "visible answer"]);
    assert.equal(relay.includeNoReply, true);
    // UI sessions, other machine tokens and unauthenticated local callers never see it, flag or not.
    for (const request of [{}, { orkestrSecuritySession: { id: "browser" } }, { orkestrMachineAuth: "mobile_device" },
      { orkestrMachineAuth: "whatsapp_bridge" }, { orkestrMachineAuth: "broker_proxy" }]) {
      assert.deepEqual(await texts(request, { limit: "200", includeNoReply: "1" }), ["hello", "visible answer"], JSON.stringify(request));
      assert.deepEqual(await texts(request, { limit: "200" }), ["hello", "visible answer"]);
    }
    // The relay without the flag gets the default page too.
    assert.deepEqual(await texts({ orkestrMachineAuth: "cli" }, { limit: "200" }), ["hello", "visible answer"]);
    assert.deepEqual(await texts({ orkestrMachineAuth: "cli" }, { includeNoReply: "0" }), ["hello", "visible answer"]);
    // Unknown query parameters are still rejected.
    await assert.rejects(controller.messages({ orkestrMachineAuth: "cli" }, threadId, { includeSilent: "1" }),
      (error) => error.getStatus() === 400);
  });
}
