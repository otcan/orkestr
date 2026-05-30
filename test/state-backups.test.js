import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createStateBackup, stateBackupStatus, stateRestorePlan } from "../packages/core/src/state-backups.js";

const execFileAsync = promisify(execFile);

test("state backups create archives, exclude volatile runtime paths, and prepare restore commands", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-state-backup-"));
  const home = path.join(root, "home");
  const backupDir = path.join(root, "backups");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_DEPLOY_BACKUP_DIR: backupDir,
    ORKESTR_SERVICE_NAME: "orkestr-test.service",
  };
  await fs.mkdir(path.join(home, "config"), { recursive: true });
  await fs.mkdir(path.join(home, "tmp"), { recursive: true });
  await fs.writeFile(path.join(home, "config", "settings.json"), JSON.stringify({ ok: true }), "utf8");
  await fs.writeFile(path.join(home, "tmp", "volatile.txt"), "skip", "utf8");

  const before = await stateBackupStatus(env);
  const created = await createStateBackup({ label: "setup" }, env);
  const after = await stateBackupStatus(env);
  const { stdout } = await execFileAsync("tar", ["-tzf", created.backup.path], { timeout: 30_000 });
  const plan = await stateRestorePlan({ backupPath: created.backup.name }, env);

  assert.equal(before.backupCount, 0);
  assert.equal(created.ok, true);
  assert.equal(after.backupCount, 1);
  assert.equal(after.latestBackup.name, created.backup.name);
  assert.match(stdout, /home\/config\/settings\.json/);
  assert.doesNotMatch(stdout, /home\/tmp\/volatile\.txt/);
  assert.equal(plan.ok, true);
  assert.equal(plan.executable, false);
  assert.equal(plan.serviceName, "orkestr-test.service");
  assert.ok(plan.commands.some((command) => command.includes("systemctl stop")));
  assert.ok(plan.commands.some((command) => command.includes("tar -xzf")));
});

test("state restore plans reject backups outside the configured backup directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-state-restore-forbidden-"));
  const env = {
    ORKESTR_HOME: path.join(root, "home"),
    ORKESTR_DEPLOY_BACKUP_DIR: path.join(root, "backups"),
  };
  await fs.mkdir(env.ORKESTR_HOME, { recursive: true });
  await fs.writeFile(path.join(root, "outside.tar.gz"), "not a real backup", "utf8");

  await assert.rejects(
    () => stateRestorePlan({ backupPath: path.join(root, "outside.tar.gz") }, env),
    /backup_path_forbidden/,
  );
});
