import assert from "node:assert/strict";
import test from "node:test";
import { runJobSearchDemo } from "../scripts/job-search-demo.mjs";

test("job-search demo completes the WhatsApp-to-agent-to-WhatsApp loop", async () => {
  const result = await runJobSearchDemo({ port: 19824, log: false });

  assert.equal(result.run.execution.executorId, "job-search-demo");
  assert.equal(result.messages.length, 2);
  assert.equal(result.sent.length, 1);
  assert.equal(result.sent[0].body.to, "demo-chat@g.us");
  assert.match(result.sent[0].body.text, /Recruiting lead/);
});
