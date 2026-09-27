import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";

const boundWorker = {
  threadKind: "worker",
  parentThreadId: "parent-demo",
  binding: { connector: "whatsapp", enabled: true, mirrorToWhatsApp: true },
};

async function sendBodies(cases) {
  const bodies = [];
  const lookups = [];
  for (const { flags, thread } of cases) {
    const code = await runCli(["send", "worker-demo", ...flags, "Implement task", "--json"], {
      apiBase: "http://fixture.invalid", stdout: { write() {} }, stderr: { write() {} },
      fetchImpl: async (url, options = {}) => {
        if ((options.method || "GET") === "GET") {
          lookups.push(String(url));
          return new Response(JSON.stringify({ thread }), { status: 200 });
        }
        bodies.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ queued: true }), { status: 202 });
      },
    });
    assert.equal(code, 0);
  }
  return { bodies, lookups };
}

test("CLI worker reply delivery is a flag, not prompt text, and explicit flags skip the lookup", async () => {
  const { bodies, lookups } = await sendBodies([
    { flags: ["--reply-whatsapp", "--idempotency-key", "task-one"], thread: {} },
    { flags: ["--no-reply-whatsapp"], thread: boundWorker },
  ]);
  assert.equal(lookups.length, 0);
  assert.equal(bodies[0].workerReplyDelivery, "bound_whatsapp");
  assert.equal(bodies[0].text, "Implement task");
  assert.equal(bodies[0].idempotencyKey, "task-one");
  assert.equal(bodies[1].workerReplyDelivery, undefined);
});

test("CLI sends to a WhatsApp-bound worker reply to WhatsApp by default", async () => {
  const { bodies, lookups } = await sendBodies([{ flags: [], thread: boundWorker }]);
  assert.equal(lookups.length, 1);
  assert.equal(bodies[0].workerReplyDelivery, "bound_whatsapp");
});

test("CLI sends stay private by default for non-workers and ineligible bindings", async () => {
  const { bodies } = await sendBodies([
    { flags: [], thread: { ...boundWorker, threadKind: "thread", parentThreadId: null } },
    { flags: [], thread: { ...boundWorker, binding: { ...boundWorker.binding, enabled: false } } },
    { flags: [], thread: { ...boundWorker, binding: { ...boundWorker.binding, mirrorToWhatsApp: false } } },
    { flags: [], thread: { ...boundWorker, binding: { ...boundWorker.binding, retired: true } } },
    { flags: [], thread: { ...boundWorker, binding: null } },
  ]);
  assert.deepEqual(bodies.map((body) => body.workerReplyDelivery), [undefined, undefined, undefined, undefined, undefined]);
});
