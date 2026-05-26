import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("release deploy script exposes versioned install, status, and rollback", async () => {
  const script = await fs.readFile("scripts/deploy-git-release.sh", "utf8");
  const manifest = await fs.readFile("scripts/release-manifest.mjs", "utf8");
  const { stdout } = await execFileAsync("bash", ["scripts/deploy-git-release.sh", "--help"]);

  await execFileAsync("bash", ["-n", "scripts/deploy-git-release.sh"]);
  await execFileAsync("node", ["--check", "scripts/release-manifest.mjs"]);
  await execFileAsync("bash", ["scripts/deploy-git-release.sh", "--check-only"]);

  assert.match(stdout, /install \[--ref REF\]/);
  assert.match(stdout, /--allow-untagged\|--require-tagged/);
  assert.match(stdout, /rollback \[--to RELEASE_ID\]/);
  assert.match(script, /ORKESTR_RELEASES_DIR/);
  assert.match(script, /ORKESTR_CURRENT_LINK/);
  assert.match(script, /ORKESTR_DEPLOY_HISTORY/);
  assert.match(script, /release-manifest\.json/);
  assert.match(script, /bash scripts\/install-runtime-deps\.sh/);
  assert.match(script, /npm --prefix "\$release_dir" run build:runtime/);
  assert.match(script, /npm --prefix "\$release_dir" run smoke/);
  assert.match(script, /backup_state/);
  assert.match(script, /health_check/);
  assert.match(script, /ORKESTR_DEPLOY_TAGS_ONLY/);
  assert.match(script, /tags_only_arg/);
  assert.match(script, /--allow-untagged\|--allow-untagged-releases/);
  assert.match(script, /--require-tagged\|--require-tagged-releases/);
  assert.match(script, /worktree add --detach/);
  assert.match(script, /LC_ALL=C tr -c 'A-Za-z0-9\._\+-' '-'/);
  assert.match(manifest, /schemaVersion/);
  assert.match(manifest, /compatibility/);
});

test("release manifest generator records git and component metadata", async () => {
  const output = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-release-manifest-")), "release.json");
  await execFileAsync("node", [
    "scripts/release-manifest.mjs",
    "--output",
    output,
    "--ref",
    "v0.1.7",
    "--channel",
    "production",
    "--release-id",
    "v0.1.7-test",
    "--repo",
    "https://github.com/otcan/orkestr.git",
    "--commit",
    "f0c1538c3596acae8d7535c29a6c1fe90e53c64a",
    "--tag",
    "v0.1.7",
    "--describe",
    "v0.1.7-0-gf0c1538",
  ]);

  const manifest = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.releaseId, "v0.1.7-test");
  assert.equal(manifest.channel, "production");
  assert.equal(manifest.source.requestedRef, "v0.1.7");
  assert.equal(manifest.git.commit, "f0c1538c3596acae8d7535c29a6c1fe90e53c64a");
  assert.equal(manifest.git.tag, "v0.1.7");
  assert.equal(manifest.components.orkestr.commit, "f0c1538c3596acae8d7535c29a6c1fe90e53c64a");
  assert.equal(manifest.compatibility.stateSchema, 1);
});
