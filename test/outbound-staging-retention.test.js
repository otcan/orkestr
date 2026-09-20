import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createThread } from "../packages/core/src/threads.js";
import { createThreadMessageRepository } from "../packages/storage/src/repositories.js";
import { dataPaths } from "../packages/storage/src/paths.js";
import { retainOutboundStagingJournals } from "../packages/connectors/src/outbound-staging-retention.js";
import { ensureConnectorOutboxJob, claimConnectorOutboxJob } from "../packages/connectors/src/connector-outbox.js";
import { withConnectorOutboxMutation } from "../packages/connectors/src/connector-outbox-lock.js";

const hash = value => createHash("sha256").update(value).digest("hex");
async function fixture(t, store = "json") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-retention-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_THREAD_MESSAGE_STORE: store,
    ORKESTR_CONNECTOR_OUTBOX_STORE: store, ORKESTR_STAGING_RETENTION_FENCED: "1" };
  const thread = await createThread({ id: "retention-test", name: "Retention fixture", ownerUserId: "admin" }, env);
  const dir = path.join(home, "outbound-attachment-staging", hash(`admin\n${thread.id}`));
  await fs.mkdir(dir, { recursive: true });
  const repository = createThreadMessageRepository(env);
  const run = options => retainOutboundStagingJournals({ threadId: thread.id, ownerUserId: "admin", env, ...options });
  async function journal(seed, extra = {}) {
    const id = `stg_${hash(seed)}`;
    const record = { version: 1, id, ownerUserId: "admin", threadId: thread.id, messageId: seed,
      textHash: hash("fixture"), state: "ready", updatedAt: "2000-01-01T00:00:00Z", ...extra };
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(record));
    return record;
  }
  return { home, env, thread, dir, repository, run, journal };
}

for (const store of ["json", "sqlite"]) test(`${store}: retention pins canonical message and delivery references`, async t => {
  const f = await fixture(t, store);
  const referenced = await f.journal("message-reference"), delivered = await f.journal("outbox-reference");
  const incomplete = await f.journal("incomplete", { state: "failed_retryable" });
  const recent = await f.journal("recent", { updatedAt: new Date().toISOString() });
  const orphan = await f.journal("orphan");
  await f.repository.save(f.thread.id, [{ id: referenced.messageId, text: "fixture", ownerUserId: "admin",
    outboundAttachmentStaging: { id: referenced.id } }]);
  await ensureConnectorOutboxJob({ connector: "whatsapp", threadId: f.thread.id, tenantId: "admin",
    sourceMessageId: delivered.messageId, sourceEventId: delivered.messageId, state: "delivered" }, f.env);
  assert.deepEqual((await f.run()).eligible, [orphan.id]);
  assert.equal((await fs.stat(path.join(f.dir, `${orphan.id}.json`))).isFile(), true);
  const artifact = path.join(f.home, "artifact.txt");
  await fs.writeFile(artifact, "must survive");
  assert.deepEqual((await f.run({ apply: true })).quarantined, [orphan.id]);
  assert.deepEqual((await f.run({ apply: true })).quarantined, []);
  for (const journal of [referenced, delivered, incomplete, recent]) await fs.access(path.join(f.dir, `${journal.id}.json`));
  await fs.access(path.join(f.dir, "retained", `${orphan.id}.json`));
  assert.equal(await fs.readFile(artifact, "utf8"), "must survive");
});

test("stale history writer restores an exact quarantined reference, rejects edited content", async t => {
  const f = await fixture(t), orphan = await f.journal("stale-writer");
  await f.run({ apply: true });
  const message = { id: orphan.messageId, text: "fixture", ownerUserId: "admin", outboundAttachmentStaging: { id: orphan.id } };
  await assert.rejects(f.repository.save(f.thread.id, [{ ...message, text: "edited" }]), /binding_mismatch/);
  await f.repository.save(f.thread.id, [message]);
  await fs.access(path.join(f.dir, `${orphan.id}.json`));
  assert.deepEqual((await f.run({ apply: true })).quarantined, []);
});

test("retention resumes interrupted link-before-unlink without clobbering conflicts", async t => {
  const f = await fixture(t), orphan = await f.journal("interrupted");
  await fs.mkdir(path.join(f.dir, "retained"));
  const source = path.join(f.dir, `${orphan.id}.json`), target = path.join(f.dir, "retained", `${orphan.id}.json`);
  await fs.writeFile(target, "different journal");
  await assert.rejects(f.run({ apply: true }), /quarantine_conflict/);
  await fs.access(source);
  await fs.unlink(target);
  await fs.link(source, target);
  assert.deepEqual((await f.run({ apply: true })).quarantined, [orphan.id]);
});

test("retention fails closed on scope, writer protocol, malformed inventory and symlink", async t => {
  const f = await fixture(t), orphan = await f.journal("protected");
  await assert.rejects(f.run({ ownerUserId: "different-owner" }), /scope_mismatch/);
  await assert.rejects(f.run({ apply: true, env: { ...f.env, ORKESTR_STAGING_RETENTION_FENCED: "0" } }), /coordinated_writers/);
  await fs.writeFile(dataPaths(f.env).connectorOutbox, "malformed");
  await assert.rejects(f.run({ apply: true }), SyntaxError);
  await fs.writeFile(dataPaths(f.env).connectorOutbox, JSON.stringify({ jobs: [null] }));
  await assert.rejects(f.run({ apply: true }), /invalid_inventory/);
  await fs.writeFile(dataPaths(f.env).connectorOutbox, JSON.stringify({ jobs: [] }));
  const elsewhere = path.join(f.home, "elsewhere");
  await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, path.join(f.dir, "retained"));
  await assert.rejects(f.run({ apply: true }), /unsafe_directory/);
  await fs.access(path.join(f.dir, `${orphan.id}.json`));
});

test("retention cursor progresses past pinned journals", async t => {
  const f = await fixture(t);
  const journals = await Promise.all(["one", "two", "three"].map(name => f.journal(name)));
  journals.sort((a, b) => a.id.localeCompare(b.id));
  await f.repository.save(f.thread.id, [{ id: journals[0].messageId }]);
  const first = await f.run({ maxItems: 1 });
  assert.deepEqual(first.eligible, []);
  assert.equal(first.nextCursor, journals[0].id);
  const second = await f.run({ maxItems: 1, afterId: first.nextCursor });
  assert.deepEqual(second.eligible, [journals[1].id]);
});

test("cleanup waits for an in-flight delivery mutation and sees its committed reference", async t => {
  const f = await fixture(t), orphan = await f.journal("concurrent-job");
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const writer = withConnectorOutboxMutation(f.env, async () => {
    entered(); await gate;
    return ensureConnectorOutboxJob({ connector: "whatsapp", threadId: f.thread.id, tenantId: "admin",
      sourceMessageId: orphan.messageId, sourceEventId: orphan.messageId }, f.env);
  });
  await ready;
  const cleanup = f.run({ apply: true });
  release();
  const { job } = await writer;
  assert.deepEqual((await cleanup).quarantined, []);
  assert.equal((await claimConnectorOutboxJob(job.id, { claimant: "fixture" }, f.env)).acquired, true);
});

test("unsupported backends and unsafe retention bounds are refused", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ env: { ...f.env, ORKESTR_CONNECTOR_OUTBOX_STORE: "postgres" } }), /distributed_backend_unsupported/);
  for (const options of [{ minAgeMs: 0 }, { maxItems: 0 }, { maxItems: 1001 }, { afterId: "../unsafe" }]) {
    await assert.rejects(f.run(options), /invalid_bounds/);
  }
});

test("operator CLI defaults to report and requires exact apply confirmation", async t => {
  const f = await fixture(t), journal = await f.journal("cli-candidate");
  const script = new URL("../scripts/outbound-staging-retention.mjs", import.meta.url).pathname;
  const args = [script, "--thread", f.thread.id, "--owner", "admin"];
  const env = { PATH: process.env.PATH, ...f.env };
  const report = spawnSync(process.execPath, args, { env, encoding: "utf8" });
  assert.equal(report.status, 0, report.stderr);
  assert.deepEqual(JSON.parse(report.stdout).eligible, [journal.id]);
  assert.equal(JSON.parse(report.stdout).dryRun, true);
  const denied = spawnSync(process.execPath, [...args, "--apply"], { env, encoding: "utf8" });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /exact_thread_confirmation_required/);
  await fs.access(path.join(f.dir, `${journal.id}.json`));
});
