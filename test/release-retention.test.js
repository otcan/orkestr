import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function createRelease(releasesDir, name, modifiedSeconds, { complete = true, ready = true, requiresReady = false } = {}) {
  const releaseDir = path.join(releasesDir, name);
  await fs.mkdir(releaseDir, { recursive: true });
  if (complete) {
    await fs.writeFile(path.join(releaseDir, "release-manifest.json"), "{}\n", "utf8");
  }
  if (requiresReady) {
    const scriptsDir = path.join(releaseDir, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, "deploy-git-release.sh"), "ready=.orkestr-release-ready\n", "utf8");
    if (ready) {
      await fs.writeFile(path.join(releaseDir, ".orkestr-release-ready"), "ready\n", "utf8");
    }
  }
  const modified = new Date(modifiedSeconds * 1000);
  await fs.utimes(releaseDir, modified, modified);
  return releaseDir;
}

test("release retention preserves the active release and removes incomplete or stale releases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-release-retention-"));
  const releasesDir = path.join(root, "releases");
  const currentLink = path.join(root, "current");
  await fs.mkdir(releasesDir);

  const active = await createRelease(releasesDir, "active-old", 10);
  await createRelease(releasesDir, "stale", 20);
  await createRelease(releasesDir, "recent", 30);
  await createRelease(releasesDir, "newest", 40);
  await createRelease(releasesDir, "failed-partial", 50, { complete: false });
  await createRelease(releasesDir, "manifest-before-prune", 60, { requiresReady: true, ready: false });
  await fs.symlink(active, currentLink);

  await execFileAsync("bash", [
    "scripts/prune-release-directories.sh",
    "--releases-dir",
    releasesDir,
    "--current-link",
    currentLink,
    "--keep",
    "3",
  ]);

  const retained = (await fs.readdir(releasesDir)).sort();
  assert.deepEqual(retained, ["active-old", "newest", "recent"]);
  assert.equal(await fs.readlink(currentLink), active);
});

test("release retention rejects counts outside the product-wide maximum", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-release-retention-limit-"));
  await assert.rejects(
    execFileAsync("bash", [
      "scripts/prune-release-directories.sh",
      "--releases-dir",
      path.join(root, "releases"),
      "--current-link",
      path.join(root, "current"),
      "--keep",
      "4",
    ]),
    (error) => {
      assert.match(error.stderr, /integer from 1 to 3/);
      return true;
    },
  );
});

test("release retention counts a live runtime release inside the maximum", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-release-retention-live-"));
  const releasesDir = path.join(root, "releases");
  const currentLink = path.join(root, "current");
  await fs.mkdir(releasesDir);

  const liveRuntime = await createRelease(releasesDir, "live-runtime-old", 10);
  await createRelease(releasesDir, "stale", 20);
  const recent = await createRelease(releasesDir, "recent", 30);
  const active = await createRelease(releasesDir, "active", 40);
  await fs.symlink(active, currentLink);

  await execFileAsync("bash", [
    "scripts/prune-release-directories.sh",
    "--releases-dir",
    releasesDir,
    "--current-link",
    currentLink,
    "--keep",
    "3",
    "--preserve",
    liveRuntime,
  ]);

  const retained = (await fs.readdir(releasesDir)).sort();
  assert.deepEqual(retained, ["active", "live-runtime-old", path.basename(recent)]);
});
