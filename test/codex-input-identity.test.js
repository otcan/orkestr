import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThread, appendThreadMessage, listThreadMessages, updateThreadMessage } from "../packages/core/src/threads.js";
import { codexInputText } from "../packages/core/src/codex-app-server-common.js";
import { hydrateCodexAppServerThreadMessages } from "../packages/core/src/codex-app-server.js";
import { matchCanonicalInput, createSubmission, uniqueAcceptedSubmission, inputDigest } from "../packages/core/src/codex-input-identity.js";
import { reportInputRepair, applyInputRepair, rollbackInputRepair, planInputRepair } from "../packages/core/src/codex-input-repair.js";
import { publicEncryptedAttachmentMessage } from "../packages/core/src/encrypted-attachment-projection.js";
import ts from "typescript";
import { listEvents } from "../packages/storage/src/store.js";
import { readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ork-input-identity-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5 }));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_CODEX_ROLLOUT_GENERATION_MODE: "off" };
  const thread = await createThread({ id: "identity-thread", ownerUserId: "admin", name: "Synthetic identity" }, env);
  await fs.writeFile(path.join(home, "note.txt"), "Synthetic contents");
  return { env, thread, home };
}

for (const mode of ["text", "attachment", "attachment-only", "prompt-file", "prompt-file-only", "mailbox"]) test(`hydration preserves canonical ${mode} input across concurrent sync`, async t => {
  const { env, thread, home } = await fixture(t);
  const original = await appendThreadMessage(thread.id, { role: "user", source: "ui", state: "completed",
    text: mode === "attachment-only" ? "Attached: note.txt" : mode === "prompt-file-only" ? "" : "Inspect the sample", codexThreadId: "gen-a", codexTurnId: "turn-a",
    createdAt: "2026-09-01T10:00:00.000Z",
    ...(mode.startsWith("attachment") ? { attachments: [{ path: path.join(home, "note.txt"), filename: "note.txt" }] } : {}),
    ...(mode.startsWith("prompt-file") ? { promptFile: path.join(home, "prompt.txt") } : {}),
    ...(mode === "mailbox" ? { mailboxExecutionPolicy: "read_only_no_network_no_connectors_no_messaging_no_auth_no_browser_no_desktop" } : {}),
  }, env);
  const runtime = { id: "gen-a", turns: [{ id: "turn-a", status: "completed", completedAt: "2026-09-01T10:10:00Z", items: [
    { type: "userMessage", id: "item-a", content: [{ type: "text", text: codexInputText(original) }] },
    { type: "agentMessage", id: "answer-a", text: "Synthetic answer", phase: "final_answer" },
  ] }] };
  await Promise.all(Array.from({ length: 3 }, () => hydrateCodexAppServerThreadMessages(thread, runtime, env)));
  const rows = await listThreadMessages(thread.id, env), users = rows.filter(row => row.role === "user");
  assert.equal(users.length, 1); assert.equal(users[0].id, original.id);
  assert.equal(users[0].text, original.text); assert.equal(users[0].createdAt, original.createdAt);
  assert.deepEqual(users[0].attachments, original.attachments);
  assert.equal(users[0].codexItemId, "item-a");
  assert.equal(rows.filter(row => row.role === "assistant").length, 1);
  assert.equal(rows.find(row => row.role === "assistant").parentMessageId, original.id);
});

test("ambiguous, conflicting and cross-scope inputs are never collapsed", () => {
  const original = { id: "original", role: "user", source: "ui", text: "same", ownerUserId: "admin", codexThreadId: "gen-a", codexTurnId: "turn-a" };
  const imported = { ...original, id: "incoming", source: "codex-app-server-import", codexItemId: "item-a" };
  assert.equal(matchCanonicalInput([original, { ...original, id: "second" }], imported).outcome, "ambiguous");
  assert.equal(matchCanonicalInput([{ ...original, ownerUserId: "other" }], imported).message, null);
  assert.equal(matchCanonicalInput([{ ...original, codexThreadId: "other" }], imported).message, null);
  assert.equal(matchCanonicalInput([{ ...original, codexItemId: "different" }], imported).message, null);
  const items = ["a", "b"].map(id => ({ id, type: "userMessage", text: "same" }));
  assert.equal(matchCanonicalInput([original], imported, items).outcome, "ambiguous");
});

test("uncertain acceptance rejects old, ambiguous, cross-generation and unproven history", () => {
  const thread = { id: "thread", ownerUserId: "admin" }, input = { id: "input", ownerUserId: "admin", text: "same" };
  const old = { id: "old", startedAt: "2020-01-01T00:00:00Z", items: [{ id: "old-item", type: "userMessage", text: "same" }] };
  const submission = createSubmission(thread, input, "generation", "start", "", { id: "generation", turns: [old] });
  submission.startedAt = new Date(Date.now() - 1000).toISOString();
  const message = { ...input, codexSubmission: submission };
  const fresh = { id: "fresh", startedAt: new Date().toISOString(), items: [{ id: "new-item", type: "userMessage", text: "same" }] };
  const probe = turns => ({ ok: true, thread: { id: "generation", turns } });
  assert.equal(uniqueAcceptedSubmission(probe([old]), message), null);
  assert.equal(uniqueAcceptedSubmission(probe([old, fresh]), message).turn.id, "fresh");
  assert.equal(uniqueAcceptedSubmission(probe([fresh, { ...fresh, id: "second" }]), message), null);
  assert.equal(uniqueAcceptedSubmission({ ok: true, thread: { id: "other", turns: [fresh] } }, message), null);
  assert.equal(uniqueAcceptedSubmission(probe([fresh]), input), null);
  assert.equal(uniqueAcceptedSubmission(probe([{ ...fresh, startedAt: null }]), message), null);
  assert.equal(uniqueAcceptedSubmission(probe([fresh]), { ...message, text: "edited" }), null);
  assert.equal(publicEncryptedAttachmentMessage(message).codexSubmission, undefined);
});

test("report-only repair, idempotent supersession, parent integrity and rollback", async t => {
  const { env, thread, home } = await fixture(t);
  const original = await appendThreadMessage(thread.id, { role: "user", source: "ui", state: "completed", text: "Inspect",
    codexThreadId: "gen", codexTurnId: "turn", promptFile: path.join(home, "prompt.txt") }, env);
  const imported = await appendThreadMessage(thread.id, { role: "user", source: "codex-app-server-import", state: "completed",
    text: codexInputText(original), codexThreadId: "gen", codexTurnId: "turn", codexItemId: "item" }, env);
  const answer = await appendThreadMessage(thread.id, { role: "assistant", source: "manual", state: "completed", text: "Answer", parentMessageId: imported.id }, env);
  const before = await listThreadMessages(thread.id, env);
  const eventsBefore = await listEvents(env, 1000), outboxBefore = await readConnectorOutbox(env);
  const report = await reportInputRepair(thread.id, "admin", env);
  assert.deepEqual(await listThreadMessages(thread.id, env), before); assert.equal(report.candidates.length, 1);
  await assert.rejects(reportInputRepair(thread.id, "other", env), /owner_scope/);
  const manifestPath = path.join(home, "private", "repair.json");
  await assert.rejects(applyInputRepair(report, { manifestPath, approvalDigest: "wrong" }, env), /approval_mismatch/);
  const opts = { manifestPath, approvalDigest: report.approvalDigest };
  assert.equal((await applyInputRepair(report, opts, env)).repaired, 1);
  assert.equal((await applyInputRepair(report, opts, env)).duplicate, true);
  assert.deepEqual(await listEvents(env, 1000), eventsBefore);
  assert.deepEqual(await readConnectorOutbox(env), outboxBefore);
  const repaired = await listThreadMessages(thread.id, env);
  assert.equal(repaired.find(row => row.id === imported.id).supersededBy, original.id);
  assert.equal(repaired.find(row => row.id === answer.id).parentMessageId, original.id);
  assert.equal((await fs.stat(manifestPath)).mode & 0o777, 0o600);
  // Simulate a crash after storage commit but before manifest finalization.
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, status: "prepared" }));
  assert.equal((await applyInputRepair(report, opts, env)).duplicate, true);
  await rollbackInputRepair(manifestPath, report.approvalDigest, env);
  assert.deepEqual(await listThreadMessages(thread.id, env), before);
  // Simulate the analogous rollback-finalization crash.
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, status: "applied" }));
  assert.equal((await rollbackInputRepair(manifestPath, report.approvalDigest, env)).duplicate, true);
  await updateThreadMessage(thread.id, original.id, { text: "Changed" }, env);
  await assert.rejects(applyInputRepair(report, { ...opts, manifestPath: path.join(home, "other.json") }, env), /revision_conflict/);
});

test("repaired imports stay superseded through repeated hydration; rollback fences later writes", async t => {
  const { env, thread, home } = await fixture(t);
  const original = await appendThreadMessage(thread.id, { role: "user", source: "ui", state: "completed", text: "Inspect",
    codexThreadId: "gen", codexTurnId: "turn", promptFile: path.join(home, "prompt.txt") }, env);
  const imported = await appendThreadMessage(thread.id, { role: "user", source: "codex-app-server-import", state: "completed",
    text: codexInputText(original), codexThreadId: "gen", codexTurnId: "turn", codexItemId: "item" }, env);
  const report = await reportInputRepair(thread.id, "admin", env), manifestPath = path.join(home, "repair.json");
  await applyInputRepair(report, { manifestPath, approvalDigest: report.approvalDigest }, env);
  const history = { id: "gen", turns: [{ id: "turn", items: [{ type: "userMessage", id: "item", text: imported.text }] }] };
  await hydrateCodexAppServerThreadMessages(thread, history, env);
  await hydrateCodexAppServerThreadMessages(thread, history, env);
  const rows = await listThreadMessages(thread.id, env);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.id === imported.id).supersededBy, original.id);
  assert.equal(rows.find(row => row.id === original.id).text, "Inspect");
  await appendThreadMessage(thread.id, { role: "user", text: "New independent input" }, env);
  await assert.rejects(rollbackInputRepair(manifestPath, report.approvalDigest, env), /revision_conflict/);
});

test("repair refuses ambiguous originals and nonterminal inputs", () => {
  const row = { id: "a", role: "user", source: "ui", state: "completed", ownerUserId: "admin", text: "same", codexThreadId: "gen", codexTurnId: "turn" };
  const imported = { ...row, id: "import", source: "codex-app-server-import", codexItemId: "item" };
  for (const originals of [[row, { ...row, id: "b" }], [{ ...row, state: "awaiting_ack" }], []]) {
    const plan = planInputRepair({ id: "thread", ownerUserId: "admin" }, [...originals, imported]);
    assert.equal(plan.candidates.length, 0);
  }
});

test("repair rejects conflicting executor aliases, foreign thread rows and imported attachment claims", () => {
  const thread = { id: "thread", ownerUserId: "admin" };
  const row = { id: "original", role: "user", source: "ui", state: "completed", ownerUserId: "admin",
    text: "same", codexThreadId: "gen", codexTurnId: "turn" };
  const imported = { ...row, id: "import", source: "codex-app-server-import", codexItemId: "item" };
  for (const patch of [{ executorItemId: "conflict" }, { executorThreadId: "conflict" },
    { executorTurnId: "conflict" }, { threadId: "other" }]) {
    assert.equal(planInputRepair(thread, [{ ...row, ...patch }, imported]).candidates.length, 0);
    assert.equal(planInputRepair(thread, [row, { ...imported, ...patch }]).candidates.length, 0);
  }
  assert.equal(planInputRepair(thread, [row, { ...imported, attachments: [{ id: "claimed" }] }]).candidates.length, 0);
  assert.equal(planInputRepair(thread, [{ ...row, text: "edited", codexSubmission: {
    serializerVersion: 1, payloadDigest: inputDigest("same") } }, imported]).candidates.length, 0);
  assert.equal(planInputRepair(thread, [row, imported, { id: "foreign-reference", role: "assistant",
    ownerUserId: "other", parentMessageId: imported.id }]).candidates.length, 0);
  assert.throws(() => planInputRepair(thread, [row, row, imported]), /invalid_inventory/);
});

test("repair rebinds dependent parents even when the dependent is also an original", async t => {
  const { env, thread, home } = await fixture(t);
  const first = await appendThreadMessage(thread.id, { role: "user", source: "ui", state: "completed", text: "First",
    codexThreadId: "gen", codexTurnId: "turn-1" }, env);
  const firstImport = await appendThreadMessage(thread.id, { role: "user", source: "codex-app-server-import", state: "completed", text: "First",
    codexThreadId: "gen", codexTurnId: "turn-1", codexItemId: "item-1" }, env);
  const second = await appendThreadMessage(thread.id, { role: "user", source: "ui", state: "completed", text: "Second",
    codexThreadId: "gen", codexTurnId: "turn-2", parentMessageId: firstImport.id }, env);
  await appendThreadMessage(thread.id, { role: "user", source: "codex-app-server-import", state: "completed", text: "Second",
    codexThreadId: "gen", codexTurnId: "turn-2", codexItemId: "item-2" }, env);
  const report = await reportInputRepair(thread.id, "admin", env);
  assert.equal(report.candidates.length, 2);
  const manifestPath = path.join(home, "repair.json");
  await applyInputRepair(report, { manifestPath, approvalDigest: report.approvalDigest }, env);
  assert.equal((await listThreadMessages(thread.id, env)).find(row => row.id === second.id).parentMessageId, first.id);
  await rollbackInputRepair(manifestPath, report.approvalDigest, env);
  assert.equal((await listThreadMessages(thread.id, env)).find(row => row.id === second.id).parentMessageId, firstImport.id);
});

test("steering requires fresh item evidence, while a recorded response is authoritative", () => {
  const thread = { id: "thread", ownerUserId: "admin" }, input = { id: "input", ownerUserId: "admin", text: "same" };
  const s = createSubmission(thread, input, "gen", "steer", "active", { id: "gen", turns: [] });
  s.startedAt = new Date(Date.now() - 1000).toISOString();
  const item = { id: "item", type: "userMessage", text: "same", createdAt: new Date().toISOString() };
  const probe = turn => ({ ok: true, thread: { id: "gen", turns: [turn] } });
  assert.equal(uniqueAcceptedSubmission(probe({ id: "other", items: [item] }), { ...input, codexSubmission: s }), null);
  assert.equal(uniqueAcceptedSubmission(probe({ id: "active", items: [item] }), { ...input, codexSubmission: s }).item.id, "item");
  assert.equal(uniqueAcceptedSubmission(probe({ id: "active", items: [{ ...item, createdAt: null }] }), { ...input, codexSubmission: s }), null);
  assert.equal(uniqueAcceptedSubmission(probe({ id: "active", items: [] }), { ...input, codexSubmission: { ...s, acceptedTurnId: "active" } }).turn.id, "active");
});

test("supersession evicts cached browser messages even when absent from a page", async () => {
  const source = await fs.readFile(new URL("../apps/web/src/app/optimistic-thread-messages.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { mergeServerMessagesWithOptimistic } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
  const original = { id: "original", text: "user", role: "user" }, duplicate = { id: "duplicate", text: "expanded", role: "user" };
  assert.deepEqual(mergeServerMessagesWithOptimistic([], [original, duplicate], ["duplicate"]), [original]);
});

test("message pages preserve raw cursors, native repeated inputs and out-of-page tombstones", async () => {
  const { threadMessagePage } = await import("../dist/server/apps/server/src/modules/threads/thread-message-page.js");
  const input = { role: "user", source: "codex-app-server-import", text: "same", codexThreadId: "gen", codexTurnId: "turn" };
  const rows = [{ ...input, id: "original", codexItemId: "a" },
    { ...input, id: "hidden", visibility: "internal", supersededBy: "original" },
    { ...input, id: "distinct", codexItemId: "b", codexSubmission: { private: true } }];
  const page = threadMessagePage({ id: "thread" }, rows);
  assert.deepEqual(page.messages.map(m => [m.id, m.cursor]), [["original", 1], ["distinct", 3]]);
  assert.equal(page.messages[1].codexSubmission, undefined);
  const incremental = threadMessagePage({ id: "thread" }, rows, { since: 2, limit: 1 });
  assert.deepEqual(incremental.supersededMessageIds, ["hidden"]);
  assert.deepEqual(incremental.messages.map(m => m.id), ["distinct"]);
  const older = threadMessagePage({ id: "thread" }, rows, { before: 3, limit: 1 });
  assert.deepEqual(older.messages.map(m => m.id), ["original"]);
});
