import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("canonical URL release gate plans every deterministic security surface", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-canonical-gate-"));
  const artifact = path.join(home, "evidence.json");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    "scripts/canonical-url-release-gate.mjs",
    "--plan",
    "--artifact",
    artifact,
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(await fs.readFile(artifact, "utf8"));
  assert.equal(evidence.gate, "canonical_urls");
  assert.equal(evidence.ok, true);
  assert.deepEqual(evidence.results, []);
  const planned = evidence.plan.flatMap((stage) => stage.command);
  for (const required of [
    "test/canonical-public-references.test.js",
    "test/broker-instance-registration.test.js",
    "test/canonical-app-gateway.test.js",
    "test/canonical-app-links.test.js",
    "test/canonical-thread-navigation.test.js",
    "test/canonical-url-release-gate.test.js",
    "test/host-boundaries.test.js",
    "test/upgrade-forwarded-headers.test.js",
    "test/security.test.js",
    "test/static-ui.test.js",
  ]) assert.ok(planned.includes(required), required);
  assert.ok(evidence.plan.some((stage) => stage.id === "server_build"));
  assert.ok(evidence.plan.some((stage) => stage.id === "web_build"));
  assert.ok(evidence.plan.some((stage) => stage.id === "oss_boundary"));
  assert.equal(planned.some((item) => /whatsapp-real|deploy|update/.test(item)), false);
});
