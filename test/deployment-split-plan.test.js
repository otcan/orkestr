import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("deployment split plan emits isolated managed and OSS profiles", async () => {
  const { stdout } = await execFileAsync("node", [
    "scripts/deployment-split-plan.mjs",
    "--json",
    "--root",
    "/srv/orkestr",
    "--domain",
    "example.test",
    "--managed-repo",
    "git@example.test:private/orkestr-managed.git",
  ]);
  const plan = JSON.parse(stdout);
  assert.equal(plan.ok, true);
  assert.equal(plan.profiles.length, 2);
  const managed = plan.profiles.find((item) => item.id === "managed");
  const oss = plan.profiles.find((item) => item.id === "oss");
  assert.equal(managed.env.ORKESTR_DISTRIBUTION, "managed");
  assert.equal(managed.env.ORKESTR_DEPLOYMENT_TRACK, "managed-production");
  assert.equal(managed.env.ORKESTR_REPO_ROLE, "managed");
  assert.equal(oss.env.ORKESTR_DISTRIBUTION, "oss");
  assert.equal(oss.env.ORKESTR_DEPLOYMENT_TRACK, "oss-production");
  assert.equal(oss.env.ORKESTR_REPO_ROLE, "oss");
  assert.notEqual(managed.env.ORKESTR_HOME, oss.env.ORKESTR_HOME);
  assert.notEqual(managed.env.ORKESTR_SERVICE_NAME, oss.env.ORKESTR_SERVICE_NAME);
  assert.notEqual(managed.env.ORKESTR_PORT, oss.env.ORKESTR_PORT);
  assert.match(plan.verification.join("\n"), /api\/version/);
});

test("deployment split shell output does not include secret values", async () => {
  const { stdout } = await execFileAsync("node", [
    "scripts/deployment-split-plan.mjs",
    "--shell",
    "--domain",
    "example.test",
  ]);
  assert.match(stdout, /ORKESTR_DISTRIBUTION='managed'/);
  assert.match(stdout, /ORKESTR_DISTRIBUTION='oss'/);
  assert.doesNotMatch(stdout, /TOKEN|SECRET|PASSWORD|API_KEY/);
});
