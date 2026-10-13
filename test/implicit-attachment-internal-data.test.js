import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveThreadAttachments } from "../packages/core/src/thread-attachments.js";

// Incident shape: an admin audit report cites internal Orkestr data files as
// evidence with descriptive Markdown labels. Those links must never become
// attachments; deliberate outputs and explicit attachments keep working.
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-internal-data-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const workspace = path.join(home, "worktrees", "thread-a"); // thread workspace inside ORKESTR_HOME
  const uploads = path.join(home, "uploads", "thread-a");
  const outbound = path.join(home, "whatsapp-bridge", "outbound-media");
  for (const dir of [workspace, uploads, outbound, path.join(home, "users", "admin")]) await fs.mkdir(dir, { recursive: true });
  const files = {
    outboxDb: path.join(home, "connector-outbox.sqlite"),
    messagesDb: path.join(home, "thread-messages.sqlite"),
    wal: path.join(home, "thread-messages.sqlite-wal"),
    events: path.join(home, "events.jsonl"),
    state: path.join(home, "whatsapp.json"),
    nestedDb: path.join(home, "users", "admin", "store.db"),
    workspaceReport: path.join(workspace, "audit-report.md"),
    upload: path.join(uploads, "invoice.pdf"),
    outboundMedia: path.join(outbound, "chart.png"),
  };
  for (const file of Object.values(files)) await fs.writeFile(file, "synthetic fixture");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  files.outsideReport = path.join(outside, "report.csv");
  await fs.writeFile(files.outsideReport, "a,b");
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  const thread = { id: "thread-a", ownerUserId: "admin", cwd: workspace, workspace };
  return { env, thread, files };
}

test("descriptive Markdown links to internal Orkestr data never become attachments", async (t) => {
  const { env, thread, files } = await fixture(t);
  const internal = [files.outboxDb, files.messagesDb, files.wal, files.events, files.state, files.nestedDb];
  for (const target of internal) {
    for (const text of [`See [connector outbox](${target})`, `See [delivery evidence](file://${target})`, `Evidence: ${target}`]) {
      const result = await resolveThreadAttachments({ thread, text, env });
      assert.equal(result.attachments.length, 0, `${path.basename(target)} via: ${text.slice(0, 30)}`);
    }
  }
  const report = `Audit\n- [connector outbox](${files.outboxDb})\n- [thread messages](${files.messagesDb})\n- [delivery events](${files.events}:277550)`;
  const result = await resolveThreadAttachments({ thread, text: report, env });
  assert.equal(result.attachments.length, 0);
  assert.ok(result.skipped.some((item) => item.reason === "attachment_internal_data_requires_explicit_selection"));
  assert.equal(result.skipped.some((item) => item.reason === "attachment_path_missing"), false, "not staged as a missing file");
});

test("deliberate outputs and shareable folders still attach from descriptive links", async (t) => {
  const { env, thread, files } = await fixture(t);
  for (const target of [files.workspaceReport, files.upload, files.outboundMedia, files.outsideReport]) {
    const result = await resolveThreadAttachments({ thread, text: `Here is [the report](${target})`, env });
    assert.equal(result.attachments.length, 1, path.basename(target));
  }
});

test("explicit attachments keep the existing owner/path policy", async (t) => {
  const { env, thread, files } = await fixture(t);
  const result = await resolveThreadAttachments({ thread, attachments: [{ path: files.outboxDb }], env });
  assert.equal(result.attachments.length, 1, "explicit selection is unchanged by this rule");
});
