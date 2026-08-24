import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyInstanceConfigPatch,
  emptyInstanceConfig,
  validateInstanceConfig,
} from "../packages/shared/src/instance-config-schema.js";
import {
  compareAndSwapInstanceConfig,
  instanceStatePaths,
  readInstanceConfig,
} from "../packages/storage/src/instance-config-repository.js";
import {
  observeLocalInstanceConfig,
  patchLocalInstanceConfig,
} from "../packages/core/src/instance-config-service.js";
import { writeInstanceIdentity } from "../packages/core/src/instance-identity.js";
import { readRuntimeSettings } from "../packages/core/src/runtime-settings.js";

async function testEnv(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-instance-config-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return {
    ORKESTR_HOME: home,
    ORKESTR_INSTANCE_ID: "test-instance/internal",
    ORKESTR_ADMIN_USER_ID: "admin",
  };
}

test("instance config schema rejects unknown and secret-bearing fields", () => {
  const current = emptyInstanceConfig("2026-01-01T00:00:00.000Z");
  assert.throws(
    () => validateInstanceConfig({ ...current, extra: {} }),
    /instance_config_unknown_top_level_field/,
  );
  assert.throws(
    () => applyInstanceConfigPatch(current, { connectors: { gmail: { refreshToken: "do-not-store" } } }),
    /instance_config_secret_field_forbidden/,
  );
  assert.throws(
    () => applyInstanceConfigPatch(current, { runtime: { client_secret: "do-not-store" } }),
    /instance_config_secret_field_forbidden/,
  );
  assert.throws(
    () => applyInstanceConfigPatch(current, { connectors: { gmail: { clientSecret: "do-not-store" } } }),
    /instance_config_secret_field_forbidden/,
  );
  assert.throws(
    () => applyInstanceConfigPatch(current, { metadata: { score: Number.POSITIVE_INFINITY } }),
    /instance_config_json_value_required/,
  );
  assert.throws(
    () => applyInstanceConfigPatch(current, { runtime: { codex: { command: "sudo anything" } } }),
    /instance_config_deployment_field_forbidden/,
  );
  assert.throws(
    () => applyInstanceConfigPatch(current, { connectors: { mcp: { url: "http:\/\/host.internal" } } }),
    /instance_config_deployment_field_forbidden/,
  );
  assert.throws(
    () => applyInstanceConfigPatch(current, { desktops: { items: [{ slug: "desk", profilePath: "\/host\/profile" }] } }),
    /instance_config_deployment_field_forbidden/,
  );
  const safe = applyInstanceConfigPatch(current, { connectors: { gmail: { enabled: true, connectionRef: "conn_demo" } } });
  assert.deepEqual(safe.connectors.gmail, { enabled: true, connectionRef: "conn_demo" });
});

test("instance config repository uses atomic generation compare-and-swap", async (t) => {
  const env = await testEnv(t);
  const instanceId = "internal/instance-id";
  const initial = await readInstanceConfig(instanceId, env);
  assert.equal(initial.generation, 0);
  const first = await compareAndSwapInstanceConfig(instanceId, 0, (current) => applyInstanceConfigPatch(current, {
    metadata: { label: "Demo" },
  }), env);
  assert.equal(first.next.generation, 1);
  assert.equal(first.next.metadata.label, "Demo");
  await assert.rejects(
    compareAndSwapInstanceConfig(instanceId, 0, (current) => current, env),
    (error) => error?.message === "instance_config_generation_conflict" && error?.statusCode === 409,
  );
  const statePaths = instanceStatePaths(instanceId, env);
  assert.ok(statePaths.desired.startsWith(path.join(env.ORKESTR_HOME, "instances")));
  assert.doesNotMatch(statePaths.desired, /internal\/instance-id/);
});

test("shared instance service reconciles supported desired state and reports observed generation", async (t) => {
  const env = await testEnv(t);
  await writeInstanceIdentity({
    internalInstanceId: "test-instance/internal",
    publicRef: "ins_AQEBAQEBAQEBAQEBAQEBAQ",
  }, env);
  const result = await patchLocalInstanceConfig({
    expectedGeneration: 1,
    patch: {
      runtime: { intervention: { manualDesktop: "desktop" } },
      connectors: { gmail: { enabled: true, authDesktop: "pa" } },
      desktops: { enabled: true, default: "desktop" },
    },
    actor: { kind: "user", userId: "admin", role: "admin", source: "test" },
    requestId: "req-test",
  }, env);
  assert.equal(result.config.generation, 2);
  assert.equal(result.status.state, "Ready");
  assert.equal(result.status.observedGeneration, 2);
  const runtime = await readRuntimeSettings(env);
  assert.equal(runtime.connectors.gmail.authDesktop, "pa");
  assert.equal(runtime.desktops.default, "desktop");
  const observed = await observeLocalInstanceConfig(env);
  assert.equal(observed.status.desiredGeneration, 2);
  assert.equal(observed.status.observedGeneration, 2);
});

test("unsupported desired sections remain separate from observed runtime status", async (t) => {
  const env = await testEnv(t);
  await writeInstanceIdentity({
    internalInstanceId: "test-instance/internal",
    publicRef: "ins_AQEBAQEBAQEBAQEBAQEBAQ",
  }, env);
  const result = await patchLocalInstanceConfig({
    expectedGeneration: 1,
    patch: { mailboxes: { inbound: { enabled: true } } },
  }, env);
  assert.equal(result.config.generation, 2);
  assert.equal(result.status.state, "NeedsAttention");
  assert.equal(result.status.observedGeneration, 0);
  assert.ok(result.status.conditions.some((condition) => condition.code === "reconciler_adapter_pending" && condition.subsystem === "mailboxes"));
});
