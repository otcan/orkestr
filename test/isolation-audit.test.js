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

test("isolated demo audit accepts a public UUID-scoped setup URL artifact", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-isolation-audit-setup-pass-"));
  const instanceId = "11111111-2222-4333-8444-555555555555";
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_INSTANCE_DESKTOPS_PROVISIONED: "0",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "__none__",
    ORKESTR_ISOLATION_EXPECT_INSTANCE_ID: instanceId,
  };
  await fs.writeFile(path.join(home, "demo-vm-ready-notification.json"), JSON.stringify({
    sent: true,
    setupUrl: `https://connect.orkestr.de/i/${instanceId}/setup`,
    instanceId,
  }));

  const result = await auditIsolatedDemoInstance(env);
  const check = result.checks.find((item) => item.name === "setup-url:public-instance-scoped");

  assert.equal(result.ok, true);
  assert.equal(check.ok, true);
  assert.equal(check.instanceId, instanceId);
});

test("isolated demo audit rejects unsafe or generic setup URL artifacts", async () => {
  const cases = [
    {
      name: "loopback",
      setupUrl: "http://127.0.0.1:3000/i/11111111-2222-4333-8444-555555555555/setup",
      reason: "setup_url_loopback",
      instanceId: "11111111-2222-4333-8444-555555555555",
    },
    {
      name: "generic",
      setupUrl: "https://connect.orkestr.de/setup",
      reason: "setup_url_missing_instance_uuid",
      instanceId: "11111111-2222-4333-8444-555555555555",
    },
    {
      name: "mismatch",
      setupUrl: "https://connect.orkestr.de/i/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/setup",
      reason: "setup_url_instance_mismatch",
      instanceId: "11111111-2222-4333-8444-555555555555",
    },
  ];

  for (const item of cases) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-isolation-audit-setup-${item.name}-`));
    const env = {
      ORKESTR_HOME: home,
      ORKESTR_INSTANCE_DESKTOPS_PROVISIONED: "0",
      ORKESTR_BROWSER_VISIBLE_SLUGS: "__none__",
      ORKESTR_ISOLATION_EXPECT_INSTANCE_ID: item.instanceId,
    };
    await fs.writeFile(path.join(home, "demo-vm-ready-notification.json"), JSON.stringify({
      sent: true,
      setupUrl: item.setupUrl,
      instanceId: item.instanceId,
    }));

    const result = await auditIsolatedDemoInstance(env);
    const check = result.checks.find((entry) => entry.name === "setup-url:public-instance-scoped");

    assert.equal(result.ok, false, item.name);
    assert.equal(check.ok, false, item.name);
    assert.equal(check.reason, item.reason);
  }
});

test("isolated demo audit rejects ambient host browserctl backends", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-isolation-audit-browserctl-host-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_DESKTOP_MODE: "browserctl",
    ORKESTR_BROWSERCTL_PATH: "/usr/local/bin/browserctl",
    ORKESTR_INSTANCE_DESKTOPS_PROVISIONED: "0",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "__none__",
  };

  const result = await auditIsolatedDemoInstance(env);
  const check = result.checks.find((item) => item.name === "desktops:browserctl-scoped-to-instance");

  assert.equal(result.ok, false);
  assert.equal(check.ok, false);
  assert.equal(check.browserctlPath, "/usr/local/bin/browserctl");
});

test("isolated demo audit allows packaged VM-local browserctl", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-isolation-audit-browserctl-local-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_DESKTOP_MODE: "browserctl",
    ORKESTR_BROWSERCTL_PATH: "/app/scripts/browserctl.mjs",
    ORKESTR_BROWSER_API_URL: "http://127.0.0.1:6080",
    ORKESTR_INSTANCE_DESKTOPS_PROVISIONED: "0",
    ORKESTR_BROWSER_VISIBLE_SLUGS: "__none__",
  };

  const result = await auditIsolatedDemoInstance(env);
  const check = result.checks.find((item) => item.name === "desktops:browserctl-scoped-to-instance");

  assert.equal(result.ok, true);
  assert.equal(check.ok, true);
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
