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

test("state backups prune to at most three archives", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-state-backup-retention-"));
  const home = path.join(root, "home");
  const backupDir = path.join(root, "backups");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_DEPLOY_BACKUP_DIR: backupDir,
    ORKESTR_DEPLOY_BACKUP_KEEP: "3",
  };
  await fs.mkdir(path.join(home, "config"), { recursive: true });

  for (let index = 0; index < 5; index += 1) {
    await fs.writeFile(path.join(home, "config", "settings.json"), JSON.stringify({ index }), "utf8");
    await createStateBackup({ label: `setup-${index}` }, env);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const status = await stateBackupStatus(env);
  const files = await fs.readdir(backupDir);

  assert.equal(status.retention.keep, 3);
  assert.equal(status.backupCount, 3);
  assert.equal(files.filter((file) => file.endsWith(".tar.gz")).length, 3);
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

test("failed or unverifiable UI backup preserves every completed recovery point", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-ui-backup-preserve-"));
  const home = path.join(root, "state"), backupDir = path.join(root, "backups"), bin = path.join(root, "bin");
  const env = { ORKESTR_HOME: home, ORKESTR_DEPLOY_BACKUP_DIR: backupDir };
  const originalPath = process.env.PATH;
  await fs.mkdir(home);
  await fs.mkdir(bin);
  await fs.writeFile(path.join(home, "fixture"), "synthetic recovery data");
  try {
    const originals = new Map();
    for (let i = 0; i < 3; i++) {
      const result = await createStateBackup({ label: "synthetic" }, env);
      assert.equal((await fs.stat(result.backup.path)).mode & 0o777, 0o600);
      originals.set(result.backup.name, await fs.readFile(result.backup.path));
    }
    process.env.PATH = bin + path.delimiter + originalPath;
    await fs.writeFile(path.join(bin, "tar"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    await assert.rejects(createStateBackup({}, env));
    await fs.writeFile(path.join(bin, "tar"), '#!/bin/sh\nif [ "$3" = -czf ]; then printf broken > "$4"; exit 0; fi\nexec /usr/bin/tar "$@"\n', { mode: 0o755 });
    await assert.rejects(createStateBackup({}, env), /verification_or_publication_failed/);
    assert.deepEqual((await fs.readdir(backupDir)).sort(), [...originals.keys()].sort());
    for (const [name, bytes] of originals) assert.deepEqual(await fs.readFile(path.join(backupDir, name)), bytes);
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("UI retention has a minimum of two and leaves unrelated or symlink archives alone", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-ui-backup-minimum-"));
  const home = path.join(root, "state"), backupDir = path.join(root, "backups");
  const env = { ORKESTR_HOME: home, ORKESTR_DEPLOY_BACKUP_DIR: backupDir, ORKESTR_DEPLOY_BACKUP_KEEP: "1" };
  await fs.mkdir(home);
  await fs.mkdir(backupDir);
  const unrelated = path.join(backupDir, "unrelated.tar.gz");
  await fs.writeFile(unrelated, "preserved unrelated file");
  try {
    for (let i = 0; i < 4; i++) await createStateBackup({}, env);
    const status = await stateBackupStatus(env);
    assert.equal(status.retention.keep, 2);
    assert.equal(status.backupCount, 2);
    const link = path.join(backupDir, "external-state.tar.gz");
    await fs.symlink(status.latestBackup.path, link);
    assert.equal((await stateBackupStatus(env)).backupCount, 2);
    assert.equal(await fs.readFile(unrelated, "utf8"), "preserved unrelated file");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
