import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("VPS deploy pipeline is generic and host-native", async () => {
  const workflow = await fs.readFile(".github/workflows/deploy-vps.yml", "utf8");
  const script = await fs.readFile("scripts/deploy-vps.sh", "utf8");
  const docs = await fs.readFile("docs/framework-deployment.md", "utf8");
  const readme = await fs.readFile("README.md", "utf8");

  await execFileAsync("bash", ["-n", "scripts/deploy-vps.sh"]);
  await execFileAsync("bash", ["scripts/deploy-vps.sh", "--check-only"]);

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \["CI"\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /tailscale\/github-action@v4/);
  assert.match(workflow, /scripts\/deploy-vps\.sh/);
  assert.match(workflow, /ORKESTR_DEPLOY_ENABLED/);
  assert.match(workflow, /ORKESTR_DEPLOY_HOST/);
  assert.match(workflow, /ORKESTR_DEPLOY_SSH_KEY/);
  assert.match(script, /ORKESTR_GIT_REF/);
  assert.match(script, /systemctl is-active --quiet/);
  assert.match(docs, /Continuous VPS Deploys/);
  assert.match(readme, /Continuous VPS Deploys/);
  assert.doesNotMatch(workflow + script + docs + readme, /orkestr-vps|tail25663|docker exec orkestr/);
});
