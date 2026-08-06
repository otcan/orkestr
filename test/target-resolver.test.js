import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listEvents } from "../packages/storage/src/store.js";
import { resolveTargetInstance, requireResolvedTargetInstance } from "../packages/core/src/target-resolver.js";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-target-resolver-"));
  return { ORKESTR_HOME: home };
}

test("target resolver fails closed instead of choosing the first authorized candidate", async () => {
  const env = await fixture();
  const result = await resolveTargetInstance({
    targetType: "oxrm",
    principal: userPrincipal({ id: "alice" }),
    action: "oxrm.skill.execute",
    candidates: [
      { id: "oxrm-a", type: "oxrm", ownerUserId: "alice", status: "active", eligible: true },
      { id: "oxrm-b", type: "oxrm", ownerUserId: "alice", status: "active", eligible: true },
    ],
  }, env);

  assert.equal(result.ok, false);
  assert.equal(result.error, "instance_selection_required");
  assert.equal(result.ambiguityResult, "multiple_match");
  assert.equal(result.candidates.length, 2);
  assert.equal(result.selectedTarget, null);
});

test("target resolver records single-target inference provenance", async () => {
  const env = await fixture();
  const result = await requireResolvedTargetInstance({
    targetType: "tenant_vm",
    principal: userPrincipal({ id: "alice" }),
    action: "vm.skill.execute",
    candidates: [
      { id: "alice-vm", type: "tenant_vm", ownerUserId: "alice", status: "running", eligible: true },
    ],
  }, env);

  assert.equal(result.ok, true);
  assert.equal(result.selectedTarget.id, "alice-vm");
  assert.equal(result.selectionSource, "single_authorized_target");
  assert.equal(result.ambiguityResult, "single_match");

  const events = await listEvents(env, 10);
  assert.equal(events.some((event) =>
    event.type === "target_instance_resolved" &&
    event.selectedInstanceId === "alice-vm" &&
    event.selectionSource === "single_authorized_target"
  ), true);
});

test("target resolver rejects explicit targets outside owner scope", async () => {
  const env = await fixture();

  await assert.rejects(
    () => requireResolvedTargetInstance({
      targetType: "oxrm",
      explicitTargetId: "bob-oxrm",
      principal: userPrincipal({ id: "alice" }),
      action: "oxrm.skill.execute",
      candidates: [
        { id: "bob-oxrm", type: "oxrm", ownerUserId: "bob", status: "active", eligible: true },
      ],
    }, env),
    /target_unauthorized/,
  );
});

test("target resolver does not fall back when an explicit target becomes stale", async () => {
  const env = await fixture();

  await assert.rejects(
    () => requireResolvedTargetInstance({
      targetType: "desktop",
      explicitTargetId: "desk-a",
      principal: adminPrincipal(),
      action: "desktop.skill.execute",
      candidates: [
        { id: "desk-a", type: "desktop", ownerUserId: "admin", status: "stopped", eligible: false },
        { id: "desk-b", type: "desktop", ownerUserId: "admin", status: "active", eligible: true },
      ],
    }, env),
    /target_stale/,
  );
});

test("target resolver keeps concurrent explicit target selections request scoped", async () => {
  const env = await fixture();
  const candidates = [
    { id: "desk-a", type: "desktop", ownerUserId: "admin", status: "active", eligible: true },
    { id: "desk-b", type: "desktop", ownerUserId: "admin", status: "active", eligible: true },
  ];

  const [left, right] = await Promise.all([
    requireResolvedTargetInstance({ targetType: "desktop", explicitTargetId: "desk-a", principal: adminPrincipal(), candidates }, env),
    requireResolvedTargetInstance({ targetType: "desktop", explicitTargetId: "desk-b", principal: adminPrincipal(), candidates }, env),
  ]);

  assert.equal(left.selectedTarget.id, "desk-a");
  assert.equal(right.selectedTarget.id, "desk-b");
  assert.equal(left.selectionSource, "explicit_request");
  assert.equal(right.selectionSource, "explicit_request");
});
