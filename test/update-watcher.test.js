import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("host update watcher replaces external VPS deploy automation", async () => {
  const watcher = await fs.readFile("scripts/update-watch.sh", "utf8");
  const install = await fs.readFile("scripts/install.sh", "utf8");
  const docs = await fs.readFile("docs/framework-deployment.md", "utf8");
  const readme = await fs.readFile("README.md", "utf8");

  await execFileAsync("bash", ["-n", "scripts/update-watch.sh"]);
  await execFileAsync("bash", ["scripts/update-watch.sh", "--check-only"]);

  await assert.rejects(fs.stat(".github/workflows/deploy-vps.yml"));
  await assert.rejects(fs.stat("scripts/deploy-vps.sh"));

  assert.match(watcher, /ORKESTR_UPDATE_REF/);
  assert.match(watcher, /ORKESTR_RELEASE_DEPLOY/);
  assert.match(watcher, /deploy-git-release\.sh/);
  assert.match(watcher, /git fetch --prune origin/);
  assert.match(watcher, /bash scripts\/install-runtime-deps\.sh/);
  assert.match(watcher, /npm run build:runtime/);
  assert.match(watcher, /npm prune --omit=dev/);
  assert.match(watcher, /ORKESTR_RESET_ON_UPDATE/);
  assert.match(watcher, /reset-vps-state\.sh/);
  assert.match(watcher, /systemctl stop "\$\{service_name\}\.service"/);
  assert.match(watcher, /systemctl restart "\$\{service_name\}\.service"/);
  assert.match(watcher, /Refusing to update/);
  assert.match(install, /\$\{service_name\}\.timer/);
  assert.match(install, /\/usr\/local\/bin\/orkestr-deploy/);
  assert.match(install, /update\)/);
  assert.match(install, /ORKESTR_CURRENT_LINK/);
  assert.match(install, /--track-main/);
  assert.match(install, /ORKESTR_DEPLOY_TAGS_ONLY/);
  assert.match(docs, /On-Box Update Watcher/);
  assert.match(docs, /Versioned Git Releases/);
  assert.match(docs, /main-<short-commit>/);
  assert.match(docs, /--track-main/);
  assert.match(docs, /orkestr update status/);
  assert.match(docs, /orkestr update --release/);
  assert.match(readme, /On-Box Update Watcher/);
  assert.match(readme, /Versioned Git Releases/);
  assert.match(readme, /main-<short-commit>/);
  assert.match(readme, /--track-main/);
  assert.match(readme, /orkestr update status/);
  assert.match(readme, /orkestr update --release/);
  assert.doesNotMatch(watcher + install + docs + readme, /deploy-vps|GitHub Actions/);
});
