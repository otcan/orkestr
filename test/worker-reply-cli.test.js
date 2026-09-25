import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";

test("CLI worker reply opt-in is not prompt text and ordinary sends remain private", async () => {
  const bodies = [];
  for (const flags of [[], ["--reply-whatsapp", "--idempotency-key", "task-one"]]) {
    const code = await runCli(["send", "worker-demo", ...flags, "Implement task", "--json"], {
      apiBase: "http://fixture.invalid", stdout: { write() {} }, stderr: { write() {} },
      fetchImpl: async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ queued: true }), { status: 202 });
      },
    });
    assert.equal(code, 0);
  }
  assert.equal(bodies[0].workerReplyDelivery, undefined);
  assert.equal(bodies[1].workerReplyDelivery, "bound_whatsapp");
  assert.equal(bodies[1].text, "Implement task");
  assert.equal(bodies[1].idempotencyKey, "task-one");
});
