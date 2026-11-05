import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { isolatedSmokeBaseEnvironment } from "../scripts/smoke-environment.mjs";

const exec = promisify(execFile);

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-backup-retention-"));
  const home = path.join(root, "state"), backups = path.join(root, "backups");
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, "fixture.txt"), "synthetic recovery data");
  const env = { ...isolatedSmokeBaseEnvironment(), ORKESTR_ENV_FILE: path.join(root, "absent.env"),
    ORKESTR_HOME: home, ORKESTR_DEPLOY_ROOT: path.join(root, "deploy"),
    ORKESTR_DEPLOY_LOCK_FILE: path.join(root, "deploy.lock"), ORKESTR_DEPLOY_BACKUP_DIR: backups,
    ORKESTR_DEPLOY_BACKUP_KEEP: "3", ORKESTR_DEPLOY_BACKUP_COMPRESSOR: "gzip" };
  const backup = async (extra = {}) => (await exec("bash", ["scripts/deploy-git-release.sh", "backup"],
    { env: { ...env, ...extra } })).stdout.trim();
  try { await run({ root, home, backups, env, backup }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("failed replacements preserve all three completed recovery points", async () => {
  await fixture(async ({ root, home, backups, env, backup }) => {
    const originals = new Map();
    for (let i = 0; i < 3; i++) {
      const file = await backup();
      originals.set(path.basename(file), await fs.readFile(file));
    }
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "gzip"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    await assert.rejects(backup({ PATH: bin + path.delimiter + env.PATH }));
    await fs.writeFile(path.join(home, "threads.sqlite"), "malformed SQLite fixture");
    await assert.rejects(backup());
    assert.deepEqual((await fs.readdir(backups)).sort(), [...originals.keys()].sort());
    for (const [name, bytes] of originals) assert.deepEqual(await fs.readFile(path.join(backups, name)), bytes);
  });
});

test("successful publication keeps at least two and ignores unrelated archives", async () => {
  await fixture(async ({ backups, backup }) => {
    await fs.mkdir(backups);
    const unrelated = path.join(backups, "unrelated.tar.gz");
    await fs.writeFile(unrelated, "not an Orkestr recovery archive");
    for (let i = 0; i < 4; i++) await backup({ ORKESTR_DEPLOY_BACKUP_KEEP: "1" });
    const files = await fs.readdir(backups);
    assert.equal(files.filter(name => name.endsWith("-state.tar.gz")).length, 2);
    assert.equal(await fs.readFile(unrelated, "utf8"), "not an Orkestr recovery archive");
    assert.equal(files.some(name => name.endsWith(".part")), false);
  });
});
