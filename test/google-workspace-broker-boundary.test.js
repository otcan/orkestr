import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTenantVm } from "../packages/core/src/tenant-vm-registry.js";
import {
  assertBrokerGoogleWorkspaceGrantDestination,
  assertBrokerGoogleWorkspaceTenant,
} from "../packages/connectors/src/google-workspace-broker-boundary.js";

test("brokered Gmail link cannot target another instance's VM or owner", async () => {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-broker-boundary-")) };
  await createTenantVm({ id: "alice-vm", ownerUserId: "alice", labels: { brokerInstanceId: "instance-alice" } }, env);
  await createTenantVm({ id: "bob-vm", ownerUserId: "bob", labels: { brokerInstanceId: "instance-bob" } }, env);
  const alice = { instanceId: "instance-alice" };
  assert.deepEqual(await assertBrokerGoogleWorkspaceTenant(alice, { tenantVmId: "alice-vm", userId: "alice" }, env), {
    tenantVmId: "alice-vm", userId: "alice",
  });
  await assert.rejects(
    () => assertBrokerGoogleWorkspaceTenant(alice, { tenantVmId: "bob-vm", userId: "bob" }, env),
    /broker_google_workspace_tenant_mismatch/,
  );
  await assert.rejects(
    () => assertBrokerGoogleWorkspaceTenant(alice, { tenantVmId: "alice-vm", userId: "bob" }, env),
    /broker_google_workspace_tenant_mismatch/,
  );
  await assert.rejects(
    () => assertBrokerGoogleWorkspaceTenant(alice, { tenantVmId: "missing-vm", userId: "alice" }, env),
    /broker_google_workspace_tenant_not_found/,
  );
});

test("a brokered Gmail grant is accepted only by its registered tenant VM", () => {
  const env = { ORKESTR_TENANT_VM_ID: "alice-vm" };
  const registration = { instanceId: "instance-alice" };
  assert.deepEqual(assertBrokerGoogleWorkspaceGrantDestination(registration, {
    brokerInstanceId: "instance-alice", tenantVmId: "alice-vm",
  }, env), { brokerInstanceId: "instance-alice", tenantVmId: "alice-vm" });
  assert.throws(() => assertBrokerGoogleWorkspaceGrantDestination(registration, {
    brokerInstanceId: "instance-bob", tenantVmId: "alice-vm",
  }, env), /broker_google_workspace_grant_destination_mismatch/);
  assert.throws(() => assertBrokerGoogleWorkspaceGrantDestination(registration, {
    brokerInstanceId: "instance-alice", tenantVmId: "bob-vm",
  }, env), /broker_google_workspace_grant_destination_mismatch/);
});
