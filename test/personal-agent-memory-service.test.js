import assert from "node:assert/strict";
import test from "node:test";
import { createPersonalAgentMemoryService } from "../packages/core/src/personal-agent-memory-service.js";
import { fakeMemoryStore, memoryInput, memoryOwnerRequest as owner, memorySource } from "./fixtures/personal-agent-memory-store.js";

function setup(extra = {}) {
  const store = extra.store || fakeMemoryStore(); let id = 0;
  const service = createPersonalAgentMemoryService({ store, ownerUserId: "owner-fixture", env: { ORKESTR_PERSONAL_AGENT_ENABLED: "1" }, now: () => "2026-01-01T01:00:00.000Z", newId: () => `mem_${++id}`, ...extra });
  const save = (input = memoryInput(), action = "remember") => { const proposal = service.propose(input, owner); return service.create(proposal, owner, { action, digest: proposal.digest }); };
  return { store, service, save };
}

test("feature-off, machine/system/anonymous and other-user access make no store calls", () => {
  const { store, service } = setup();
  for (const request of [{}, { orkestrPrincipal: { kind: "system", userId: "owner-fixture", role: "admin" } }, { orkestrPrincipal: { ...owner.orkestrPrincipal, userId: "other-owner" } }, { ...owner, orkestrAnonymous: true }, { ...owner, orkestrMachineAuth: "fixture-machine" }]) {
    assert.throws(() => service.retrieve({}, request), /owner_required/);
    assert.throws(() => service.export(request), /owner_required/);
    assert.throws(() => service.propose(memoryInput(), request), /owner_required/);
  }
  const disabled = setup({ store, env: {} }).service;
  assert.throws(() => disabled.export(owner), /personal_agent_disabled/);
  assert.equal(store.calls, 0);
});

test("proposing, declining and missing consent persist nothing", () => {
  const { store, service } = setup();
  const proposal = service.propose(memoryInput(), owner);
  assert.equal(store.calls, 0);
  assert.throws(() => service.create(proposal, owner), /explicit_consent_required/);
  assert.throws(() => service.create(proposal, owner, { action: "decline", digest: proposal.digest }), /explicit_consent_required/);
  assert.deepEqual(store.rows(), []);
});

test("capture requires exact consent and retries deduplicate without changing consent timestamps", () => {
  const { service, store, save } = setup();
  const first = save(); const again = save();
  assert.equal(first.deduplicated, false); assert.equal(again.deduplicated, true);
  assert.deepEqual(first.record, again.record); assert.equal(store.rows().length, 1);
  const other = service.propose(memoryInput({ content: { statement: "Different approved fact" } }), owner);
  assert.throws(() => service.create(other, owner, { action: "remember", digest: other.digest }), /idempotency_conflict/);
  const tampered = structuredClone(other); tampered.candidate.sourceCursor = "cursor-other";
  assert.throws(() => service.create(tampered, owner, { action: "remember", digest: other.digest }), /proposal_changed/);
});

test("source event references and descriptive provenance survive service recreation", () => {
  const { save, store } = setup();
  const record = save(memoryInput({ source: { ...memorySource, sourceKind: "web", actorId: "web-fixture" }, sourceEventId: "evt-fixture", sourceCursor: "cursor-fixture" }), "approve").record;
  const fresh = setup({ store: fakeMemoryStore({ rows: JSON.parse(JSON.stringify(store.rows())) }) }).service;
  assert.deepEqual(fresh.retrieve({}, owner), [record]);
  assert.equal(record.provenance.trust, "owner_confirmed");
  assert.equal(record.sourceEventId, "evt-fixture");
});

test("project retrieval combines owner and exact project; it never reads referenced threads", () => {
  const { service, save } = setup();
  const global = save().record;
  const alpha = save(memoryInput({ scope: { kind: "project", id: "project-alpha" }, idempotencyKey: "save-alpha" })).record;
  const beta = save(memoryInput({ scope: { kind: "project", id: "project-beta" }, idempotencyKey: "save-beta" })).record;
  assert.deepEqual(service.retrieve({}, owner).map(r => r.id), [global.id]);
  assert.deepEqual(service.retrieve({ projectId: "project-alpha" }, owner).map(r => r.id), [alpha.id, global.id]);
  assert.ok(!service.context({ projectId: "project-alpha" }, owner).text.includes(beta.id));
  assert.throws(() => service.retrieve({ projectId: "missing-project" }, owner), /project_not_found/);
});

test("task memories must match the existing task's owning project; they create no tasks", () => {
  const { save, store } = setup();
  const input = memoryInput({ category: "open_loop", scope: { kind: "project", id: "project-alpha" }, content: { summary: "Await synthetic review", taskId: "task-alpha" }, source: { ...memorySource, taskId: "task-alpha" } });
  assert.equal(save(input).record.content.taskId, "task-alpha");
  assert.throws(() => save({ ...input, scope: { kind: "project", id: "project-beta" }, idempotencyKey: "save-wrong" }), /task_scope_mismatch/);
  assert.equal(store.rows().length, 1);
});

test("correction replaces content and provenance, rejects stale decisions and retains no old value", () => {
  const { service, store, save } = setup();
  const first = save().record;
  const proposal = service.proposeCorrection(first.id, { content: { statement: "Corrected synthetic color is green." }, source: { ...memorySource, origin: "cli" }, sourceEventId: "evt-correction" }, owner);
  const corrected = service.correct(proposal, owner, { action: "correct", digest: proposal.digest });
  assert.equal(corrected.id, first.id); assert.equal(corrected.createdAt, first.createdAt);
  assert.ok(corrected.updatedAt > first.updatedAt);
  assert.equal(corrected.sourceEventId, "evt-correction");
  assert.ok(!JSON.stringify(store.rows()).includes("teal"));
  assert.ok(!JSON.stringify(service.export(owner)).includes("teal"));
  assert.throws(() => service.correct(proposal, owner, { action: "correct", digest: proposal.digest }), /correction_stale/);
  assert.throws(() => service.proposeCorrection(first.id, { content: { statement: "x" }, source: memorySource, scope: { kind: "project", id: "project-alpha" } }, owner), /invalid_fields/);
});

test("forget binds to exact id/version and removes the row, context and exported content", () => {
  const { service, store, save } = setup();
  const first = save().record;
  const second = save(memoryInput({ idempotencyKey: "save-second", content: { statement: "Keep this other synthetic fact" } })).record;
  const proposal = service.proposeForget(first.id, owner);
  assert.ok(!JSON.stringify(proposal).includes("teal"));
  assert.throws(() => service.forget({ ...proposal, memoryId: second.id }, owner, { action: "forget", digest: proposal.digest }), /consent_mismatch/);
  assert.deepEqual(service.forget(proposal, owner, { action: "forget", digest: proposal.digest }), { id: first.id, forgotten: true });
  assert.equal(store.rows().length, 1);
  assert.ok(!service.context({}, owner).text.includes("teal"));
  assert.ok(!JSON.stringify(service.export(owner)).includes("teal"));
  assert.throws(() => service.forget(proposal, owner, { action: "forget", digest: proposal.digest }), /not_found/);
});

test("a correction invalidates an earlier forget decision", () => {
  const { service, save } = setup(); const record = save().record;
  const forget = service.proposeForget(record.id, owner);
  const change = service.proposeCorrection(record.id, { content: { statement: "new" }, source: memorySource }, owner);
  service.correct(change, owner, { action: "correct", digest: change.digest });
  assert.throws(() => service.forget(forget, owner, { action: "forget", digest: forget.digest }), /forget_stale/);
});

test("export is deterministic, independent of model configuration, and contains only current rows", () => {
  const { service, save } = setup();
  save(); save(memoryInput({ idempotencyKey: "save-other", scope: { kind: "project", id: "project-alpha" } }));
  assert.equal(JSON.stringify(service.export(owner)), JSON.stringify(service.export(owner)));
  assert.equal(service.export(owner).records.length, 2);
});

test("corrupt consent/provenance cannot silently become retrieved or exported memory", () => {
  const initial = setup(); initial.save();
  for (const mutate of [row => { row.consented_by = "other-owner"; }, row => { row.provenance_json = JSON.stringify({ ...JSON.parse(row.provenance_json), sourceBody: "untrusted payload" }); }, row => { row.provenance_json = JSON.stringify({ ...JSON.parse(row.provenance_json), trust: "automatic" }); }]) {
    const rows = initial.store.rows(); mutate(rows[0]);
    const { service } = setup({ store: fakeMemoryStore({ rows }) });
    assert.throws(() => service.retrieve({}, owner), /stored_record_invalid/);
    assert.throws(() => service.export(owner), /stored_record_invalid/);
  }
});

test("failed transaction leaves no partial memory and errors contain no candidate text", () => {
  const store = fakeMemoryStore();
  const baseTransaction = store.transaction;
  store.transaction = fn => baseTransaction(tx => fn({ ...tx, insert(row) { tx.insert(row); throw Error("synthetic_storage_failure"); } }));
  const { save } = setup({ store });
  assert.throws(() => save(), error => error.message === "synthetic_storage_failure" && !error.message.includes("teal"));
  assert.deepEqual(store.rows(), []);
});
