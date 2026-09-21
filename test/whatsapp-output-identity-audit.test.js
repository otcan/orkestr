import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { auditWhatsAppOutputIdentity } from "../packages/connectors/src/whatsapp-output-identity-audit.js";

const scope = { ownerUserId: "owner-a", threadId: "thread-a", accountId: "account-a", chatId: "chat-a",
  since: "2026-01-01T00:00:00Z", until: "2026-01-02T00:00:00Z" };
const job = (id, receipt = "receipt-a") => ({ ...scope, id, tenantId: "owner-a", connector: "whatsapp", deliveryType: "final",
  sourceRevision: "1", sourceMessageId: `projection-${id}`, sourceEventId: "private-event-with-body", state: "delivered",
  createdAt: "2026-01-01T12:00:00Z", brokerAck: { ids: [receipt] }, payload: { text: "PRIVATE MESSAGE" },
  metadata: { runtimeGeneration: "gen-a", runtimeTurnId: "turn-a", runtimeItemId: "item-a" } });

test("report groups ACK aliases separately from distinct receipt sets and never mutates snapshots", () => {
  const snapshot = { jobs: [job("a"), job("b"), job("c", "receipt-b"), { ...job("excluded"), ownerUserId: "other" }], complete: true };
  const before = structuredClone(snapshot);
  const report = auditWhatsAppOutputIdentity(snapshot, scope);
  assert.deepEqual(snapshot, before);
  assert.equal(report.selectedJobs, 3); assert.equal(report.groups.length, 1);
  assert.equal(report.groups[0].distinctReceiptSets, 2);
  assert.equal(report.groups[0].reason, "multiple_receipt_sets");
  assert.equal(report.groups[0].disposition, "operator_review_only");
  assert.equal(report.automaticReplay, false); assert.equal(report.automaticRepair, false);
  for (const sensitive of ["PRIVATE MESSAGE", "private-event", "receipt-a", "projection-a", "owner-a", "thread-a", "chat-a"]) {
    assert.equal(JSON.stringify(report).includes(sensitive), false);
  }
});

test("report keeps incomplete, missing and conflicting evidence in manual review", () => {
  const original = job("a");
  const projection = { id: original.sourceMessageId, ownerUserId: scope.ownerUserId, threadId: scope.threadId,
    role: "assistant", phase: "final_answer", codexThreadId: "other-generation", codexTurnId: "turn-a", codexItemId: "item-a" };
  assert.equal(auditWhatsAppOutputIdentity({ jobs: [original], messages: [projection], complete: true }, scope).unresolved.length, 1);
  assert.equal(auditWhatsAppOutputIdentity({ jobs: [original] }, scope).groups[0].reason, "incomplete_inventory");
  assert.equal(auditWhatsAppOutputIdentity({ jobs: [{ ...original, brokerAck: null }], complete: true }, scope).groups[0].reason, "receipt_evidence_incomplete");
  const aliases = auditWhatsAppOutputIdentity({ jobs: [original, job("b")], complete: true }, scope);
  assert.equal(aliases.groups[0].reason, "shared_receipt_aliases");
  assert.equal(aliases.groups[0].distinctReceiptSets, 1);
});

test("report requires bounded owner/destination/window scope and preserves distinct turns", () => {
  assert.throws(() => auditWhatsAppOutputIdentity({}, {}), /scope_required/);
  assert.throws(() => auditWhatsAppOutputIdentity({}, { ...scope, since: "invalid" }), /window_invalid/);
  assert.throws(() => auditWhatsAppOutputIdentity({ jobs: Array(10001).fill(job("a")) }, scope), /inventory_limit/);
  const original = job("a");
  const next = { ...job("b"), metadata: { ...original.metadata, runtimeTurnId: "next-turn" } };
  assert.equal(auditWhatsAppOutputIdentity({ jobs: [original, next], complete: true }, scope).groups.length, 2);
});

test("offline report command leaves input files unchanged and rejects apply mode", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "output-audit-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const snapshotPath = path.join(dir, "snapshot.json"), scopePath = path.join(dir, "scope.json");
  const snapshotText = JSON.stringify({ jobs: [job("a"), job("b")], complete: true });
  await fs.writeFile(snapshotPath, snapshotText); await fs.writeFile(scopePath, JSON.stringify(scope));
  const script = fileURLToPath(new URL("../scripts/whatsapp-output-identity-audit.mjs", import.meta.url));
  const args = [script, "--snapshot", snapshotPath, "--scope", scopePath];
  const result = await promisify(execFile)(process.execPath, args);
  assert.equal(JSON.parse(result.stdout).groups[0].reason, "shared_receipt_aliases");
  assert.equal(await fs.readFile(snapshotPath, "utf8"), snapshotText);
  await assert.rejects(promisify(execFile)(process.execPath, [...args, "--apply"]), error => error.code === 2);
});
