import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("router doctor controller wires bounded deadlines to HTTP 503 without post-timeout run events", async () => {
  const source = await fs.readFile("apps/server/src/modules/router-traces/router-traces.controller.ts", "utf8");

  assert.match(source, /@Res\(\{ passthrough: true \}\) response\?: any/);
  assert.match(source, /runDoctorWithDeadline\(run, timeoutMs, repair\)/);
  assert.match(source, /response\?\.status\?\.\(503\)/);
  assert.match(source, /recordRunEvent: false/);
  assert.match(source, /if \(!timedOut\)/);
  assert.match(source, /appendEvent\(routerDoctorRunEvent\(result/);
  assert.match(source, /router_doctor_repair_timeout_too_small/);
});
