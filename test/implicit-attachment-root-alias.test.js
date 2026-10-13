import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveThreadAttachments } from "../packages/core/src/thread-attachments.js";

// Synthetic files only. An allowed root (thread workspace, upload folder,
// configured admin root) that is a symlink into internal Orkestr data must not
// make that internal data attachable from message text.
async function fixture(t, { homeViaSymlink = false } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-root-alias-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const realHome = path.join(base, "real-home");
  const home = homeViaSymlink ? path.join(base, "home-link") : realHome;
  const internalDir = path.join(realHome, "users", "admin", "store");
  const stagingDir = path.join(realHome, "outbound-attachment-staging", "c".repeat(64));
  for (const dir of [internalDir, stagingDir, path.join(realHome, "worktrees"), path.join(realHome, "uploads")]) await fs.mkdir(dir, { recursive: true });
  if (homeViaSymlink) await fs.symlink(realHome, home);
  const files = { db: path.join(internalDir, "audit.sqlite"), staging: path.join(stagingDir, "stg_fixture.json") };
  for (const file of Object.values(files)) await fs.writeFile(file, "synthetic fixture");
  // Aliases: the thread workspace and the thread upload folder are symlinks into internal data.
  const workspaceAlias = path.join(realHome, "worktrees", "thread-a");
  const uploadAlias = path.join(realHome, "uploads", "thread-a");
  await fs.symlink(stagingDir, workspaceAlias);
  await fs.symlink(internalDir, uploadAlias);
  // A configured admin root outside the data directory that aliases internal data.
  const configuredAlias = path.join(base, "configured-root");
  await fs.symlink(internalDir, configuredAlias);
  const viaHome = (file) => file.replace(realHome, home);
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_ADMIN_THREAD_ATTACHMENT_ALLOWED_ROOTS: configuredAlias };
  const thread = { id: "thread-a", ownerUserId: "admin", cwd: viaHome(workspaceAlias), workspace: viaHome(workspaceAlias) };
  return { env, thread, files, viaHome, aliases: { workspaceAlias: viaHome(workspaceAlias), uploadAlias: viaHome(uploadAlias), configuredAlias } };
}

for (const homeViaSymlink of [false, true]) {
  const label = homeViaSymlink ? " (ORKESTR_HOME is a symlink)" : "";
  test(`an allowed-root alias into internal data does not exempt it${label}`, async (t) => {
    const { env, thread, files, viaHome, aliases } = await fixture(t, { homeViaSymlink });
    const targets = [
      files.db, files.staging, viaHome(files.db), viaHome(files.staging),
      path.join(aliases.workspaceAlias, path.basename(files.staging)),
      path.join(aliases.uploadAlias, path.basename(files.db)),
      path.join(aliases.configuredAlias, path.basename(files.db)),
    ];
    for (const target of targets) {
      for (const text of [`See [audit store](${target})`, `See [record](file://${target})`, `Evidence: ${target}`]) {
        const result = await resolveThreadAttachments({ thread, text, env });
        assert.equal(result.attachments.length, 0, `${target.replace(path.dirname(path.dirname(target)), "…")}: ${text.slice(0, 22)}`);
      }
    }
  });
}
