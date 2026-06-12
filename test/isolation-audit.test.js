import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { __brokerInstanceRegistryTestInternals, registerBrokerInstance } from "../packages/core/src/broker-instance-registry.js";
import { auditIsolatedDemoInstance } from "../scripts/audit-isolated-demo-instance.mjs";

test("isolated demo audit passes for an empty unprovisioned VM home with sqlite broker", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-isolation-audit-pass-"));
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_INSTANCE_STORE: "sqlite",
    ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
    ORKESTR_INSTANCE_DESKTOPS_PROVISIONED: "0",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "__none__",
    ORKESTR_ISOLATION_EXPECT_SQLITE_BROKER: "1",
  };
  await registerBrokerInstance({
    env,
    request: { ip: "127.0.0.1", headers: { authorization: "Bearer register-secret" } },
    body: { encryptionPublicKey: client.publicKey, displayName: "isolated audit vm" },
  });

  const result = await auditIsolatedDemoInstance(env);

  assert.equal(result.ok, true);
  assert.equal(result.summary.failed, 0);
  assert.ok(result.checks.some((check) => check.name === "broker:sqlite-registry-present" && check.ok));
  assert.ok(result.checks.some((check) => check.name === "desktops:unprovisioned-fails-closed" && check.ok));
});

test("isolated demo audit fails when parent desktop/thread names leak into state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-isolation-audit-fail-"));
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, "threads.json"), JSON.stringify([
    { id: "bad", name: "synbiobeta leaked parent thread" },
  ]));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_INSTANCE_STORE: "json",
    ORKESTR_INSTANCE_DESKTOPS_PROVISIONED: "0",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "__none__",
  };

  const result = await auditIsolatedDemoInstance(env);
  const leakCheck = result.checks.find((check) => check.name === "state:no-forbidden-parent-names");

  assert.equal(result.ok, false);
  assert.equal(leakCheck.ok, false);
  assert.deepEqual(leakCheck.forbiddenMatches, ["synbiobeta"]);
});
