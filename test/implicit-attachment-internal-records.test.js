import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveThreadAttachments } from "../packages/core/src/thread-attachments.js";

// Synthetic files only. Internal staging records and logs nested inside
// ORKESTR_HOME must not become attachments from links in message text.
async function fixture(t, { homeViaSymlink = false } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-internal-records-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const realHome = path.join(base, "real-home");
  const home = homeViaSymlink ? path.join(base, "home-link") : realHome;
  await fs.mkdir(realHome, { recursive: true });
  if (homeViaSymlink) await fs.symlink(realHome, home);
  const workspace = path.join(realHome, "worktrees", "thread-a");
  const dirs = {
    staging: path.join(realHome, "outbound-attachment-staging", "a".repeat(64)),
    observability: path.join(realHome, "observability"),
    userLogs: path.join(realHome, "users", "admin", "logs"),
    uploads: path.join(realHome, "uploads", "thread-a"),
    outbound: path.join(realHome, "whatsapp-bridge", "outbound-media"),
  };
  for (const dir of [workspace, ...Object.values(dirs)]) await fs.mkdir(dir, { recursive: true });
  const files = {
    topLevelDb: path.join(realHome, "connector-outbox.sqlite"),
    stagingRecord: path.join(dirs.staging, `stg_${"b".repeat(64)}.json`),
    requestLog: path.join(dirs.observability, "requests-2026-10-13.jsonl"),
    healthLog: path.join(dirs.observability, "health-2026-10-13.json"),
    serverLog: path.join(dirs.userLogs, "server.log"),
    rotatedLog: path.join(dirs.userLogs, "server.log.1"),
    gzLog: path.join(dirs.userLogs, "server.log.gz"),
    workspaceLog: path.join(workspace, "build.log"),
    workspaceReport: path.join(workspace, "report.md"),
    uploadLog: path.join(dirs.uploads, "customer-export.log"),
    outboundMedia: path.join(dirs.outbound, "chart.png"),
  };
  for (const file of Object.values(files)) await fs.writeFile(file, "synthetic fixture");
  const aliasToStaging = path.join(workspace, "evidence.json");
  await fs.symlink(files.stagingRecord, aliasToStaging);
  const viaHome = (file) => file.replace(realHome, home);
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin" };
  const thread = { id: "thread-a", ownerUserId: "admin", cwd: viaHome(workspace), workspace: viaHome(workspace) };
  return { env, thread, files, aliasToStaging, viaHome };
}

const forms = (target) => [`See [staging intent](${target})`, `See [request log](file://${target})`, `Evidence: ${target}`];

for (const homeViaSymlink of [false, true]) {
  const label = homeViaSymlink ? " (ORKESTR_HOME is a symlink)" : "";
  test(`internal staging records and logs never attach from message text${label}`, async (t) => {
    const { env, thread, files, aliasToStaging, viaHome } = await fixture(t, { homeViaSymlink });
    const internal = [files.topLevelDb, files.stagingRecord, files.requestLog, files.healthLog, files.serverLog, files.rotatedLog, files.gzLog];
    for (const target of [...internal.map(viaHome), ...internal, aliasToStaging]) {
      for (const text of forms(target)) {
        const result = await resolveThreadAttachments({ thread, text, env });
        assert.equal(result.attachments.length, 0, `${path.basename(target)}: ${text.slice(0, 28)}`);
      }
    }
  });

  test(`authorized outputs, uploads and outbound media still attach${label}`, async (t) => {
    const { env, thread, files, viaHome } = await fixture(t, { homeViaSymlink });
    for (const target of [files.workspaceLog, files.workspaceReport, files.uploadLog, files.outboundMedia].map(viaHome)) {
      const result = await resolveThreadAttachments({ thread, text: `Here is [the output](${target})`, env });
      assert.equal(result.attachments.length, 1, path.basename(target));
    }
  });

  test(`explicit attachments are unchanged${label}`, async (t) => {
    const { env, thread, files, viaHome } = await fixture(t, { homeViaSymlink });
    const result = await resolveThreadAttachments({ thread, attachments: [{ path: viaHome(files.serverLog) }], env });
    assert.equal(result.attachments.length, 1);
  });
}
